/**
 * Ingest/API client shared by hooks, sidecar, MCP server and CLI.
 * - `post` with timeout + bounded retries; optional local spool on failure (observed sessions buffer
 *   locally if the backend is down, §2) and `flushSpool` to replay through /ingest/spool (idempotent).
 * - Transcript parsing shared by the sidecar and the observed hook (./transcript).
 * - No dependencies beyond Node 22 globals (fetch, AbortController) and type-only contract imports, so the hook
 *   binary, which runs on Claude Code's hot path, stays small and starts fast.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { INGEST_PATHS, SpoolFlushResponse, SpoolItem } from '@aoc/contracts';
import {
  SPOOL_MAX_POST_BYTES,
  SPOOL_MAX_POST_ITEMS,
  appendSpoolItems,
  claimNameFor,
  isQueuedSpoolFile,
  planSpoolBatches,
  queuedSpoolFiles,
  readSpoolFile,
  recordRejected,
  recoverStaleClaims,
  removeFile,
  spoolBody,
  spoolRejectedCount,
  spoolResults,
  staleClaims,
  type SpoolEntry,
  type SpoolRejectReason,
} from './spool';

export * from './spool';
export * from './transcript';

const SPOOL_PATH = '/ingest/spool' as const satisfies (typeof INGEST_PATHS)['spool'];
/** aocd validates at most this many items per replay. */
const DAEMON_MAX_SPOOL_ITEMS = 500;

export interface ClientOptions {
  daemonUrl: string;
  token?: string | null;
  /** Per-attempt timeout (default 3000 ms; hooks on the hot path should use ≤ 2500). */
  timeoutMs?: number;
  /** Attempts for idempotent posts (default 2). */
  retries?: number;
  /** Directory for the local JSONL spool (observed mode). */
  spoolDir?: string | null;
  fetchImpl?: typeof fetch;
  /** Epoch ms (spool timestamps, stale-claim age); default Date.now. */
  now?: () => number;
}

export type ClientResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number | null;
      error: string;
      code?: string;
      details?: unknown;
      body?: unknown;
      spooled: boolean;
    };

export interface SpoolFlushOptions {
  /** Body cap per POST (default 8 MiB). */
  maxBytes?: number;
  /** Items per POST (default 100; never more than the daemon's 500). */
  maxItems?: number;
}

export interface SpoolFlushResult {
  /** Delivered: accepted, or already known to the daemon. */
  sent: number;
  /** Kept in the spool for a later flush (daemon unreachable, 5xx, 429, auth). */
  failed: number;
  /** Moved to spool-rejected.jsonl: refused by the daemon, unreadable, or too large to send on its own. */
  rejected: number;
}

