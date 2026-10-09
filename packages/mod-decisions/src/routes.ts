import { z } from 'zod';
import {
  DECISION_KINDS,
  DECISION_STATUSES,
  INGEST_PATHS,
  ROLE_LABEL,
  RequestDecisionInput,
  type DecisionCard,
  type DecisionListResponse,
  type RequestDecisionResult,
} from '@aoc/contracts';
import {
  HttpError,
  readJson,
  requireIngest,
  requirePermission,
  type App,
  type Ctx,
  type ModuleContext,
} from '@aoc/kernel';
import type { DecisionEngine } from './engine';

const blank = (v: unknown) => (v === '' ? undefined : v);

/** Comma-separated enum list; an empty value means "no filter". */
const csv = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    (v) => {
      if (typeof v !== 'string') return v;
      const parts = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return parts.length ? parts : undefined;
    },
    z.array(z.enum(values)).optional(),
  );

const optionalRef = z.preprocess(blank, z.string().max(64).optional());

const ListQuery = z.object({
  status: csv(DECISION_STATUSES),
  kind: csv(DECISION_KINDS),
  sessionId: optionalRef,
  projectId: optionalRef,
  subjectId: optionalRef,
  mine: z.preprocess(blank, z.enum(['1', '0', 'true', 'false']).optional()),
  limit: z.preprocess(blank, z.coerce.number().int().min(1).max(500).optional()),
});

const zLabel = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9_.:/-]+$/i, 'machine label');

const ResolveBody = z.object({
  optionId: z.string().min(1).max(64),
  comment: z.string().max(4000).nullish(),
  passkeyAssertion: z.unknown().optional(),
});
const WithdrawBody = z.object({ reason: zLabel.optional(), note: z.string().max(2000).optional() });
const EscalateBody = z.object({ reason: zLabel.optional() });
const McpEnvelope = z.object({ sessionId: z.string().min(1).max(64), input: z.unknown() });

type Issue = { path: string; message: string };
const issuesOf = (err: z.ZodError, prefix: (string | number)[] = []): Issue[] =>
  err.issues.map((i) => ({ path: [...prefix, ...i.path].join('.'), message: i.message }));

function parseWith<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(422, 'invalid', what, issuesOf(r.error));
  return r.data;
}

/** Like readJson, but an empty body counts as `{}` (withdraw / escalate take only optional fields). */
async function readOptionalJson<S extends z.ZodTypeAny>(c: Ctx, schema: S): Promise<z.output<S>> {
  const raw = await c.req.text();
  let body: unknown = {};
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, 'bad_json', 'Request body must be JSON');
    }
  }
  return parseWith(schema, body, 'Validation failed');
}

export function endTurnInstruction(card: DecisionCard): string {
  return (
    `Decision ${card.id} is waiting for a human (${ROLE_LABEL[card.requiredRole]}). END YOUR TURN NOW: ` +
    'do not call any more tools and do not continue the task. The AOC supervisor will resume this session with the answer.'
  );
}

export function mountDecisionRoutes(app: App, ctx: ModuleContext, engine: DecisionEngine): void {
  // Registered before `/:id` so "summary" is never taken for a decision id.
  app.get('/api/decisions/summary', (c) => {
    const { user } = requirePermission(c, 'decision.view');
    return c.json(engine.summary(user));
  });

  app.get('/api/decisions', (c) => {
    const { user } = requirePermission(c, 'decision.view');
    const q = parseWith(ListQuery, c.req.query(), 'Invalid query');
    const mine = q.mine === '1' || q.mine === 'true';
    const records = engine.records({
      status: q.status,
      kind: q.kind,
      sessionId: q.sessionId,
      projectId: q.projectId,
      subjectId: q.subjectId,
      resolvableBy: mine ? user : undefined,
      limit: q.limit ?? 200,
    });
    const res: DecisionListResponse = {
      generatedAt: ctx.clock.iso(),
      decisions: records.map((r) => engine.view(r, user)),
    };
    return c.json(res);
  });

  app.get('/api/decisions/:id', (c) => {
    const { user } = requirePermission(c, 'decision.view');
    return c.json(engine.view(engine.require(c.req.param('id')), user));
  });

  app.post('/api/decisions/:id/resolve', async (c) => {
    requirePermission(c, 'decision.view');
    const { user } = requirePermission(c, 'decision.resolve');
    const id = c.req.param('id');
    engine.require(id);
    const body = await readJson(c, ResolveBody);
    await engine.resolve(
      id,
      { optionId: body.optionId, comment: body.comment ?? null, passkeyAssertion: body.passkeyAssertion },
      user,
    );
    return c.json(engine.view(engine.require(id), user));
  });

  app.post('/api/decisions/:id/withdraw', async (c) => {
    const { user } = requirePermission(c, 'decision.view');
    const id = c.req.param('id');
    if (!engine.mayWithdraw(engine.require(id).card, user)) {
      throw new HttpError(
        403,
        'forbidden',
        'Only an Approver or the person the decision was raised for may withdraw it',
      );
    }
    const body = await readOptionalJson(c, WithdrawBody);
    engine.withdraw(id, body.reason ?? 'manual', { kind: 'human', id: user.id }, body.note ?? null);
    return c.json(engine.view(engine.require(id), user));
  });

  app.post('/api/decisions/:id/escalate', async (c) => {
    requirePermission(c, 'decision.view');
    const { user } = requirePermission(c, 'decision.resolve');
    const id = c.req.param('id');
    engine.require(id);
    const body = await readOptionalJson(c, EscalateBody);
    engine.escalate(
      id,
      { toRole: 'approver', reason: body.reason ?? 'manual' },
      { kind: 'human', id: user.id },
    );
    return c.json(engine.view(engine.require(id), user));
  });

  // MCP request_decision (§2.3): the waiting session ends its turn; the supervisor resumes it with the answer.
  app.post(INGEST_PATHS.mcp('request_decision'), async (c) => {
    const principal = requireIngest(c, { allowSystem: false });
    const body = await readJson(c, McpEnvelope);
    if (principal.kind !== 'session' || principal.sessionId !== body.sessionId) {
      throw new HttpError(403, 'forbidden', 'Token not valid for this session');
    }
    const parsed = RequestDecisionInput.safeParse(body.input);
    if (!parsed.success)
      throw new HttpError(422, 'invalid', 'Validation failed', issuesOf(parsed.error, ['input']));
    const input = parsed.data;
    const ids = input.options.map((o) => o.id);
    const problems: Issue[] = [];
    if (new Set(ids).size !== ids.length)
      problems.push({ path: 'input.options', message: 'option ids must be unique' });
    if (!ids.includes(input.recommendation.option_id)) {
      problems.push({
        path: 'input.recommendation.option_id',
        message: 'recommendation must name one of the options',
      });
    }
    if (problems.length) throw new HttpError(422, 'invalid', 'Validation failed', problems);
    const sessions = ctx.services.maybe('sessions');
    if (!sessions) throw new HttpError(503, 'unavailable', 'Session directory unavailable');
    const session = sessions.get(body.sessionId);
    if (!session) throw new HttpError(404, 'unknown_session', 'Unknown session');
    const card = engine.requestFromAgent(session, input);
    const res: RequestDecisionResult = {
      ok: true,
      decision_id: card.id,
      instruction: endTurnInstruction(card),
    };
    return c.json(res);
  });
}
