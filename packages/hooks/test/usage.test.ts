import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TranscriptLine } from '@aoc/contracts';
import { describe, expect, it } from 'vitest';
import { aggregateUsage, cursorFile, readObservedUsage, readTranscriptUsage } from '../src';
import { assistantMessage, tmp, userLine } from './helpers';

const NOW = new Date('2026-10-09T02:00:00.000Z');
const lines = (...groups: string[][]) => groups.flat().map((l) => JSON.parse(l) as TranscriptLine);

describe('aggregateUsage', () => {
  it('counts each message.id once, per model, and skips already-counted and <synthetic> messages', () => {
    const { batches, messageIds } = aggregateUsage(
      lines(
        assistantMessage('msg_1', 'opus', { input: 2, output: 3 }, '2026-10-09T01:00:00.000Z', 3),
        assistantMessage('msg_2', 'opus', { input: 5, output: 7 }, '2026-10-09T01:00:01.000Z'),
        assistantMessage('msg_old', 'opus', { input: 100, output: 100 }, '2026-10-09T00:59:00.000Z'),
        assistantMessage('msg_syn', '<synthetic>', {}, '2026-10-09T01:00:02.000Z'),
      ),
      ['msg_old'],
    );
    expect(messageIds).toEqual(['msg_1', 'msg_2']);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      model: 'opus',
      inputTokens: 7,
      outputTokens: 10,
      messageIds: ['msg_1', 'msg_2'],
    });
  });

  it('splits cache writes by TTL, billing an unsplit remainder as 5-minute writes', () => {
    const { batches } = aggregateUsage(
      lines(
        assistantMessage('a', 'm', { cacheWrite: 50, split: { m5: 10, h1: 30 } }, '2026-10-09T01:00:00.000Z'),
        assistantMessage('b', 'm', { cacheWrite: 25 }, '2026-10-09T01:00:01.000Z'),
      ),
    );
    expect(batches[0]).toMatchObject({ cacheWrite5mTokens: 10 + 10 + 25, cacheWrite1hTokens: 30 });
  });

  it('reports the last message as the context size and spans first/last timestamps', () => {
    const { batches } = aggregateUsage(
      lines(
        assistantMessage('a', 'm', { input: 1, cacheRead: 1000, cacheWrite: 10 }, '2026-10-09T01:00:05.000Z'),
        assistantMessage('b', 'm', { input: 2, cacheRead: 1010, cacheWrite: 20 }, '2026-10-09T01:00:01.000Z'),
      ),
    );
    expect(batches[0]).toMatchObject({
      contextTokens: 2 + 1010 + 20,
      firstAt: '2026-10-09T01:00:01.000Z',
      lastAt: '2026-10-09T01:00:05.000Z',
    });
  });

  it('ignores lines without an id or usage and tolerates junk numbers', () => {
    const { batches, messageIds } = aggregateUsage([
      { type: 'assistant', message: { model: 'm', usage: { input_tokens: 5, output_tokens: 5 } } },
      { type: 'user', message: { id: 'u1', usage: { input_tokens: 5, output_tokens: 5 } } },
      {
        type: 'assistant',
        message: { id: 'x', model: 'm', usage: { input_tokens: -4, output_tokens: Number.NaN } },
      },
    ] as TranscriptLine[]);
    expect(messageIds).toEqual(['x']);
    expect(batches[0]).toMatchObject({ inputTokens: 0, outputTokens: 0 });
  });
});

