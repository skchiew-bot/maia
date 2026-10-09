/**
 * Ingest/API client shared by hooks, sidecar, MCP server and CLI.
 * - `post` with timeout + bounded retries; optional local spool on failure (observed sessions buffer
 *   locally if the backend is down, §2) and `flushSpool` to replay through /ingest/spool (idempotent).
 * - No dependencies beyond Node 22 globals (fetch, AbortController) so binaries start fast.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { INGEST_PATHS, type SpoolFlushResponse, type SpoolItem } from '@aoc/contracts';

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
}

export type ClientResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number | null; error: string; spooled: boolean };

export class AocClient {
  private readonly fetchImpl: typeof fetch;
  constructor(readonly opts: ClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.opts.token) h.authorization = `Bearer ${this.opts.token}`;
    return h;
  }

  async request<T>(method: string, path: string, body?: unknown, o: { retries?: number; timeoutMs?: number } = {}): Promise<ClientResult<T>> {
    const url = this.opts.daemonUrl.replace(/\/+$/, '') + path;
    const attempts = Math.max(1, o.retries ?? this.opts.retries ?? 2);
    let lastErr = 'unknown error';
    let lastStatus: number | null = null;
    for (let i = 0; i < attempts; i++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), o.timeoutMs ?? this.opts.timeoutMs ?? 3000);
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: this.headers(),
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ac.signal,
        });
        const text = await res.text();
        const data = text ? safeJson(text) : null;
        if (res.ok) return { ok: true, status: res.status, data: data as T };
        lastStatus = res.status;
        lastErr = (data as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${res.status}`;
        if (res.status < 500 && res.status !== 429) break; // client errors are not retried
      } catch (err) {
        lastErr = (err as Error).name === 'AbortError' ? 'timeout' : String((err as Error).message ?? err);
      } finally {
        clearTimeout(timer);
      }
      if (i < attempts - 1) await sleep(150 * (i + 1));
    }
    return { ok: false, status: lastStatus, error: lastErr, spooled: false };
  }

  get<T>(path: string): Promise<ClientResult<T>> {
    return this.request<T>('GET', path);
  }

  /** POST; when it fails with a network error/5xx and `spool` is set, the item is buffered locally. */
  async post<T>(path: string, body: unknown, o: { spool?: boolean; retries?: number; timeoutMs?: number } = {}): Promise<ClientResult<T>> {
    const r = await this.request<T>('POST', path, body, o);
    if (!r.ok && o.spool && this.opts.spoolDir && (r.status === null || r.status >= 500)) {
      this.spool({ path, body, queuedAt: new Date().toISOString() });
      return { ...r, spooled: true };
    }
    return r;
  }

  spool(item: SpoolItem): void {
    const dir = this.opts.spoolDir;
    if (!dir) throw new Error('no spool dir configured');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, `spool-${process.pid}.jsonl`), JSON.stringify(item) + '\n', { mode: 0o600 });
  }

  spooledCount(): number {
    const dir = this.opts.spoolDir;
    if (!dir || !existsSync(dir)) return 0;
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .reduce((n, f) => n + readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).length, 0);
  }

  /** Replay spooled items in batches (claiming files by rename so concurrent flushers never double-send). */
  async flushSpool(batchSize = 100): Promise<{ sent: number; failed: number }> {
    const dir = this.opts.spoolDir;
    if (!dir || !existsSync(dir)) return { sent: 0, failed: 0 };
    let sent = 0;
    let failed = 0;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
      const claimed = join(dir, `${f}.sending-${process.pid}`);
      try {
        renameSync(join(dir, f), claimed);
      } catch {
        continue; // another process claimed it
      }
      const items = readFileSync(claimed, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => safeJson(l) as SpoolItem | null)
        .filter((x): x is SpoolItem => !!x);
      const unsent: SpoolItem[] = [];
      for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const r = await this.request<SpoolFlushResponse>('POST', INGEST_PATHS.spool, { items: batch }, { retries: 1 });
        if (r.ok) sent += batch.length;
        else {
          failed += batch.length;
          unsent.push(...batch);
        }
      }
      unlinkSync(claimed);
      for (const it of unsent) this.spool(it);
    }
    return { sent, failed };
  }
}

export function createClient(opts: ClientOptions): AocClient {
  return new AocClient(opts);
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
