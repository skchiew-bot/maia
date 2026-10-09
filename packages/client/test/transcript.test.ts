import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptLine } from '@aoc/contracts';
import { describe, expect, it } from 'vitest';
import {
  agentIdOfTranscript,
  listSubagentTranscripts,
  parseTranscriptLine,
  readCompleteLines,
  subagentTranscriptDir,
  UsageAggregator,
} from '../src';

const tmp = () => mkdtempSync(join(tmpdir(), 'aoc-transcript-'));

interface UsageSpec {
  input?: number;
  output?: number;
  cacheRead?: number;
  /** cache_creation_input_tokens (total). */
  cacheWrite?: number;
  /** Optional TTL split (cache_creation object). */
  split?: { m5: number; h1: number };
}

/** One API response as Claude Code writes it: one line per content block, each repeating id, requestId and usage. */
function assistant(
  id: string,
  model: string,
  u: UsageSpec,
  o: { timestamp?: string; blocks?: number; sidechain?: boolean } = {},
): string[] {
  const usage: Record<string, unknown> = {
    input_tokens: u.input ?? 0,
    output_tokens: u.output ?? 0,
    cache_read_input_tokens: u.cacheRead ?? 0,
    cache_creation_input_tokens: u.cacheWrite ?? 0,
  };
  if (u.split)
    usage.cache_creation = { ephemeral_5m_input_tokens: u.split.m5, ephemeral_1h_input_tokens: u.split.h1 };
  return Array.from({ length: o.blocks ?? 1 }, (_, i) =>
    JSON.stringify({
      type: 'assistant',
      uuid: `${id}-line-${i}`,
      requestId: `req_${id}`,
      timestamp: o.timestamp ?? '2026-10-09T02:00:00.000Z',
      isSidechain: o.sidechain ?? false,
      message: {
        id,
        role: 'assistant',
        model,
        usage,
        content: [{ type: 'text', text: `block ${i} — ✓ ünïcödé` }],
      },
    }),
  );
}

const userLine = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });

function aggregate(lines: string[], agg = new UsageAggregator()) {
  for (const l of lines) agg.add(parseTranscriptLine(l)!);
  return agg;
}

