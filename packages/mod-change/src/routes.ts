/** HTTP API for change control, rollback, break-glass, promotion, provenance and the governance lens. */
import { z } from 'zod';
import { CHANGE_FIELDS, CHANGE_SCOPES, zId, type ChangeField } from '@aoc/contracts';
import { HttpError, parseQuery, readJson, requirePermission, type App, type Ctx } from '@aoc/kernel';
import type { ChangeEngine } from './engine';

const ref = z.string().trim().min(1).max(200);
const CreateChange = z.object({
  projectId: zId,
  scope: z.enum(CHANGE_SCOPES),
  title: z.string().trim().min(3).max(200),
  sessionId: zId.nullish(),
});
const AffirmField = z.object({
  value: z.string().max(8000),
  dwellMs: z.number().finite().min(0).max(86_400_000),
  rollbackRef: ref.optional(),
});
const StartChange = z.object({ sessionId: zId });
const CompleteChange = z.object({ ref: ref.optional() });
const RequestRollback = z.object({
  projectId: zId,
  targetRef: ref,
  changeId: zId.nullish(),
  reason: z.string().trim().min(3).max(4000),
});
const InvokeBreakglass = z.object({
  projectId: zId,
  ref,
  justification: z.string().trim().min(10).max(8000),
});
const RequestPromotion = z.object({
  projectId: zId,
  fromRef: ref,
  ticketId: zId.nullish(),
  changeId: zId.nullish(),
});
const ProvenanceQuery = z.object({ projectId: zId, sha: ref });
const ListQuery = z.object({
  projectId: zId.optional(),
  status: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const AffirmRateQuery = z.object({ projectId: zId.optional() });

function found<T>(value: T | null, what: string): T {
  if (value === null) throw new HttpError(404, `${what}_not_found`, `Unknown ${what}`);
  return value;
}

/** Body is optional for this endpoint (an empty request means "use the defaults"). */
async function readOptionalJson<T>(c: Ctx, schema: z.ZodType<T>): Promise<T> {
  const text = await c.req.text();
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'bad_json', 'Request body must be JSON');
    }
  }
  const r = schema.safeParse(body);
  if (!r.success)
    throw new HttpError(
      422,
      'invalid',
      'Validation failed',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  return r.data;
}

const isField = (f: string): f is ChangeField => (CHANGE_FIELDS as readonly string[]).includes(f);

export function mountChangeRoutes(app: App, engine: ChangeEngine): void {
  // ── change records ──
  app.post('/api/changes', async (c) => {
    const auth = requirePermission(c, 'change.create');
    return c.json(await engine.createChange(await readJson(c, CreateChange), auth.user), 201);
  });
  app.get('/api/changes', (c) => {
    requirePermission(c, 'audit.view');
    return c.json({ items: engine.read.changes(parseQuery(c, ListQuery)) });
  });
  app.get('/api/changes/:id', (c) => {
    requirePermission(c, 'audit.view');
    return c.json(found(engine.read.changeDto(c.req.param('id')), 'change'));
  });
  app.post('/api/changes/:id/fields/:field', async (c) => {
    const auth = requirePermission(c, 'change.create');
    const field = c.req.param('field');
    if (!isField(field)) throw new HttpError(404, 'unknown_field', `Fields are ${CHANGE_FIELDS.join(', ')}`);
    return c.json(engine.affirmField(c.req.param('id'), field, await readJson(c, AffirmField), auth.user));
  });
  app.post('/api/changes/:id/submit', (c) => {
    const auth = requirePermission(c, 'change.create');
    return c.json(engine.submit(c.req.param('id'), auth.user));
  });
  app.post('/api/changes/:id/start', async (c) => {
    const auth = requirePermission(c, 'change.create');
    return c.json(engine.start(c.req.param('id'), (await readJson(c, StartChange)).sessionId, auth.user));
  });
  app.post('/api/changes/:id/complete', async (c) => {
    const auth = requirePermission(c, 'change.create');
    return c.json(
      engine.complete(c.req.param('id'), auth.user, (await readOptionalJson(c, CompleteChange)).ref),
    );
  });

  // Portfolio governance lens for approvers — not a ranking (§14).
  app.get('/api/governance/affirm-rate', (c) => {
    requirePermission(c, 'gate.approve');
    return c.json(engine.affirmRate(parseQuery(c, AffirmRateQuery).projectId));
  });

  // ── rollback ──
  app.post('/api/rollbacks', async (c) => {
    const auth = requirePermission(c, 'rollback.request');
    return c.json(engine.requestRollback(await readJson(c, RequestRollback), auth.user), 202);
  });
  app.get('/api/rollbacks', (c) => {
    requirePermission(c, 'audit.view');
    return c.json({ items: engine.read.rollbacks(parseQuery(c, ListQuery)) });
  });
  app.get('/api/rollbacks/:id', (c) => {
    requirePermission(c, 'audit.view');
    return c.json(found(engine.read.rollbackDto(c.req.param('id')), 'rollback'));
  });

  // ── break-glass ──
  app.post('/api/breakglass', async (c) => {
    const auth = requirePermission(c, 'breakglass.invoke');
    return c.json(engine.invokeBreakglass(await readJson(c, InvokeBreakglass), auth.user), 202);
  });
  app.get('/api/breakglass', (c) => {
    requirePermission(c, 'audit.view');
    return c.json({ items: engine.read.breakglasses(parseQuery(c, ListQuery)) });
  });
  app.get('/api/breakglass/:id', (c) => {
    requirePermission(c, 'audit.view');
    return c.json(found(engine.read.breakglassDto(c.req.param('id')), 'breakglass'));
  });

  // ── promotion & provenance ──
  app.post('/api/promotions', async (c) => {
    const auth = requirePermission(c, 'promotion.request');
    const r = await engine.requestPromotion(await readJson(c, RequestPromotion), {
      kind: 'human',
      id: auth.user.id,
    });
    const promotion = engine.promotionDto(r.promotionId);
    if (r.refused)
      throw new HttpError(
        422,
        'promotion_refused',
        `Promotion refused: ${promotion?.refusal?.reason ?? 'refused'}`,
        { promotion, reasons: r.refused },
      );
    return c.json(promotion, 202);
  });
  app.get('/api/promotions', (c) => {
    requirePermission(c, 'audit.view');
    return c.json({ items: engine.read.promotions(parseQuery(c, ListQuery)) });
  });
  app.get('/api/promotions/:id', (c) => {
    requirePermission(c, 'audit.view');
    return c.json(found(engine.read.promotionDto(c.req.param('id')), 'promotion'));
  });
  app.get('/api/provenance', (c) => {
    requirePermission(c, 'audit.view');
    const q = parseQuery(c, ProvenanceQuery);
    return c.json(engine.provenanceDetail(q.projectId, q.sha));
  });
}
