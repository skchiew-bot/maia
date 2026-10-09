/**
 * Operator API for managed sessions. Agents never reach these routes: ingest tokens do not authenticate /api.
 * The one door an agent has into this module is the push gateway (git smart HTTP under /ingest/git, R-02).
 */
import { z } from 'zod';
import { INGEST_GIT_PREFIX, hasPermission, type Actor } from '@aoc/contracts';
import { HttpError, readJson, requireIngest, requirePermission, requireUser, type App, type Ctx } from '@aoc/kernel';
import { GatewayError, advertisementError } from './push-gateway';
import { LaunchBodySchema, type Supervisor } from './supervisor';

const TextBody = z.object({ text: z.string().trim().min(1).max(20_000) }).strict();
const StopBody = z
  .object({ immediate: z.boolean().optional(), reason: z.string().max(2000).optional() })
  .strict();

export function registerSupervisorRoutes(app: App, sup: Supervisor): void {
  app.post('/api/sessions', async (c) => {
    const auth = requirePermission(c, 'session.launch');
    const body = await readJson(c, LaunchBodySchema);
    const r = await sup.launch(body, { kind: 'human', id: auth.user.id });
    return c.json(r, 201);
  });

  app.get('/api/sessions/:id/output', (c) => {
    requirePermission(c, 'session.view');
    const sessionId = c.req.param('id');
    const items = sup.output(sessionId);
    if (!items) throw new HttpError(404, 'not_found', 'Not a managed session');
    return c.json({ sessionId, items });
  });

  app.post('/api/sessions/:id/prompt', async (c) => {
    const { sessionId, actor } = driver(c, sup);
    const { text } = await readJson(c, TextBody);
    await sup.resume(sessionId, text, 'operator_prompt', actor);
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/nudge', async (c) => {
    const { sessionId, actor } = driver(c, sup);
    const { text } = await readJson(c, TextBody);
    await sup.nudge(sessionId, text, actor);
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/restart', async (c) => {
    const { sessionId, actor } = driver(c, sup);
    await sup.restart(sessionId, actor);
    return c.json({ ok: true });
  });

  app.post('/api/sessions/:id/stop', async (c) => {
    const { sessionId, actor } = driver(c, sup);
    const body = (await c.req.text()).trim() ? await readJson(c, StopBody) : {};
    await sup.stop(sessionId, body.immediate ?? false, actor, body.reason);
    return c.json({ ok: true });
  });

  // ── push gateway: `git push aoc …` from a managed session (R-02) ───────────
  app.get(`${INGEST_GIT_PREFIX}:repo/info/refs`, async (c) => {
    const sessionId = gatewaySession(c);
    const service = c.req.query('service');
    if (service !== 'git-receive-pack' && service !== 'git-upload-pack')
      throw new HttpError(403, 'push_only', 'The gateway speaks git smart HTTP and accepts pushes only');
    let body: Buffer;
    if (service === 'git-upload-pack') body = advertisementError('aoc: the gateway accepts pushes only; fetch from your project repository', service);
    else
      try {
        body = await sup.gateway.advertise(sessionId, c.req.param('repo'));
      } catch (err) {
        // Shown by git as "fatal: remote error: …", so the model reads why instead of a bare 403.
        if (err instanceof GatewayError && err.status !== 503) body = advertisementError(err.message, service);
        else throw gatewayFailure(c, err);
      }
    return c.body(new Uint8Array(body), 200, {
      'content-type': `application/x-${service}-advertisement`,
      'cache-control': 'no-cache',
    });
  });

  app.post(`${INGEST_GIT_PREFIX}:repo/git-receive-pack`, async (c) => {
    const sessionId = gatewaySession(c);
    if (c.req.header('content-type') !== 'application/x-git-receive-pack-request')
      throw new HttpError(415, 'unsupported_media', 'Expected application/x-git-receive-pack-request');
    let result: Buffer;
    try {
      result = await sup.gateway.receive(sessionId, c.req.param('repo'), pushBody(c));
    } catch (err) {
      throw gatewayFailure(c, err);
    }
    return c.body(new Uint8Array(result), 200, {
      'content-type': 'application/x-git-receive-pack-result',
      'cache-control': 'no-cache',
    });
  });

  app.post('/api/threads/:id/rollover', async (c) => {
    const threadId = c.req.param('id');
    const writer = sup.writerOf(threadId);
    if (!writer) throw new HttpError(404, 'not_found', 'No managed writer session on this thread');
    const actor = authorizeDrive(c, writer.ownerId);
    const r = await sup.rollover(threadId, actor);
    if ('refused' in r)
      throw new HttpError(409, 'rollover_refused', 'Rollover refused', { problems: r.refused });
    return c.json(r);
  });
}

/** The session behind a gateway request: only a managed session's own ingest token pushes (never an observer's). */
function gatewaySession(c: Ctx): string {
  const p = requireIngest(c, { allowObserver: false, allowSystem: false });
  if (p.kind !== 'session') throw new HttpError(403, 'forbidden', 'Only a managed session pushes through the gateway');
  return p.sessionId;
}

/** The request body as git sent it; gzip is undone here, and the unpacked size is bounded by receive.maxInputSize. */
function pushBody(c: Ctx): ReadableStream<Uint8Array> | null {
  const body = c.req.raw.body;
  const encoding = (c.req.header('content-encoding') ?? 'identity').toLowerCase();
  if (encoding === 'identity') return body;
  if (encoding !== 'gzip') throw new HttpError(415, 'unsupported_encoding', `Content-Encoding ${encoding} is not supported`);
  return body ? body.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>) : null;
}

function gatewayFailure(c: Ctx, err: unknown): unknown {
  if (!(err instanceof GatewayError)) return err;
  if (err.retryAfterMs) c.header('retry-after', String(Math.max(1, Math.ceil(err.retryAfterMs / 1000))));
  return new HttpError(err.status, 'git_gateway', err.message);
}

function driver(c: Ctx, sup: Supervisor): { sessionId: string; actor: Actor } {
  const sessionId = c.req.param('id') ?? '';
  const s = sup.session(sessionId);
  if (!s) throw new HttpError(404, 'not_found', 'Not a managed session');
  return { sessionId, actor: authorizeDrive(c, s.ownerId) };
}

/** Owners drive their own sessions with session.drive_own; anyone else needs session.drive_any. */
function authorizeDrive(c: Ctx, ownerId: string | null): Actor {
  const { user } = requireUser(c);
  const own = ownerId !== null && ownerId === user.id;
  const ok =
    hasPermission(user.role, 'session.drive_any', user.flags) ||
    (own && hasPermission(user.role, 'session.drive_own', user.flags));
  if (!ok)
    throw new HttpError(
      403,
      'forbidden',
      own ? 'Missing permission session.drive_own' : 'Missing permission session.drive_any',
    );
  return { kind: 'human', id: user.id };
}
