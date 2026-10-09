import { randomBytes } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { INGEST_PATHS, type AocConfig } from '@aoc/contracts';
import { HttpError, type AppEnv } from '@aoc/kernel';

type Ctx = Context<AppEnv>;

/** media-src blob: lets the intake portal preview a video before upload; object-src 'none' closes plugins. */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

/** Capture stays available to our own pages (intake bug recordings); the rest is off. */
export const PERMISSIONS_POLICY =
  'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=()';

export const JSON_BODY_LIMIT = 1024 * 1024;
/** A spool flush replays up to 100 buffered ingest requests in one body. */
export const SPOOL_BODY_LIMIT = 16 * JSON_BODY_LIMIT;
export const INTAKE_UPLOAD_PATH = '/portal/api/intakes';

const API_PREFIXES = ['/api', '/ingest', '/portal/api'];

export function isApiPath(path: string): boolean {
  return API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Max request body for a path: intake uploads up to the video cap (+1 MiB for the multipart envelope), JSON 1 MiB. */
export function bodyLimitFor(path: string, config: AocConfig): number {
  if (path === INTAKE_UPLOAD_PATH || path.startsWith(`${INTAKE_UPLOAD_PATH}/`))
    return config.intake.maxVideoBytes + JSON_BODY_LIMIT;
  if (path === INGEST_PATHS.spool) return SPOOL_BODY_LIMIT;
  return JSON_BODY_LIMIT;
}

/** Security headers on every response (handlers may set a stricter value first). No CORS headers, ever. */
export function securityHeaders(config: AocConfig): MiddlewareHandler<AppEnv> {
  const always: [string, string][] = [
    ['content-security-policy', CONTENT_SECURITY_POLICY],
    ['x-content-type-options', 'nosniff'],
    ['referrer-policy', 'no-referrer'],
    ['permissions-policy', PERMISSIONS_POLICY],
    ['x-frame-options', 'DENY'],
    ['cross-origin-opener-policy', 'same-origin'],
    ['cross-origin-resource-policy', 'same-origin'],
  ];
  if (config.publicUrl.startsWith('https://')) always.push(['strict-transport-security', 'max-age=31536000']);
  return async (c, next) => {
    await next();
    setMissingHeaders(c, isApiPath(c.req.path) ? [...always, ['cache-control', 'no-store']] : always);
  };
}

/** Echo the request id the runtime assigned (x-request-id in, or generated) on the response. */
export function requestId(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('requestId', randomBytes(6).toString('hex'));
    await next();
    setMissingHeaders(c, [['x-request-id', c.get('requestId')]]);
  };
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Cookie-authenticated writes must come from our own origin. Bearer requests (CLI, hooks, sidecar)
 * are not ambient credentials, so they are not checked.
 */
export function csrfGuard(config: AocConfig): MiddlewareHandler<AppEnv> {
  const trusted = new Set(
    [originOf(config.publicUrl), originOf(config.identity.origin)].filter((o): o is string => !!o),
  );
  return async (c, next) => {
    if (
      UNSAFE_METHODS.has(c.req.method) &&
      !c.req.header('authorization') &&
      /(?:^|;\s*)aoc_session=/.test(c.req.header('cookie') ?? '')
    ) {
      const origin = c.req.header('origin');
      const crossOrigin = origin !== undefined && origin !== originOf(c.req.url) && !trusted.has(origin);
      if (crossOrigin || c.req.header('sec-fetch-site') === 'cross-site') {
        throw new HttpError(403, 'cross_site_request', 'Cross-site request refused');
      }
    }
    await next();
  };
}

/**
 * Enforce bodyLimitFor() without buffering: a declared Content-Length is checked up front; a chunked
 * body is counted as the handler reads it, and the response becomes 413 if the limit was crossed.
 */
export function bodyLimit(config: AocConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    const max = bodyLimitFor(c.req.path, config);
    // Decide on the declared length before touching req.body: materialising node-server's body
    // stream keeps it from draining the unread rest after the response.
    const declared = c.req.header('content-length');
    if (declared !== undefined && !c.req.header('transfer-encoding')) {
      return Number(declared) > max ? payloadTooLarge(max) : next();
    }
    const body = c.req.raw.body;
    if (!body) return next();
    let seen = 0;
    let exceeded = false;
    const counted = body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          seen += chunk.byteLength;
          if (seen > max) {
            exceeded = true;
            ctl.error(new HttpError(413, 'payload_too_large', `Request body exceeds ${max} bytes`));
          } else ctl.enqueue(chunk);
        },
      }),
    );
    c.req.raw = new Request(c.req.raw, { body: counted, duplex: 'half' } as RequestInit);
    await next();
    // Whatever the handler made of the failed read, the answer is 413.
    if (exceeded) c.res = payloadTooLarge(max);
  };
}

/** The rest of the body stays unread, so the connection must not be reused for another request. */
function payloadTooLarge(max: number): Response {
  return new Response(
    JSON.stringify({ error: { code: 'payload_too_large', message: `Request body exceeds ${max} bytes` } }),
    {
      status: 413,
      headers: { 'content-type': 'application/json', connection: 'close' },
    },
  );
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function setMissingHeaders(c: Ctx, entries: [string, string][]): void {
  const missing = entries.filter(([k]) => !c.res.headers.has(k));
  if (!missing.length) return;
  try {
    for (const [k, v] of missing) c.res.headers.set(k, v);
  } catch {
    // Immutable headers (e.g. Response.redirect): re-wrap once.
    const res = new Response(c.res.body, c.res);
    for (const [k, v] of missing) res.headers.set(k, v);
    c.res = res;
  }
}
