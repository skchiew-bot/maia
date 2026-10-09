// The transcript parser itself (dedupe by message.id, cache TTL split, line reading) is tested in @aoc/client.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cursorFile, loadCursor, readObservedUsage, readTranscriptUsage } from '../src';
import { assistantMessage, tmp, userLine } from './helpers';

const NOW = new Date('2026-10-09T02:00:00.000Z');
const START = { offset: 0, counted: {} };

describe('readTranscriptUsage', () => {
  const file = () => join(tmp(), 'session.jsonl');

  it('reads complete lines only and advances the cursor past them', () => {
    const path = file();
    const [a] = assistantMessage('msg_A', 'opus', { input: 1, output: 1 }, '2026-10-09T01:00:00.000Z');
    const [b] = assistantMessage('msg_B', 'opus', { input: 2, output: 2 }, '2026-10-09T01:00:01.000Z');
    writeFileSync(path, `${userLine('héllo ✓', '2026-10-09T00:59:59.000Z')}\n${a}\n${b}`);
    const first = readTranscriptUsage(path, START, NOW)!;
    expect(first.messageIds).toEqual(['msg_A']);
    expect(first.cursor.offset).toBe(
      Buffer.byteLength(`${userLine('héllo ✓', '2026-10-09T00:59:59.000Z')}\n${a}\n`),
    );

    appendFileSync(path, '\n');
    const second = readTranscriptUsage(path, first.cursor, NOW)!;
    expect(second.messageIds).toEqual(['msg_B']);
    expect(second.cursor.offset).toBe(readFileSync(path).length);
    expect(Object.keys(second.cursor.counted)).toEqual(['msg_A', 'msg_B']);
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
    const r1 = readTranscriptUsage(path, START, NOW)!;
    appendFileSync(path, `${second}\n`);
    const r2 = readTranscriptUsage(path, r1.cursor, NOW)!;
    expect(r1.batches[0]).toMatchObject({ inputTokens: 9 });
    expect(r2.batches).toEqual([]);
  });

  it('starts over when the transcript shrank, without recounting remembered messages', () => {
    const path = file();
    writeFileSync(
      path,
      assistantMessage('msg_A', 'opus', { input: 1 }, '2026-10-09T01:00:00.000Z').join('\n') + '\n',
    );
    const seen = readTranscriptUsage(path, START, NOW)!.cursor.counted;
    const r = readTranscriptUsage(path, { offset: 10_000_000, counted: seen }, NOW)!;
    expect(r.batches).toEqual([]);
    expect(r.cursor.offset).toBe(readFileSync(path).length);
  });

  it('keeps the counts of the 512 most recent messages in the cursor', () => {
    const path = file();
    const lines = Array.from({ length: 600 }, (_, i) =>
      assistantMessage(`msg_${i}`, 'opus', { input: 1 }, '2026-10-09T01:00:00.000Z'),
    ).flat();
    writeFileSync(path, lines.join('\n') + '\n');
    const counted = Object.keys(readTranscriptUsage(path, START, NOW)!.cursor.counted);
    expect(counted).toHaveLength(512);
    expect(counted.at(-1)).toBe('msg_599');
  });

  it('returns null for a missing transcript', () => {
    expect(readTranscriptUsage(join(tmp(), 'nope.jsonl'), START, NOW)).toBeNull();
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

  it('keeps the offset of a cursor written without counts (version 1)', () => {
    const file = join(tmp(), 'sess.json');
    writeFileSync(
      file,
      JSON.stringify({ version: 1, transcriptPath: '/t.jsonl', offset: 42, recentMessageIds: ['m'] }),
    );
    expect(loadCursor(file, '/t.jsonl')).toEqual({ offset: 42, counted: {} });
    expect(loadCursor(file, '/other.jsonl')).toEqual(START);
  });

  it('never lets hook-supplied ids steer the state path', () => {
    expect(cursorFile('/state', '../../etc/passwd', null)).toBe('/state/______etc_passwd.json');
    expect(cursorFile('/state', 'sess', 'a/../../b')).toBe('/state/sess.agent-a_______b.json');
  });
});
