/**
 * The local spool (§2: observed sessions buffer locally while aocd is down; managed hooks and the sidecar spool too).
 * Writers append JSON lines to their own `spool-<pid>.jsonl`. A flush claims a file by renaming it to
 * `<file>.sending-<pid>-<epoch ms>`, replays it through /ingest/spool and deletes the claim. What the daemon will
 * never take goes to `spool-rejected.jsonl`: kept for inspection, never replayed automatically.
 */
import { appendFileSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SpoolItem, SpoolItemResult } from '@aoc/contracts';

const MiB = 1024 * 1024;
/** Body cap per replay POST. aocd refuses /ingest/spool bodies over 64 MiB with 413. */
export const SPOOL_MAX_POST_BYTES = 8 * MiB;
/** Items per replay POST (aocd takes at most 500). */
export const SPOOL_MAX_POST_ITEMS = 100;
/** A claim this old belongs to a flush that crashed: its file goes back into the queue. */
export const SPOOL_CLAIM_STALE_MS = 10 * 60_000;
export const SPOOL_REJECTED_FILE = 'spool-rejected.jsonl';

/** Why an item ended up in spool-rejected.jsonl (machine labels). */
export type SpoolRejectReason = 'too_large' | 'rejected_by_daemon' | 'invalid' | 'unreadable';

const CLAIM = /^(.+)\.jsonl\.sending-(\d+)(?:-(\d+))?$/;
const ENVELOPE_BYTES = Buffer.byteLength('{"items":[]}');

/** A spool file waiting to be replayed (neither the rejected file nor a claim). */
export function isQueuedSpoolFile(name: string): boolean {
  return name.endsWith('.jsonl') && name !== SPOOL_REJECTED_FILE;
}

/**
 * Queued files, least recently written first. Each hook process spools to its own file, so this replays observed
 * events roughly in the order they happened (directory order is arbitrary).
 */
export function queuedSpoolFiles(dir: string): string[] {
  return readdirOrEmpty(dir)
    .filter(isQueuedSpoolFile)
    .map((name) => ({ name, at: mtimeOf(join(dir, name)) ?? 0 }))
    .sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((f) => f.name);
}

export function isSpoolClaim(name: string): boolean {
  return CLAIM.test(name);
}

export function claimNameFor(file: string, pid: number, nowMs: number): string {
  return `${file}.sending-${pid}-${nowMs}`;
}

/**
 * Stale claims: the flusher that made them is gone (hooks are short-lived processes), or they are older than
 * SPOOL_CLAIM_STALE_MS by the time in their name (or their mtime, for older names). Never this process's own claims.
 */
export function staleClaims(dir: string, nowMs: number): string[] {
  return readdirOrEmpty(dir).filter((name) => {
    const m = CLAIM.exec(name);
    if (!m) return false;
    const pid = Number(m[2]);
    if (pid === process.pid) return false;
    if (!processAlive(pid)) return true;
    const at = m[3] ? Number(m[3]) : mtimeOf(join(dir, name));
    return at !== null && nowMs - at >= SPOOL_CLAIM_STALE_MS;
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH'; // EPERM: alive, owned by someone else
  }
}

/**
 * Puts the files of crashed flushes back into the queue. Each gets a name derived from its claim, so a live writer's
 * `spool-<pid>.jsonl` is never overwritten and concurrent recoveries of one claim cannot both succeed.
 */
export function recoverStaleClaims(dir: string, nowMs: number): number {
  let recovered = 0;
  for (const name of staleClaims(dir, nowMs)) {
    const m = CLAIM.exec(name)!;
    const suffix = m[3] ? `${m[2]}-${m[3]}` : m[2];
    try {
      renameSync(join(dir, name), join(dir, `${m[1]}.recovered-${suffix}.jsonl`));
      recovered++;
    } catch {
      // another flusher recovered it first
    }
  }
  return recovered;
}

export interface SpoolFileContent {
  items: SpoolItem[];
  /** Lines that are not spool items (e.g. a write cut short by a crash). */
  unreadable: string[];
}

export function readSpoolFile(path: string): SpoolFileContent {
  const out: SpoolFileContent = { items: [], unreadable: [] };
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const v = parseJson(line);
    if (isSpoolItem(v)) out.items.push(v);
    else out.unreadable.push(line);
  }
  return out;
}