describe('UsageAggregator', () => {
  it('counts each message once even though blocks repeat the usage, per model', () => {
    const U = { input: 2, output: 100, cacheRead: 1000, cacheWrite: 300, split: { m5: 0, h1: 300 } };
    const a = aggregate([
      ...assistant('msg_1', 'claude-opus-5-5', U, { blocks: 3 }),
      ...assistant('msg_2', 'claude-opus-5-5', { input: 1, output: 10, cacheRead: 1300, cacheWrite: 50 }),
      ...assistant('msg_3', 'claude-opus-5-5', { input: 5, output: 7 }, { sidechain: true }),
      ...assistant('msg_h', 'claude-haiku-5-5', { input: 1, output: 2 }, { sidechain: true }),
    ]);
    const [opus, haiku] = a.drain();
    expect(opus).toMatchObject({
      model: 'claude-opus-5-5',
      inputTokens: 8,
      outputTokens: 117,
      cacheReadTokens: 2300,
      cacheWrite5mTokens: 50,
      cacheWrite1hTokens: 300,
      messageIds: ['msg_1', 'msg_2', 'msg_3'],
    });
    expect(haiku).toMatchObject({
      model: 'claude-haiku-5-5',
      inputTokens: 1,
      outputTokens: 2,
      messageIds: ['msg_h'],
    });
    // The latest main-chain message is the context size, for every batch of the drain (not a sidechain one).
    expect([opus!.contextTokens, haiku!.contextTokens]).toEqual([1 + 1300 + 50, 1 + 1300 + 50]);
    expect(a.sidechainMessages).toBe(2);
    expect(a.drain()).toEqual([]);
  });

  it('adds only the delta when a later line for the same message reports more tokens', () => {
    const a = aggregate([
      ...assistant('m', 'opus', { input: 2, output: 5 }),
      ...assistant('m', 'opus', { input: 2, output: 50 }),
    ]);
    expect(a.drain()[0]).toMatchObject({ inputTokens: 2, outputTokens: 50, messageIds: ['m'] });
  });

  it('skips <synthetic> messages (they neither count nor reset the context size)', () => {
    const a = aggregate([
      ...assistant('msg_1', 'opus', { input: 3, cacheRead: 40 }),
      ...assistant('msg_syn', '<synthetic>', { input: 9, output: 9 }),
    ]);
    expect(a.drain()).toEqual([
      expect.objectContaining({ messageIds: ['msg_1'], inputTokens: 3, contextTokens: 43 }),
    ]);
  });

  it('splits cache writes by TTL, billing an unsplit remainder as 5-minute writes', () => {
    const a = aggregate([
      ...assistant('a', 'm', { cacheWrite: 50, split: { m5: 10, h1: 30 } }),
      ...assistant('b', 'm', { cacheWrite: 25 }),
    ]);
    expect(a.drain()[0]).toMatchObject({ cacheWrite5mTokens: 10 + 10 + 25, cacheWrite1hTokens: 30 });
  });

  it('spans first/last timestamps and falls back to the injected clock for lines without one', () => {
    const a = aggregate([
      ...assistant('a', 'm', { input: 1 }, { timestamp: '2026-10-09T01:00:05.000Z' }),
      ...assistant('b', 'm', { input: 2 }, { timestamp: '2026-10-09T01:00:01.000Z' }),
    ]);
    expect(a.drain()[0]).toMatchObject({
      firstAt: '2026-10-09T01:00:01.000Z',
      lastAt: '2026-10-09T01:00:05.000Z',
    });
    const clocked = new UsageAggregator({ now: () => new Date('2026-10-09T03:00:00.000Z') });
    clocked.add({
      type: 'assistant',
      message: { id: 'x', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } },
    });
    expect(clocked.drain()[0]).toMatchObject({
      firstAt: '2026-10-09T03:00:00.000Z',
      lastAt: '2026-10-09T03:00:00.000Z',
    });
  });

  it('keys on message.id, else requestId, else uuid; ignores lines without any id or usage and junk numbers', () => {
    const a = new UsageAggregator();
    const lines = [
      { type: 'assistant', message: { model: 'm', usage: { input_tokens: 5, output_tokens: 5 } } },
      { type: 'user', message: { id: 'u1', usage: { input_tokens: 5, output_tokens: 5 } } },
      {
        type: 'assistant',
        requestId: 'req_9',
        message: { model: 'm', usage: { input_tokens: 4, output_tokens: 1 } },
      },
      {
        type: 'assistant',
        message: { id: 'x', model: 'm', usage: { input_tokens: -4, output_tokens: Number.NaN } },
      },
      {
        type: 'assistant',
        message: { id: 'y', model: 'm', usage: { input_tokens: 2.9, output_tokens: 'many' } },
      },
    ] as unknown as TranscriptLine[];
    for (const l of lines) a.add(l);
    // 'x' has nothing countable, so it is not reported; fractional counts are floored.
    expect(a.drain()).toEqual([
      expect.objectContaining({ inputTokens: 4 + 2, outputTokens: 1, messageIds: ['req_9', 'y'] }),
    ]);
  });

  it('resumes from a snapshot: messages counted before only add what grew, and the snapshot can be bounded', () => {
    const first = aggregate([
      ...assistant('old', 'opus', { input: 100, output: 10 }),
      ...assistant('a', 'opus', { input: 1 }),
    ]);
    first.drain();
    expect(Object.keys(first.snapshot(1))).toEqual(['a']);
    const next = aggregate(
      [
        ...assistant('old', 'opus', { input: 100, output: 10 }),
        ...assistant('a', 'opus', { input: 1, output: 4 }),
        ...assistant('b', 'opus', { input: 7 }),
      ],
      new UsageAggregator({ counted: first.snapshot() }),
    );
    expect(next.drain()[0]).toMatchObject({ inputTokens: 7, outputTokens: 4, messageIds: ['a', 'b'] });
    // A snapshot read back from disk may hold junk: it counts as nothing counted.
    const junk = new UsageAggregator({ counted: { z: { input: 'x', output: null } } as never });
    junk.add(parseTranscriptLine(assistant('z', 'opus', { input: 2 })[0]!)!);
    expect(junk.drain()[0]).toMatchObject({ inputTokens: 2 });
  });

  it('addRaw parses only lines that can carry usage', () => {
    const a = new UsageAggregator();
    expect(a.addRaw(userLine('a prompt'))).toBe(false);
    expect(
      a.addRaw(JSON.stringify({ type: 'user', message: { role: 'assistant', usage: { input_tokens: 1 } } })),
    ).toBe(false);
    expect(a.addRaw('{"type":"assistant","message":{"usage":')).toBe(false);
    expect(a.addRaw(assistant('m', 'opus', { input: 1 })[0]!)).toBe(true);
    expect(a.pendingMessages).toBe(1);
  });
});

