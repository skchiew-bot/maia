/** Operator API for managed sessions. Agents never reach these routes: ingest tokens do not authenticate /api. */
import { z } from 'zod';
import { hasPermission, type Actor } from '@aoc/contracts';
import { HttpError, readJson, requirePermission, requireUser, type App, type Ctx } from '@aoc/kernel';
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

  app.post('/api/threads/:id/rollover', async (c) => {
    requireDriverRole(c);
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

/**
 * Who may drive sessions at all, decided before any lookup: anonymous callers get 401 and people without the
 * permission 403 whether or not the id exists, so these routes are no oracle for which sessions and threads there are.
 */
function requireDriverRole(c: Ctx): void {
  const { user } = requireUser(c);
  if (!hasPermission(user.role, 'session.drive_any', user.flags) && !hasPermission(user.role, 'session.drive_own', user.flags))
    throw new HttpError(403, 'forbidden', 'Missing permission session.drive_own');
}

function driver(c: Ctx, sup: Supervisor): { sessionId: string; actor: Actor } {
  requireDriverRole(c);
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
