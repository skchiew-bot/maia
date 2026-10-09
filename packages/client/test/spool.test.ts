import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpoolItem, SpoolItemResult } from '@aoc/contracts';
import { describe, expect, it } from 'vitest';
import {
  SPOOL_CLAIM_STALE_MS,
  SPOOL_MAX_POST_BYTES,
  SPOOL_REJECTED_FILE,
  createClient,
  planSpoolBatches,
  type ClientOptions,
} from '../src';

const NOW = Date.parse('2026-10-09T04:00:00.000Z');
const spoolDir = () => mkdtempSync(join(tmpdir(), 'aoc-spool-'));

const item = (n: number, pad = 0): SpoolItem => ({
  path: '/ingest/hook',
  body: { n, pad: 'x'.repeat(pad) },
  queuedAt: '2026-10-09T03:00:00.000Z',
});
const nOf = (i: SpoolItem) => (i.body as { n: number }).n;

interface Post {
  bytes: number;
  items: SpoolItem[];
}
type Answer = { status: number; json?: unknown } | 'down';

/** fetch stand-in: records every POST and answers with `answer`. */
function fakeFetch(answer: (items: SpoolItem[], bytes: number) => Answer) {
  const posts: Post[] = [];
  const impl: typeof fetch = async (_url, init) => {
    const raw = String(init?.body ?? '');
    const items = (JSON.parse(raw) as { items: SpoolItem[] }).items;
    const bytes = Buffer.byteLength(raw);
    posts.push({ bytes, items });
    const a = answer(items, bytes);
    if (a === 'down') throw new TypeError('fetch failed');
    return new Response(a.json === undefined ? '' : JSON.stringify(a.json), { status: a.status });
  };
  return { impl, posts };
}

/** A daemon: 413 past `capBytes`, refuses what `refuse` says, knows items it accepted before (duplicates). */
function fakeDaemon(o: { capBytes?: number; refuse?: (i: SpoolItem) => boolean; perItem?: boolean } = {}) {
  const accepted = new Set<number>();
  const f = fakeFetch((items, bytes) => {
    if (o.capBytes && bytes > o.capBytes)
      return { status: 413, json: { error: { code: 'payload_too_large', message: 'too big' } } };
    const results: SpoolItemResult[] = items.map((i) => {
      if (o.refuse?.(i)) return 'rejected';
      if (accepted.has(nOf(i))) return 'duplicate';
      accepted.add(nOf(i));
      return 'accepted';
    });
    const count = (r: SpoolItemResult) => results.filter((x) => x === r).length;
    const counts = {
      accepted: count('accepted'),
      duplicates: count('duplicate'),
      rejected: count('rejected'),
    };
    return { status: 200, json: o.perItem === false ? counts : { ...counts, results } };
  });
  return { ...f, accepted };
}

function client(dir: string, fetchImpl: typeof fetch, extra: Partial<ClientOptions> = {}) {
  return createClient({
    daemonUrl: 'http://aocd.test',
    spoolDir: dir,
    fetchImpl,
    retries: 1,
    now: () => NOW,
    ...extra,
  });
}

const rejectedLines = (dir: string) =>
  existsSync(join(dir, SPOOL_REJECTED_FILE))
    ? readFileSync(join(dir, SPOOL_REJECTED_FILE), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];