describe('readCompleteLines', () => {
  const read = (path: string, offset: number) => {
    const lines: string[] = [];
    const r = readCompleteLines(path, offset, (l) => lines.push(l));
    return { r, lines };
  };

  it('reads only complete lines and returns the byte offset after them (multi-byte text included)', () => {
    const path = join(tmp(), 't.jsonl');
    const [a] = assistant('msg_A', 'opus', { input: 1 });
    const [b] = assistant('msg_B', 'opus', { input: 2 });
    writeFileSync(path, `${userLine('héllo ✓')}\n\n${a}\n${b}`);
    const first = read(path, 0);
    expect(first.lines).toEqual([userLine('héllo ✓'), a]);
    expect(first.r!.offset).toBe(Buffer.byteLength(`${userLine('héllo ✓')}\n\n${a}\n`));
    expect(first.r!.restarted).toBe(false);

    appendFileSync(path, '\n');
    const second = read(path, first.r!.offset);
    expect(second.lines).toEqual([b]);
    expect(second.r!.offset).toBe(readFileSync(path).length);
  });

  it('handles lines that cross the 1 MiB read chunks, including lines longer than a chunk', () => {
    const path = join(tmp(), 't.jsonl');
    const content: string[] = [];
    for (let i = 0; i < 8; i++) {
      content.push(userLine(`${'é'.repeat(i === 3 ? 1_250_000 : 150_000)}${i}`));
      content.push(...assistant(`msg_${i}`, 'opus', { input: 1, output: 1 }, { blocks: 2 }));
    }
    writeFileSync(path, content.join('\n') + '\n');
    const { r, lines } = read(path, 0);
    expect(lines).toEqual(content);
    expect(r!.offset).toBe(readFileSync(path).length);
  });

  it('starts over when the file shrank below the offset, and is null for a missing file', () => {
    const path = join(tmp(), 't.jsonl');
    writeFileSync(path, '{"a":1}\n');
    const { r, lines } = read(path, 10_000);
    expect(lines).toEqual(['{"a":1}']);
    expect(r).toMatchObject({ offset: 8, size: 8, restarted: true });
    expect(read(join(tmp(), 'missing.jsonl'), 0).r).toBeNull();
  });
});

describe('subagent transcripts', () => {
  it('live in <transcript>/subagents/agent-<id>.jsonl, listed in name order', () => {
    const dir = tmp();
    const transcript = join(dir, 'projects', '-work', '59c4a8a4.jsonl');
    expect(listSubagentTranscripts(transcript)).toEqual([]);
    const sub = subagentTranscriptDir(transcript);
    expect(sub).toBe(join(dir, 'projects', '-work', '59c4a8a4', 'subagents'));
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'agent-b2.jsonl'), '');
    writeFileSync(join(sub, 'agent-a1.jsonl'), '');
    writeFileSync(join(sub, 'agent-a1.meta.json'), '{}');
    expect(listSubagentTranscripts(transcript)).toEqual([
      { agentId: 'a1', file: 'agent-a1.jsonl', path: join(sub, 'agent-a1.jsonl') },
      { agentId: 'b2', file: 'agent-b2.jsonl', path: join(sub, 'agent-b2.jsonl') },
    ]);
    expect(agentIdOfTranscript('/x/subagents/agent-a3e0385ed503597cc.jsonl')).toBe('a3e0385ed503597cc');
  });
});
