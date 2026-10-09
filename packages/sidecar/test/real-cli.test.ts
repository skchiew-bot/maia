/**
 * The sidecar against transcripts Claude Code 2.1.295 really wrote for managed AOC sessions (scrubbed captures in
 * docs/research/fixtures/claude-code/aoc-*): what it ships as usage adds up to what the process itself reported in its
 * `result.modelUsage`, and nothing a healthy session wrote looks like a plan limit.
 */
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { detectThrottle, parseThrottle, Sidecar, textOf } from '../src';

const FIXTURES = fileURLToPath(new URL('../../../docs/research/fixtures/claude-code/', import.meta.url));
const jsonl = (file: string): Record<string, any>[] =>
  readFileSync(FIXTURES + file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

interface Batch {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}
type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** The process's own figures (cumulative for the conversation) from the last `result` line of a turn. */
function reported(streamFile: string): Record<string, Tokens> {
  const result = jsonl(streamFile).findLast((o) => o.type === 'result')!;
  return Object.fromEntries(
    Object.entries(result.modelUsage as Record<string, Record<string, number>>).map(([model, u]) => [
      model,
      {
        input: u.inputTokens!,
        output: u.outputTokens!,
        cacheRead: u.cacheReadInputTokens!,
        cacheWrite: u.cacheCreationInputTokens!,
      },
    ]),
  );
}

describe('the sidecar on real transcripts', () => {
  let server: Server | null = null;
  afterEach(() => server?.close());

  /** Runs the sidecar over a copy of the transcript, as it does when the claude process has exited. */
  async function shippedUsage(transcript: string): Promise<Record<string, Tokens>> {
    const batches: Batch[] = [];
    const url = await new Promise<string>((resolve) => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          if (req.url === '/ingest/usage')
            batches.push(...(JSON.parse(body) as { batches: Batch[] }).batches);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        });
      }).listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(server!.address() as { port: number }).port}`),
      );
    });
    const dir = mkdtempSync(join(tmpdir(), 'aoc-sc-real-'));
    const copy = join(dir, 'session.jsonl');
    copyFileSync(FIXTURES + transcript, copy);
    const sidecar = new Sidecar({
      sessionId: 'ses_X',
      pid: 999999,
      transcriptPath: copy,
      daemonUrl: url,
      token: 'tok',
      stateDir: join(dir, 'state'),
      isAlive: () => false,
    });
    await sidecar.exit();
    const sum: Record<string, Tokens> = {};
    for (const b of batches) {
      const t = (sum[b.model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      t.input += b.inputTokens;
      t.output += b.outputTokens;
      t.cacheRead += b.cacheReadTokens;
      t.cacheWrite += b.cacheWrite5mTokens + b.cacheWrite1hTokens;
    }
    return sum;
  }

  it('a happy turn: the usage it ships equals result.modelUsage (assistant lines repeat per content block; counted once per message id)', async () => {
    const shipped = await shippedUsage('aoc-happy.transcript.jsonl');
    expect(shipped).toEqual(reported('aoc-happy.stream-json.jsonl'));
    // The transcript really does repeat message ids, or this would prove nothing about the dedupe.
    const ids = jsonl('aoc-happy.transcript.jsonl')
      .filter((l) => l.type === 'assistant')
      .map((l) => l.message.id as string);
    expect(new Set(ids).size).toBeLessThan(ids.length);
  });

  it('a decision round trip: two invocations of one conversation add up to the resumed turn’s cumulative figures', async () => {
    const shipped = await shippedUsage('aoc-decision.transcript.jsonl');
    expect(shipped).toEqual(reported('aoc-decision.turn-2.stream-json.jsonl'));
    expect(jsonl('aoc-decision.transcript.jsonl').filter((l) => l.type === 'cost-state')).toHaveLength(2);
  });

  it('a nudge: the interrupted turn’s partial usage and the two resumed turns still add up', async () => {
    const shipped = await shippedUsage('aoc-nudge.transcript.jsonl');
    expect(shipped).toEqual(reported('aoc-nudge.turn-3.stream-json.jsonl'));
    expect(jsonl('aoc-nudge.transcript.jsonl').filter((l) => l.type === 'cost-state')).toHaveLength(3);
  });

  it('nothing in a healthy session’s transcript is read as a plan usage limit', () => {
    for (const file of [
      'aoc-happy.transcript.jsonl',
      'aoc-decision.transcript.jsonl',
      'aoc-nudge.transcript.jsonl',
    ]) {
      for (const line of jsonl(file)) {
        expect(detectThrottle(line as never), `${file}: ${line.type}`).toBeNull();
        const text = textOf(line as never);
        if (text) expect(parseThrottle(text), `${file}: ${text.slice(0, 80)}`).toBeNull();
      }
    }
  });
});
