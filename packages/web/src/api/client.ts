/**
 * Thin JSON client for the AOC daemon. Paths include the `/api` prefix (`apiGet('/api/projects')`) so call
 * sites are greppable against daemon routes. Session auth is a cookie, hence `credentials: 'include'`.
 */

/** A non-2xx response, a network failure (`status` 0) or a non-JSON body. */
export class ApiError extends Error {
  /** HTTP status; 0 when the request never got a response. */
  readonly status: number;
  /** Machine-readable code from the daemon, or a client-side code (`network_error`, `invalid_json`, `http_<n>`). */
  readonly code: string;
  /** Extra structured detail from the error body, if any. */
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type QueryValue = string | number | boolean | null | undefined;

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  /** Appended as a query string; `null`/`undefined` values are skipped. */
  query?: Record<string, QueryValue>;
  /**
   * On 401, send the user to the sign-in page for the current surface (default true). The auth probe and the
   * login form opt out so they can handle 401 themselves.
   */
  redirectOn401?: boolean;
}

type UnauthorizedHandler = (loginPath: string) => void;

let unauthorizedHandler: UnauthorizedHandler = (loginPath) => {
  window.location.assign(loginPath);
};

/**
 * Replaces how a 401 navigates (the app installs a router-aware handler). Returns a restore function.
 */
export function setUnauthorizedHandler(handler: UnauthorizedHandler): () => void {
  const previous = unauthorizedHandler;
  unauthorizedHandler = handler;
  return () => {
    unauthorizedHandler = previous;
  };
}

/** True for paths served by the requester portal. */
export function isPortalPath(pathname: string): boolean {
  return pathname === '/portal' || pathname.startsWith('/portal/');
}

/**
 * Sign-in route for wherever the user is: `/portal/login` inside the portal, `/login` elsewhere, with a
 * `next` parameter that brings them back.
 */
export function loginPathFor(location: { pathname: string; search?: string }): string {
  const base = isPortalPath(location.pathname) ? '/portal/login' : '/login';
  if (location.pathname === base) return base;
  return `${base}?next=${encodeURIComponent(`${location.pathname}${location.search ?? ''}`)}`;
}

/** Accepts only same-origin relative paths as post-login destinations (no open redirects). */
export function safeNextPath(next: string | null | undefined, fallback: string): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}

function withQuery(path: string, query: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== null && v !== undefined) params.append(k, String(v));
  }
  const qs = params.toString();
  if (!qs) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${qs}`;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function pickString(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === 'string' && v.trim() !== '') return v;
  return undefined;
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    const text = await res.text();
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const nested = (obj.error && typeof obj.error === 'object' ? obj.error : {}) as Record<string, unknown>;
  const code = pickString(nested.code, obj.code) ?? `http_${res.status}`;
  const message =
    pickString(
      nested.message,
      obj.message,
      typeof obj.error === 'string' ? obj.error : undefined,
      res.statusText,
    ) ?? 'Request failed';
  return new ApiError(res.status, code, message, nested.details ?? obj.details);
}

async function request<T>(
  method: string,
  path: string,
  body: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    // Forces a CORS preflight for any cross-site attempt to drive the cookie session.
    'X-Requested-With': 'aoc-web',
    ...opts.headers,
  };
  let payload: string | undefined;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(withQuery(path, opts.query), {
      method,
      headers,
      body: payload,
      credentials: 'include',
      signal: opts.signal,
    });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new ApiError(0, 'network_error', 'Network request failed', err);
  }

  if (res.status === 401 && opts.redirectOn401 !== false) {
    unauthorizedHandler(loginPathFor(window.location));
  }
  if (!res.ok) throw await toApiError(res);
  if (res.status === 204 || res.status === 205) return undefined as T;

  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, 'invalid_json', 'The server returned a response that is not JSON');
  }
}

/** GET → parsed JSON. */
export function apiGet<T>(path: string, opts?: RequestOptions): Promise<T> {
  return request<T>('GET', path, undefined, opts);
}

/** POST a JSON body → parsed JSON (undefined for 204). */
export function apiPost<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  return request<T>('POST', path, body, opts);
}

/** PUT a JSON body → parsed JSON. */
export function apiPut<T>(path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  return request<T>('PUT', path, body, opts);
}

/** DELETE → parsed JSON (usually undefined). */
export function apiDelete<T>(path: string, opts?: RequestOptions): Promise<T> {
  return request<T>('DELETE', path, undefined, opts);
}
