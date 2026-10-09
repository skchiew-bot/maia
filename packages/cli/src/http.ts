/**
 * Daemon API client for the CLI. Unlike the ingest client it never retries (a retried POST /api/sessions
 * could launch twice), keeps the error envelope's `code`/`details`, and can fetch binary bodies.
 */
import { CliError, EXIT } from './errors';

export interface ApiTarget {
  daemonUrl: string;
  token: string | null;
}

export interface RawResponse {
  status: number;
  contentType: string;
  bytes: Uint8Array;
}

export interface RequestOptions {
  timeoutMs?: number;
  accept?: string;
}

export class ApiError extends CliError {
  constructor(
    message: string,
    /** null = the daemon was not reached (network error / timeout). */
    readonly status: number | null,
    readonly code: string | null,
    readonly details: unknown,
    exitCode: number,
    hint?: string,
  ) {
    super(message, exitCode, { hint, lines: detailLines(details) });
    this.name = 'ApiError';
  }
}

export const DEFAULT_TIMEOUT_MS = 15_000;

export class Api {
  constructor(
    readonly target: ApiTarget,
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async raw(method: string, path: string, body?: unknown, o: RequestOptions = {}): Promise<RawResponse> {
    const headers: Record<string, string> = { accept: o.accept ?? 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.target.token) headers.authorization = `Bearer ${this.target.token}`;
    const timeoutMs = o.timeoutMs ?? this.timeoutMs;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.target.daemonUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
      const bytes = new Uint8Array(await res.arrayBuffer());
      return { status: res.status, contentType: res.headers.get('content-type') ?? '', bytes };
    } catch (err) {
      const reason = ac.signal.aborted
        ? `timed out after ${Math.round(timeoutMs / 1000)}s`
        : networkReason(err);
      throw new ApiError(
        `cannot reach the AOC daemon at ${this.target.daemonUrl} (${reason})`,
        null,
        null,
        null,
        EXIT.ERROR,
        'start it with `aoc serve`, or point at another daemon with --daemon <url> / AOC_DAEMON_URL',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async request<T>(method: string, path: string, body?: unknown, o: RequestOptions = {}): Promise<T> {
    const r = await this.raw(method, path, body, o);
    if (r.status < 200 || r.status >= 300) throw toApiError(r, method, path);
    const text = new TextDecoder().decode(r.bytes);
    if (!text.trim()) return null as T;
    const data = parseJson(text);
    if (data === undefined)
      throw new ApiError(
        `unexpected non-JSON response from ${method} ${path}`,
        r.status,
        null,
        null,
        EXIT.ERROR,
      );
    return data as T;
  }

  get<T>(path: string, o?: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, undefined, o);
  }

  post<T>(path: string, body: unknown = {}, o?: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, body, o);
  }

  /** Map a daemon-provided link (relative, or absolute on the daemon's own origin) to a path; never leak the token elsewhere. */
  pathFor(link: string): string {
    if (link.startsWith('/')) return link;
    if (link.startsWith(this.target.daemonUrl + '/')) return link.slice(this.target.daemonUrl.length);
    throw new CliError(
      `refusing to send credentials to ${link} (not the daemon at ${this.target.daemonUrl})`,
    );
  }
}

export function toApiError(r: RawResponse, method: string, path: string): ApiError {
  const data = parseJson(new TextDecoder().decode(r.bytes));
  const env = isRecord(data) && isRecord(data.error) ? data.error : null;
  const message = typeof env?.message === 'string' ? env.message : `HTTP ${r.status} from ${method} ${path}`;
  const code = typeof env?.code === 'string' ? env.code : null;
  const details = env?.details ?? null;
  if (r.status === 401) {
    return new ApiError(
      `not authenticated: ${message}`,
      401,
      code,
      details,
      EXIT.AUTH,
      'run `aoc login --token <token>` (or set AOC_TOKEN)',
    );
  }
  if (r.status === 403) return new ApiError(`forbidden: ${message}`, 403, code, details, EXIT.AUTH);
  return new ApiError(message, r.status, code, details, EXIT.ERROR);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function networkReason(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  return e?.cause?.code ?? e?.cause?.message ?? e?.message ?? String(err);
}

/** Validation issues ({path,message}[]) or plain string lists from the error envelope. */
function detailLines(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  return details.map((d) => {
    if (typeof d === 'string') return d;
    if (isRecord(d) && typeof d.message === 'string')
      return d.path ? `${String(d.path)}: ${d.message}` : d.message;
    return JSON.stringify(d);
  });
}
