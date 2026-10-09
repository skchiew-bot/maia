import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseThrottle, parseTranscriptLine, Sidecar, TranscriptTailer, UsageAggregator } from '../src';

const asst = (id: string, block: string, usage: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'assistant',
    uuid: `${id}-${block}`,
    requestId: `req_${id}`,
    timestamp: '2026-10-09T02:00:00.000Z',
    isSidechain: false,
    message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: block }], usage },
    ...extra,
  });

const U = { input_tokens: 2, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 300 } };

describe('UsageAggregator', () => {
  it('counts each message once even though blocks repeat the usage', () => {
    const a = new UsageAggregator();
    for (const b of ['thinking', 'text', 'tool_use']) a.add(parseTranscriptLine(asst('msg_1', b, U))!);
    a.add(parseTranscriptLine(asst('msg_2', 'text', { input_tokens: 1, output_tokens: 10, cache_read_input_tokens: 1300, cache_creation_input_tokens: 50 }))!);
    a.add(parseTranscriptLine(asst('msg_3', 'text', { input_tokens: 5, output_tokens: 7 }, { isSidechain: true }))!);
    const [b] = a.drain();
    expect(b).toMatchObject({ model: 'claude-opus-5-5', inputTokens: 8, outputTokens: 117, cacheReadTokens: 2300, cacheWrite5mTokens: 50, cacheWrite1hTokens: 300 });
    expect(b!.messageIds.sort()).toEqual(['msg_1', 'msg_2', 'msg_3']);
    expect(b!.contextTokens).toBe(1 + 1300 + 50); // latest main-chain message, not the sidechain one
    expect(a.drain()).toEqual([]);
  });

  it('adds only the delta when a later line for the same message reports more tokens', () => {
    const a = new UsageAggregator();
    a.add(parseTranscriptLine(asst('m', 'text', { input_tokens: 2, output_tokens: 5 }))!);
    a.add(parseTranscriptLine(asst('m', 'tool_use', { input_tokens: 2, output_tokens: 50 }))!);
    expect(a.drain()[0]).toMatchObject({ inputTokens: 2, outputTokens: 50 });
  });
});

describe('TranscriptTailer', () => {
  it('handles partial lines and truncation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-tail-'));
    const f = join(dir, 't.jsonl');
    const lines: string[] = [];
    const t = new TranscriptTailer(f, (l) => lines.push(l));
    expect(t.poll()).toBe(0); // file missing
    writeFileSync(f, '{"a":1}\n{"b":');
    t.poll();
    expect(lines).toEqual(['{"a":1}']);
    expect(t.committedOffset).toBe(8);
    appendFileSync(f, '2}\n');
    t.poll();
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    writeFileSync(f, '{"c":3}\n'); // truncated + rewritten
    t.poll();
    expect(lines.at(-1)).toBe('{"c":3}');
  });
});

describe('parseThrottle', () => {
  const now = new Date('2026-10-09T10:00:00');
  it('parses the known usage-limit variants', () => {
    expect(parseThrottle('Claude AI usage limit reached|1791522000', now)!.resetAt).toBe(new Date(1791522000 * 1000).toISOString());
    expect(parseThrottle('5-hour limit reached ∙ resets 3pm', now)!.resetAt).toBe(new Date('2026-10-09T15:00:00').toISOString());
    expect(parseThrottle('Usage limit reached. Your limit resets in 2h', now)!.resetAt).toBe(new Date(now.getTime() + 7200_000).toISOString());
    expect(parseThrottle('weekly limit reached', now)).toEqual({ resetAt: null });
    expect(parseThrottle('all good here', now)).toBeNull();
  });
});

describe('Sidecar end to end', () => {
  let server: Server | null = null;
  afterEach(() => server?.close());

  it('heartbeats, ships deduped usage, reports throttles and the process exit', async () => {
    const posts: { path: string; body: Record<string, unknown> }[] = [];
    const url = await new Promise<string>((resolve) => {
      server = createServer((req, res) => {
        let b = '';
        req.on('data', (c) => (b += c));
        req.on('end', () => {
          posts.push({ path: req.url!, body: JSON.parse(b) });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        });
      }).listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`));
    });
    const dir = mkdtempSync(join(tmpdir(), 'aoc-sc-'));
    const transcript = join(dir, 'session.jsonl');
    writeFileSync(transcript, [asst('msg_1', 'thinking', U), asst('msg_1', 'tool_use', U)].join('\n') + '\n');
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
    const sc = new Sidecar({ sessionId: 'ses_X', pid: child.pid!, transcriptPath: transcript, daemonUrl: url, token: 'tok', stateDir: join(dir, 'state'), intervalMs: 100, flushEveryMs: 100 });
    await sc.start();
    appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { id: 'msg_lim', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Claude AI usage limit reached|1791522000' }] } }) + '\n');
    await new Promise((r) => setTimeout(r, 400));
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 600));
    const paths = posts.map((p) => p.path);
    expect(paths).toContain('/ingest/heartbeat');
    expect(paths).toContain('/ingest/throttle');
    expect(paths.at(-1)).toBe('/ingest/process');
    const usage = posts.filter((p) => p.path === '/ingest/usage');
    const totalOut = usage.flatMap((p) => p.body.batches as { outputTokens: number }[]).reduce((n, b) => n + b.outputTokens, 0);
    expect(totalOut).toBe(100); // msg_1 counted once
    expect(posts.find((p) => p.path === '/ingest/throttle')!.body.resetAt).toBe(new Date(1791522000 * 1000).toISOString());

    // restart with the same state dir must not double count
    const sc2 = new Sidecar({ sessionId: 'ses_X', pid: 999999, transcriptPath: transcript, daemonUrl: url, token: 'tok', stateDir: join(dir, 'state'), isAlive: () => false });
    posts.length = 0;
    await sc2.exit();
    expect(posts.filter((p) => p.path === '/ingest/usage')).toHaveLength(0);
  });
});