describe('flushSpool: byte-capped batches', () => {
  it('never posts more than 8 MiB, keeping the spool order', async () => {
    const dir = spoolDir();
    const d = fakeDaemon();
    const c = client(dir, d.impl);
    for (let n = 0; n < 3; n++) c.spool(item(n, 3 * 1024 * 1024));
    expect(SPOOL_MAX_POST_BYTES).toBe(8 * 1024 * 1024);
    expect(await c.flushSpool()).toEqual({ sent: 3, failed: 0, rejected: 0 });
    expect(d.posts.map((p) => p.items.map(nOf))).toEqual([[0, 1], [2]]);
    expect(d.posts.every((p) => p.bytes <= SPOOL_MAX_POST_BYTES)).toBe(true);
    expect(c.spooledCount()).toBe(0);
  });

  it('fills each POST up to the byte and item limits exactly', () => {
    const items = Array.from({ length: 7 }, (_, n) => item(n, 50));
    const one = Buffer.byteLength(JSON.stringify(items[0]));
    const envelope = Buffer.byteLength('{"items":[]}');
    // Room for exactly three items (two commas) per body.
    const plan = planSpoolBatches(items, { maxBytes: envelope + 3 * one + 2, maxItems: 100 });
    expect(plan.batches.map((b) => b.map((e) => nOf(e.item)))).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
    expect(planSpoolBatches(items, { maxBytes: 1 << 20, maxItems: 2 }).batches.map((b) => b.length)).toEqual([
      2, 2, 2, 1,
    ]);
    const big = planSpoolBatches([item(0), item(1, 5000), item(2)], { maxBytes: 1000, maxItems: 100 });
    expect(big.oversize.map((e) => nOf(e.item))).toEqual([1]);
    expect(big.batches.map((b) => b.map((e) => nOf(e.item)))).toEqual([[0, 2]]);
  });

  it('halves a batch the daemon answers 413 until it fits; a single item that still does not goes to spool-rejected.jsonl', async () => {
    const dir = spoolDir();
    const d = fakeDaemon({ capBytes: 2_000 });
    const c = client(dir, d.impl);
    for (let n = 0; n < 8; n++) c.spool(item(n, n === 5 ? 3_000 : 300));
    expect(await c.flushSpool({ maxBytes: 1 << 20 })).toEqual({ sent: 7, failed: 0, rejected: 1 });
    expect([...d.accepted].sort()).toEqual([0, 1, 2, 3, 4, 6, 7]);
    expect(d.posts.filter((p) => p.bytes <= 2_000).every((p) => p.items.every((i) => nOf(i) !== 5))).toBe(
      true,
    );
    expect(rejectedLines(dir)).toEqual([
      { ...item(5, 3_000), rejectedAt: new Date(NOW).toISOString(), reason: 'too_large' },
    ]);
    expect(c.spooledCount()).toBe(0);
  });

  it('never sends an item that alone exceeds the POST cap', async () => {
    const dir = spoolDir();
    const d = fakeDaemon();
    const c = client(dir, d.impl);
    c.spool(item(1));
    c.spool(item(2, 4_000));
    c.spool(item(3));
    expect(await c.flushSpool({ maxBytes: 1_000 })).toEqual({ sent: 2, failed: 0, rejected: 1 });
    expect(d.posts.map((p) => p.items.map(nOf))).toEqual([[1, 3]]);
    expect(rejectedLines(dir).map((r) => [nOf(r as unknown as SpoolItem), r.reason])).toEqual([
      [2, 'too_large'],
    ]);
  });
});

describe('flushSpool: what the daemon refuses is kept, never dropped', () => {
  it('moves the items reported rejected (per-item results) to spool-rejected.jsonl', async () => {
    const dir = spoolDir();
    const d = fakeDaemon({ refuse: (i) => nOf(i) % 3 === 0 });
    const c = client(dir, d.impl);
    for (let n = 1; n <= 7; n++) c.spool(item(n));
    expect(await c.flushSpool()).toEqual({ sent: 5, failed: 0, rejected: 2 });
    expect(d.posts).toHaveLength(1);
    expect(rejectedLines(dir).map((r) => [nOf(r as unknown as SpoolItem), r.reason])).toEqual([
      [3, 'rejected_by_daemon'],
      [6, 'rejected_by_daemon'],
    ]);
    // Kept for inspection: neither counted as spooled nor replayed.
    expect(c.spooledCount()).toBe(0);
    expect(await c.flushSpool()).toEqual({ sent: 0, failed: 0, rejected: 0 });
    expect(d.posts).toHaveLength(1);
  });

  it('isolates rejected items by halving when the daemon only reports counts (accepted ones come back as duplicates)', async () => {
    const dir = spoolDir();
    const d = fakeDaemon({ refuse: (i) => nOf(i) === 6, perItem: false });
    const c = client(dir, d.impl);
    for (let n = 1; n <= 8; n++) c.spool(item(n));
    expect(await c.flushSpool()).toEqual({ sent: 7, failed: 0, rejected: 1 });
    expect([...d.accepted].sort()).toEqual([1, 2, 3, 4, 5, 7, 8]);
    expect(rejectedLines(dir).map((r) => nOf(r as unknown as SpoolItem))).toEqual([6]);
  });

  it('rejects a single item the daemon finds invalid (422), and unreadable lines', async () => {
    const dir = spoolDir();
    const f = fakeFetch((items) =>
      items.some((i) => nOf(i) === 2)
        ? { status: 422, json: { error: { code: 'invalid' } } }
        : { status: 200, json: { accepted: items.length, duplicates: 0, rejected: 0 } },
    );
    writeFileSync(
      join(dir, 'spool-1.jsonl'),
      [
        JSON.stringify(item(1)),
        JSON.stringify(item(2)),
        '{"path":"/ingest/hook","bo',
        JSON.stringify(item(3)),
      ].join('\n') + '\n',
    );
    const c = client(dir, f.impl);
    expect(await c.flushSpool()).toEqual({ sent: 2, failed: 0, rejected: 2 });
    expect(
      rejectedLines(dir).map((r) => [r.reason, 'raw' in r ? r.raw : nOf(r as unknown as SpoolItem)]),
    ).toEqual([
      ['unreadable', '{"path":"/ingest/hook","bo'],
      ['invalid', 2],
    ]);
  });
});

