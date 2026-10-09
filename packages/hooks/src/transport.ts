/**
 * Single-attempt JSON POST with a hard deadline. The hook runs on Claude Code's hot path, so the deadline bounds the
 * whole exchange (connect + response body) and there are no retries inside it; failed observed/managed events are
 * spooled instead (spool.ts).
 */
export type PostResult<T> =
  | { ok: true; status: number; data: T }
  | {
      ok: false;
      status: number | null;
      error: string;
      /** Network error, timeout, 5xx or 429: worth spooling. */
      retryable: boolean;
    };

export interface PostOptions {
  token?: string | null;
  timeoutMs: number;
}

export async function postJson<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  o: PostOptions,
): Promise<PostResult<T>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), o.timeoutMs);
  try {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (o.token) headers.authorization = `Bearer ${o.token}`;
    const res = await fetch(baseUrl.replace(/\/+$/, '') + path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    const data = parseJson(text);
    if (res.ok) return { ok: true, status: res.status, data: data as T };
    const message = (data as { error?: { message?: unknown } } | null)?.error?.message;
    return {
      ok: false,
      status: res.status,
      error: typeof message === 'string' ? message : `HTTP ${res.status}`,
      retryable: res.status >= 500 || res.status === 429,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      error: ac.signal.aborted ? `timeout after ${o.timeoutMs} ms` : describe(err),
      retryable: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** fetch wraps socket errors as `TypeError: fetch failed` with the useful part (ECONNREFUSED …) in `cause`. */
function describe(err: unknown): string {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  return e.cause?.message || e.cause?.code || e.message || String(err);
}