describe('readTranscriptUsage', () => {
  const file = () => join(tmp(), 'session.jsonl');

  it('consumes only complete lines and tracks the byte offset (multi-byte text included)', () => {
    const path = file();
    const [a] = assistantMessage('msg_A', 'opus', { input: 1, output: 1 }, '2026-10-09T01:00:00.000Z');
    const [b] = assistantMessage('msg_B', 'opus', { input: 2, output: 2 }, '2026-10-09T01:00:01.000Z');
    writeFileSync(path, `${userLine('héllo ✓', '2026-10-09T00:59:59.000Z')}\n${a}\n${b}`);
    const first = readTranscriptUsage(path, { offset: 0, recentMessageIds: [] }, NOW.toISOString())!;
    expect(first.messageIds).toEqual(['msg_A']);
    expect(first.cursor.offset).toBe(
      Buffer.byteLength(`${userLine('héllo ✓', '2026-10-09T00:59:59.000Z')}\n${a}\n`),
    );

    appendFileSync(path, '\n');
    const second = readTranscriptUsage(path, first.cursor, NOW.toISOString())!;
    expect(second.messageIds).toEqual(['msg_B']);
    expect(second.cursor.offset).toBe(readFileSync(path).length);
    expect(second.cursor.recentMessageIds).toEqual(['msg_A', 'msg_B']);
  });

  it('counts a message whose block lines straddle two reads once', () => {
    const path = file();
    const [first, second] = assistantMessage(
      'msg_X',
      'opus',
      { input: 9, output: 9 },
      '2026-10-09T01:00:00.000Z',
      2,
    );
    writeFileSync(path, `${first}\n`);
    const r1 = readTranscriptUsage(path, { offset: 0, recentMessageIds: [] }, NOW.toISOString())!;
    appendFileSync(path, `${second}\n`);
    const r2 = readTranscriptUsage(path, r1.cursor, NOW.toISOString())!;
    expect(r1.batches[0]).toMatchObject({ inputTokens: 9 });
    expect(r2.batches).toEqual([]);
  });

  it('handles lines that cross the 1 MiB read chunks, including lines longer than a chunk', () => {
    const path = file();
    const content: string[] = [];
    for (let i = 0; i < 8; i++) {
      content.push(userLine('x'.repeat(i === 3 ? 2_500_000 : 300_000), `2026-10-09T01:00:0${i}.000Z`));
      content.push(
        ...assistantMessage(`msg_${i}`, 'opus', { input: 1, output: 1 }, `2026-10-09T01:00:0${i}.500Z`, 2),
      );
    }
    writeFileSync(path, content.join('\n') + '\n');
    const r = readTranscriptUsage(path, { offset: 0, recentMessageIds: [] }, NOW.toISOString())!;
    expect(r.messageIds).toHaveLength(8);
    expect(r.batches[0]).toMatchObject({ inputTokens: 8, outputTokens: 8 });
    expect(r.cursor.offset).toBe(readFileSync(path).length);
  });

  it('starts over when the transcript shrank, without recounting remembered messages', () => {
    const path = file();
    writeFileSync(
      path,
      assistantMessage('msg_A', 'opus', { input: 1 }, '2026-10-09T01:00:00.000Z').join('\n') + '\n',
    );
    const r = readTranscriptUsage(
      path,
      { offset: 10_000_000, recentMessageIds: ['msg_A'] },
      NOW.toISOString(),
    )!;
    expect(r.batches).toEqual([]);
    expect(r.cursor.offset).toBe(readFileSync(path).length);
  });

  it('returns null for a missing transcript', () => {
    expect(
      readTranscriptUsage(join(tmp(), 'nope.jsonl'), { offset: 0, recentMessageIds: [] }, NOW.toISOString()),
    ).toBeNull();
  });
});

describe('observed usage cursors', () => {
  it('persist only on commit and reset when the transcript path changes', () => {
    const stateDir = join(tmp(), 'state');
    const path = join(tmp(), 't.jsonl');
    writeFileSync(
      path,
      assistantMessage('msg_A', 'opus', { input: 1 }, '2026-10-09T01:00:00.000Z').join('\n') + '\n',
    );
    const opts = { stateDir, claudeSessionId: 'sess-1', agentId: null, transcriptPath: path, now: NOW };

    expect(readObservedUsage(opts)!.messageIds).toEqual(['msg_A']);
    const read = readObservedUsage(opts)!;
    expect(read.messageIds).toEqual(['msg_A']); // not committed yet: still pending
    read.commit();
    expect(readObservedUsage(opts)!.messageIds).toEqual([]);
    expect(readObservedUsage({ ...opts, transcriptPath: join(tmp(), 'missing.jsonl') })).toBeNull();

    const moved = join(tmp(), 'moved.jsonl');
    writeFileSync(moved, readFileSync(path));
    expect(readObservedUsage({ ...opts, transcriptPath: moved })!.messageIds).toEqual(['msg_A']);
  });

  it('never lets hook-supplied ids steer the state path', () => {
    expect(cursorFile('/state', '../../etc/passwd', null)).toBe('/state/______etc_passwd.json');
    expect(cursorFile('/state', 'sess', 'a/../../b')).toBe('/state/sess.agent-a_______b.json');
  });
});