export class AocClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  constructor(readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.opts.token) h.authorization = `Bearer ${this.opts.token}`;
    return h;
  }

  request<T>(
    method: string,
    path: string,
    body?: unknown,
    o: { retries?: number; timeoutMs?: number } = {},
  ): Promise<ClientResult<T>> {
    return this.send<T>(method, path, body === undefined ? undefined : JSON.stringify(body), o);
  }

  /** `request` with an already serialized JSON body. */
  private async send<T>(
    method: string,
    path: string,
    text: string | undefined,
    o: { retries?: number; timeoutMs?: number },
  ): Promise<ClientResult<T>> {
    const url = this.opts.daemonUrl.replace(/\/+$/, '') + path;
    const attempts = Math.max(1, o.retries ?? this.opts.retries ?? 2);
    let lastErr = 'unknown error';
    let lastStatus: number | null = null;
    let lastBody: unknown = undefined;
    for (let i = 0; i < attempts; i++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? this.opts.timeoutMs ?? 3000);
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: this.headers(),
          body: text,
          signal: ac.signal,
        });
        const resText = await res.text();
        const data = resText ? safeJson(resText) : null;
        if (res.ok) return { ok: true, status: res.status, data: data as T };
        lastStatus = res.status;
        lastBody = data;
        const errObj = (data as { error?: unknown } | null)?.error;
        lastErr =
          (typeof errObj === 'object' && errObj
            ? (errObj as { message?: string }).message
            : typeof errObj === 'string'
              ? errObj
              : undefined) ?? `HTTP ${res.status}`;
        if (res.status < 500 && res.status !== 429) break; // client errors are not retried
      } catch (err) {
        lastErr = (err as Error).name === 'AbortError' ? 'timeout' : String((err as Error).message ?? err);
      } finally {
        clearTimeout(timer);
      }
      if (i < attempts - 1) await sleep(150 * (i + 1));
    }
    const e = (lastBody as { error?: { code?: string; details?: unknown } } | undefined)?.error;
    return {
      ok: false,
      status: lastStatus,
      error: lastErr,
      ...(e && typeof e === 'object' && e.code ? { code: e.code } : {}),
      ...(e && typeof e === 'object' && e.details !== undefined ? { details: e.details } : {}),
      ...(lastBody !== undefined ? { body: lastBody } : {}),
      spooled: false,
    };
  }

  get<T>(path: string): Promise<ClientResult<T>> {
    return this.request<T>('GET', path);
  }

  /** POST; when it fails with a network error/5xx and `spool` is set, the item is buffered locally. */
  async post<T>(
    path: string,
    body: unknown,
    o: { spool?: boolean; retries?: number; timeoutMs?: number } = {},
  ): Promise<ClientResult<T>> {
    const r = await this.request<T>('POST', path, body, o);
    if (!r.ok && o.spool && this.opts.spoolDir && (r.status === null || r.status >= 500)) {
      this.spool({ path, body, queuedAt: new Date(this.now()).toISOString() });
      return { ...r, spooled: true };
    }
    return r;
  }

  spool(item: SpoolItem): void {
    appendSpoolItems(this.ownSpoolFile(), [item]);
  }

  private ownSpoolFile(): string {
    const dir = this.opts.spoolDir;
    if (!dir) throw new Error('no spool dir configured');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, `spool-${process.pid}.jsonl`);
  }

  /** Items waiting for a replay: queued files, plus the claims of crashed flushes that the next flush recovers. */
  spooledCount(): number {
    const dir = this.opts.spoolDir;
    if (!dir || !existsSync(dir)) return 0;
    const files = [...readdirSync(dir).filter(isQueuedSpoolFile), ...staleClaims(dir, this.now())];
    return files.reduce((n, f) => n + countLines(join(dir, f)), 0);
  }

  /**
   * Replays the spool through /ingest/spool in batches of at most 8 MiB, claiming files by rename so concurrent
   * flushers never double-send. A 413 (or another refusal of the batch's content) halves the batch until single
   * items, which are then moved to spool-rejected.jsonl, as are the items the daemon reports rejected. A batch that
   * cannot reach the daemon stays queued, and so does everything after it.
   */
  async flushSpool(o: SpoolFlushOptions = {}): Promise<SpoolFlushResult> {
    const dir = this.opts.spoolDir;
    const out: SpoolFlushResult = { sent: 0, failed: 0, rejected: 0 };
    if (!dir || !existsSync(dir)) return out;
    const limits = {
      maxBytes: o.maxBytes ?? SPOOL_MAX_POST_BYTES,
      maxItems: Math.min(o.maxItems ?? SPOOL_MAX_POST_ITEMS, DAEMON_MAX_SPOOL_ITEMS),
    };
    recoverStaleClaims(dir, this.now());
    for (const f of queuedSpoolFiles(dir)) {
      const claimed = join(dir, claimNameFor(f, process.pid, this.now()));
      try {
        renameSync(join(dir, f), claimed);
      } catch {
        continue; // another process claimed it
      }
      const keep: SpoolItem[] = [];
      let reachable = true;
      try {
        const { items, unreadable } = readSpoolFile(claimed);
        for (const raw of unreadable) this.reject(dir, { raw }, 'unreadable', out);
        const { batches, oversize } = planSpoolBatches(items, limits);
        for (const e of oversize) this.reject(dir, { item: e.item }, 'too_large', out);
        for (const batch of batches) {
          if (reachable) reachable = await this.deliver(dir, batch, out, keep);
          else keep.push(...batch.map((e) => e.item));
        }
        appendSpoolItems(this.ownSpoolFile(), keep); // back in the queue before the claim goes away
      } catch {
        // A rejection or the re-queue could not be written: keep the claim. It is recovered once stale, and replaying
        // what was already delivered is idempotent.
        break;
      }
      removeFile(claimed);
      out.failed += keep.length;
      if (!reachable) break; // the remaining files wait for the next flush
    }
    return out;
  }

  /** One replay POST. False when the daemon could not be reached (the batch is then in `keep`). */
  private async deliver(
    dir: string,
    batch: SpoolEntry[],
    out: SpoolFlushResult,
    keep: SpoolItem[],
  ): Promise<boolean> {
    const r = await this.send<SpoolFlushResponse>('POST', SPOOL_PATH, spoolBody(batch), { retries: 1 });
    if (r.ok) {
      const results = spoolResults(r.data, batch.length);
      if (results) {
        batch.forEach((e, i) => {
          if (results[i] === 'rejected') this.reject(dir, { item: e.item }, 'rejected_by_daemon', out);
          else out.sent++;
        });
        return true;
      }
      if (!spoolRejectedCount(r.data)) {
        out.sent += batch.length;
        return true;
      }
      if (batch.length === 1) {
        this.reject(dir, { item: batch[0]!.item }, 'rejected_by_daemon', out);
        return true;
      }
      // A daemon that only reports counts: halve until the refused items are isolated. Items it accepted come back
      // as duplicates (replays are idempotent).
      return this.split(dir, batch, out, keep);
    }
    if (r.status === 413 || r.status === 400 || r.status === 422) {
      if (batch.length === 1) {
        this.reject(dir, { item: batch[0]!.item }, r.status === 413 ? 'too_large' : 'invalid', out);
        return true;
      }
      return this.split(dir, batch, out, keep);
    }
    keep.push(...batch.map((e) => e.item));
    return false;
  }

  private async split(
    dir: string,
    batch: SpoolEntry[],
    out: SpoolFlushResult,
    keep: SpoolItem[],
  ): Promise<boolean> {
    const mid = Math.ceil(batch.length / 2);
    const rest = batch.slice(mid);
    if (!(await this.deliver(dir, batch.slice(0, mid), out, keep))) {
      keep.push(...rest.map((e) => e.item));
      return false;
    }
    return this.deliver(dir, rest, out, keep);
  }

  private reject(
    dir: string,
    entry: { item: SpoolItem } | { raw: string },
    reason: SpoolRejectReason,
    out: SpoolFlushResult,
  ): void {
    recordRejected(dir, entry, reason, new Date(this.now()).toISOString());
    out.rejected++;
  }
}

export function createClient(opts: ClientOptions): AocClient {
  return new AocClient(opts);
}

function countLines(file: string): number {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
  } catch {
    return 0; // claimed or recovered by a concurrent flush
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Client-side config file (~/.aoc/client.json) shared by the CLI and observed hooks. */
export interface ClientConfigFile {
  daemonUrl: string;
  token?: string;
  observerToken?: string;
}
export function readClientConfig(file: string): ClientConfigFile | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as ClientConfigFile;
  } catch {
    return null;
  }
}