export function appendSpoolItems(file: string, items: readonly SpoolItem[]): void {
  if (items.length)
    appendFileSync(file, items.map((i) => `${JSON.stringify(i)}\n`).join(''), { mode: 0o600 });
}

/** Keeps a refused item (or an unreadable line) with when and why; throws when the disk refuses the write. */
export function recordRejected(
  dir: string,
  entry: { item: SpoolItem } | { raw: string },
  reason: SpoolRejectReason,
  at: string,
): void {
  // Item fields stay at the top level, so a line can be moved back into a queued file by hand once fixed.
  const record =
    'item' in entry ? { ...entry.item, rejectedAt: at, reason } : { raw: entry.raw, rejectedAt: at, reason };
  appendFileSync(join(dir, SPOOL_REJECTED_FILE), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone (e.g. recovered as stale while this flush was slow): the replay is idempotent
  }
}

export interface SpoolEntry {
  item: SpoolItem;
  /** The item as sent: JSON, and its UTF-8 size. */
  json: string;
  bytes: number;
}

/**
 * Splits items, in order, into POST bodies of at most `maxItems` items and `maxBytes` bytes (`{"items":[…]}`).
 * An item that cannot fit in a body on its own is returned separately: it can never be sent.
 */
export function planSpoolBatches(
  items: readonly SpoolItem[],
  limits: { maxBytes: number; maxItems: number },
): { batches: SpoolEntry[][]; oversize: SpoolEntry[] } {
  const batches: SpoolEntry[][] = [];
  const oversize: SpoolEntry[] = [];
  let cur: SpoolEntry[] = [];
  let curBytes = ENVELOPE_BYTES;
  for (const item of items) {
    const json = JSON.stringify(item);
    const entry = { item, json, bytes: Buffer.byteLength(json) };
    if (ENVELOPE_BYTES + entry.bytes > limits.maxBytes) {
      oversize.push(entry);
      continue;
    }
    if (cur.length && (cur.length >= limits.maxItems || curBytes + 1 + entry.bytes > limits.maxBytes)) {
      batches.push(cur);
      cur = [];
      curBytes = ENVELOPE_BYTES;
    }
    curBytes += (cur.length ? 1 : 0) + entry.bytes;
    cur.push(entry);
  }
  if (cur.length) batches.push(cur);
  return { batches, oversize };
}

export function spoolBody(batch: readonly SpoolEntry[]): string {
  return `{"items":[${batch.map((e) => e.json).join(',')}]}`;
}

/** Per-item outcomes from a /ingest/spool answer, when it carries a usable `results` list for `n` items. */
export function spoolResults(data: unknown, n: number): SpoolItemResult[] | null {
  const r = (data as { results?: unknown } | null)?.results;
  if (!Array.isArray(r) || r.length !== n) return null;
  return r.every((x) => x === 'accepted' || x === 'duplicate' || x === 'rejected')
    ? (r as SpoolItemResult[])
    : null;
}

export function spoolRejectedCount(data: unknown): number {
  const n = (data as { rejected?: unknown } | null)?.rejected;
  return typeof n === 'number' && n > 0 ? n : 0;
}

function isSpoolItem(v: unknown): v is SpoolItem {
  const o = v as Partial<SpoolItem> | null;
  return (
    !!o &&
    typeof o === 'object' &&
    !Array.isArray(o) &&
    typeof o.path === 'string' &&
    'body' in o &&
    typeof o.queuedAt === 'string'
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readdirOrEmpty(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}