describe('flushSpool: daemon unreachable', () => {
  it('keeps the batch and everything after it queued, and stops at the first unreachable POST', async () => {
    const dir = spoolDir();
    let up = true;
    const f = fakeFetch((items) =>
      up ? { status: 200, json: { accepted: items.length, duplicates: 0, rejected: 0 } } : 'down',
    );
    const c = client(dir, f.impl);
    writeFileSync(
      join(dir, 'spool-1.jsonl'),
      [1, 2, 3, 4].map((n) => JSON.stringify(item(n))).join('\n') + '\n',
    );
    writeFileSync(join(dir, 'spool-2.jsonl'), JSON.stringify(item(5)) + '\n');
    // Replayed least recently written first.
    utimesSync(join(dir, 'spool-1.jsonl'), new Date(NOW - 2_000), new Date(NOW - 2_000));
    utimesSync(join(dir, 'spool-2.jsonl'), new Date(NOW - 1_000), new Date(NOW - 1_000));
    up = false;
    expect(await c.flushSpool({ maxItems: 2 })).toEqual({ sent: 0, failed: 4, rejected: 0 });
    expect(f.posts).toHaveLength(1); // the second batch and the second file were not attempted
    expect(c.spooledCount()).toBe(5);
    expect(readdirSync(dir).filter((x) => x.includes('.sending-'))).toEqual([]);
    up = true;
    expect(await c.flushSpool()).toEqual({ sent: 5, failed: 0, rejected: 0 });
    expect(c.spooledCount()).toBe(0);
  });

  it('keeps the second half when the daemon goes away in the middle of a split', async () => {
    const dir = spoolDir();
    let calls = 0;
    const f = fakeFetch((items) => {
      calls++;
      if (calls === 1) return { status: 413 };
      if (calls === 2) return { status: 200, json: { accepted: items.length, duplicates: 0, rejected: 0 } };
      return { status: 503 };
    });
    const c = client(dir, f.impl);
    for (let n = 1; n <= 4; n++) c.spool(item(n));
    expect(await c.flushSpool()).toEqual({ sent: 2, failed: 2, rejected: 0 });
    expect(f.posts.map((p) => p.items.map(nOf))).toEqual([
      [1, 2, 3, 4],
      [1, 2],
      [3, 4],
    ]);
    expect(c.spooledCount()).toBe(2);
  });
});

describe('flushSpool: claims of crashed flushes', () => {
  it('requeues claims older than 10 minutes and leaves fresh ones to their flusher', async () => {
    const dir = spoolDir();
    const d = fakeDaemon();
    const old = NOW - SPOOL_CLAIM_STALE_MS - 1;
    writeFileSync(join(dir, `spool-11.jsonl.sending-999-${old}`), JSON.stringify(item(1)) + '\n');
    // A fresh claim whose flusher is alive is left to it (a dead flusher's claim is recovered at once).
    const live = process.ppid;
    writeFileSync(join(dir, `spool-12.jsonl.sending-${live}-${NOW - 60_000}`), JSON.stringify(item(2)) + '\n');
    // A claim named before claims carried their time: its mtime decides.
    const legacy = join(dir, 'spool-13.jsonl.sending-998');
    writeFileSync(legacy, JSON.stringify(item(3)) + '\n');
    utimesSync(legacy, new Date(old), new Date(old));
    // A live writer's file with the same base name is never overwritten by a recovery.
    writeFileSync(join(dir, 'spool-11.jsonl'), JSON.stringify(item(4)) + '\n');
    const c = client(dir, d.impl);
    expect(c.spooledCount()).toBe(3);
    expect(await c.flushSpool()).toEqual({ sent: 3, failed: 0, rejected: 0 });
    expect([...d.accepted].sort()).toEqual([1, 3, 4]);
    expect(readdirSync(dir)).toEqual([`spool-12.jsonl.sending-${live}-${NOW - 60_000}`]);
  });
});
