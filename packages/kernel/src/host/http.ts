import type { Context } from 'hono';
import type { z } from 'zod';
import type { AocConfig, AuthContext, IngestPrincipal, Permission } from '@aoc/contracts';
import { hasPermission, INGEST_GIT_PREFIX, INGEST_PATHS, MAX_PUSH_BYTES } from '@aoc/contracts';
import { EventValidationError } from '../store/event-store';
import type { AppEnv } from './module';

export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 415 | 422 | 423 | 429 | 500 | 502 | 503,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export type Ctx = Context<AppEnv>;

export function requireUser(c: Ctx): AuthContext {
  const auth = c.get('auth');
  if (!auth) throw new HttpError(401, 'unauthenticated', 'Sign in required');
  return auth;
}

export function requirePermission(c: Ctx, perm: Permission): AuthContext {
  const auth = requireUser(c);
  if (!hasPermission(auth.user.role, perm, auth.user.flags)) throw new HttpError(403, 'forbidden', `Missing permission ${perm}`);
  return auth;
}

/**
 * Ingest auth: session (and sidecar) tokens may only write for their own session; observer tokens only observed
 * events. A sidecar token is refused unless the route asks for it (`allowSidecar`): it never posts hooks or MCP calls.
 */
export function requireIngest(
  c: Ctx,
  opts: { sessionId?: string | null; allowObserver?: boolean; allowSystem?: boolean; allowSidecar?: boolean } = {},
): IngestPrincipal {
  const p = c.get('ingest');
  if (!p) throw new HttpError(401, 'unauthenticated', 'Ingest token required');
  if (p.kind === 'session' || (p.kind === 'sidecar' && opts.allowSidecar)) {
    if (opts.sessionId && opts.sessionId !== p.sessionId) throw new HttpError(403, 'forbidden', 'Token not valid for this session');
    return p;
  }
  if (p.kind === 'observer' && opts.allowObserver) return p;
  if (p.kind === 'system' && (opts.allowSystem ?? true)) return p;
  throw new HttpError(403, 'forbidden', 'Token kind not allowed here');
}

/** Parsed body as the schema's output type (defaults and transforms applied, and typed so). */
export async function readJson<S extends z.ZodTypeAny>(c: Ctx, schema: S): Promise<z.output<S>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (err) {
    if (err instanceof HttpError) throw err; // e.g. the body cap tripped mid-read
    throw new HttpError(400, 'bad_json', 'Request body must be JSON');
  }
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(422, 'invalid', 'Validation failed', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

/** Parsed query string as the schema's output type (defaults and transforms applied, and typed so). */
export function parseQuery<S extends z.ZodTypeAny>(c: Ctx, schema: S): z.output<S> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw new HttpError(422, 'invalid', 'Invalid query', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
}

/** Standard JSON error envelope: { error: { code, message, details? } }. */
export function errorResponse(err: unknown, c: Ctx): Response {
  if (err instanceof HttpError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  if (err instanceof EventValidationError) {
    return c.json({ error: { code: 'invalid_event', message: err.message, details: err.problems } }, 422);
  }
  return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
}

const MiB = 1024 * 1024;
/** Request-body caps (bytes). The spool carries batches of hook bodies; hook bodies carry tool input/output. */
export const MAX_BODY_BYTES = {
  spool: 64 * MiB,
  ingest: 16 * MiB,
  /** A session's push through the supervisor's gateway carries a git pack. */
  push: MAX_PUSH_BYTES,
  api: 4 * MiB,
  formOverhead: MiB,
} as const;

/**
 * Cap for a request path, enforced before authentication or any parsing so an anonymous client cannot make the
 * sole-writer daemon buffer an unbounded body. Intake uploads get the configured attachment allowance (§7).
 */
export function bodyLimitFor(path: string, config: AocConfig): number {
  if (path === INGEST_PATHS.spool) return MAX_BODY_BYTES.spool;
  if (path.startsWith(INGEST_GIT_PREFIX)) return MAX_BODY_BYTES.push;
  if (path.startsWith('/ingest/')) return MAX_BODY_BYTES.ingest;
  if (path.startsWith('/portal/')) {
    const i = config.intake;
    return i.maxAttachments * Math.max(i.maxImageBytes, i.maxVideoBytes) + MAX_BODY_BYTES.formOverhead;
  }
  return MAX_BODY_BYTES.api;
}

/**
 * Enforce a body cap without reading the body: a declared Content-Length is checked up front (Node never delivers
 * more than it declares); a chunked body is counted while the route reads it. Nothing is buffered on behalf of a
 * caller that auth or the route goes on to refuse.
 */
export function capRequestBody(c: Ctx, maxSize: number): void {
  const raw = c.req.raw;
  if (!raw.body) return;
  const tooLarge = () => new HttpError(413, 'payload_too_large', `Request body exceeds ${maxSize} bytes`);
  const declared = raw.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && !raw.headers.has('transfer-encoding')) {
    if (Number(declared) > maxSize) throw tooLarge();
    return;
  }
  let seen = 0;
  const counted = raw.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxSize) controller.error(tooLarge());
        else controller.enqueue(chunk);
      },
    }),
  );
  c.req.raw = new Request(raw, { body: counted, duplex: 'half' } as RequestInit);
}

/** Extract the bearer token from Authorization or the aoc_session cookie. */
export function tokenFrom(c: Ctx): { token: string; method: 'bearer' | 'cookie' } | null {
  const h = c.req.header('authorization');
  if (h?.toLowerCase().startsWith('bearer ')) return { token: h.slice(7).trim(), method: 'bearer' };
  const cookie = c.req.header('cookie');
  const m = cookie?.match(/(?:^|;\s*)aoc_session=([^;]+)/);
  if (m) return { token: decodeURIComponent(m[1]!), method: 'cookie' };
  return null;
}
