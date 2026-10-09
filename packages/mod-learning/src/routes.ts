import { z } from 'zod';
import {
  AssignRootCauseRequest,
  CreateRootCauseClassRequest,
  LESSON_SCOPE_TYPES,
  ProposeLessonRequest,
  ReportErrorInput,
  TransitionOffenceRequest,
  type Actor,
  type AuthContext,
  type MetaOf,
} from '@aoc/contracts';
import { HttpError, parseQuery, readJson, requireIngest, requirePermission, type App } from '@aoc/kernel';
import type { LearningEngine } from './engine';
import type { LearningReads } from './reads';
import { humanTransitionAllowed, unusedStreak } from './rules';

// parseQuery wants input = output types, so numbers stay strings here and are converted after validation
const intIn = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,6}$/)
    .refine((v) => Number(v) >= min && Number(v) <= max, `must be ${min}..${max}`);
const ErrorsQuery = z.object({
  classId: z.string().max(64).optional(),
  unassigned: z.enum(['1', 'true', '0', 'false']).optional(),
  limit: intIn(1, 1000).optional(),
});
const TrendsQuery = z.object({ weeks: intIn(1, 104).optional() });
const LessonsQuery = z.object({
  status: z.enum(['proposed', 'bound', 'rejected', 'retired']).optional(),
  scopeType: z.enum(LESSON_SCOPE_TYPES).optional(),
  scopeValue: z.string().max(200).optional(),
  classId: z.string().max(64).optional(),
});
/** McpIngestRequest<ReportErrorInput>, plus an optional key so MCP-server retries do not double-count. */
const ReportErrorBody = z.object({
  sessionId: z.string().min(1).max(64),
  input: ReportErrorInput,
  idempotencyKey: z.string().min(1).max(128).optional(),
});

const human = (auth: AuthContext): Actor => ({ kind: 'human', id: auth.user.id });

/** Learning console API (perm learning.view; changes need learning.curate) and the agent's report_error ingest. */
export function registerRoutes(app: App, engine: () => LearningEngine, reads: () => LearningReads): void {
  app.get('/api/learning/errors', (c) => {
    requirePermission(c, 'learning.view');
    const q = parseQuery(c, ErrorsQuery);
    return c.json(
      reads().errors({
        classId: q.classId,
        unassigned: q.unassigned === '1' || q.unassigned === 'true',
        limit: q.limit ? Number(q.limit) : undefined,
      }),
    );
  });

  app.post('/api/learning/errors/:id/root-cause', async (c) => {
    const auth = requirePermission(c, 'learning.curate');
    const body = await readJson(c, AssignRootCauseRequest);
    const eng = engine();
    const id = c.req.param('id');
    const err = eng.errorRow(id);
    if (!err) throw new HttpError(404, 'error_not_found', 'Error occurrence not found');
    if ('classId' in body) {
      if (!eng.classRow(body.classId))
        throw new HttpError(404, 'class_not_found', 'Root-cause class not found');
      if (err.class_id !== body.classId || err.assigned_by !== 'human')
        eng.assign(id, body.classId, 'human', 1, human(auth), { source: 'api' });
    } else {
      const defined = eng.classEvent(body.newClass, human(auth), { source: 'api' });
      eng.ctx.store.appendMany([
        defined,
        eng.assignEvent(id, defined.meta.classId, 'human', 1, human(auth), { source: 'api' }),
      ]);
    }
    return c.json(reads().error(id));
  });

  app.get('/api/learning/classes', (c) => {
    requirePermission(c, 'learning.view');
    return c.json(reads().classes());
  });

  app.post('/api/learning/classes', async (c) => {
    const auth = requirePermission(c, 'learning.curate');
    const body = await readJson(c, CreateRootCauseClassRequest);
    const classId = engine().defineClass(body, human(auth), { source: 'api' });
    return c.json(reads().rootCauseClass(classId), 201);
  });

  app.get('/api/learning/offences', (c) => {
    requirePermission(c, 'learning.view');
    return c.json(reads().offences());
  });

  app.post('/api/learning/offences/:id/transition', async (c) => {
    const auth = requirePermission(c, 'learning.curate');
    const body = await readJson(c, TransitionOffenceRequest);
    const eng = engine();
    const off = eng.offenceRow(c.req.param('id'));
    if (!off) throw new HttpError(404, 'offence_not_found', 'Repeat offence not found');
    if (!humanTransitionAllowed(off.state, body.to)) {
      throw new HttpError(
        409,
        'invalid_transition',
        body.to === 'verified_closed'
          ? 'verified_closed is set automatically once the verification window passes without recurrence'
          : `Cannot move a repeat offence from ${off.state} to ${body.to}`,
      );
    }
    eng.transitionOffence(off, body.to, { note: body.note, fix: body.fix }, human(auth), { source: 'api' });
    return c.json(reads().offence(off.offence_id));
  });

  app.get('/api/learning/trends', (c) => {
    requirePermission(c, 'learning.view');
    return c.json(reads().trends(Number(parseQuery(c, TrendsQuery).weeks ?? 12)));
  });

  app.get('/api/learning/model-dimension', (c) => {
    requirePermission(c, 'learning.view');
    return c.json(reads().modelDimension());
  });

  app.get('/api/learning/lessons', (c) => {
    requirePermission(c, 'learning.view');
    return c.json(reads().lessons(parseQuery(c, LessonsQuery)));
  });

  app.post('/api/learning/lessons', async (c) => {
    const auth = requirePermission(c, 'learning.curate');
    const body = await readJson(c, ProposeLessonRequest);
    const lessonId = engine().proposeLesson({ ...body, classId: body.classId ?? null }, human(auth), {
      source: 'api',
    });
    return c.json(reads().lesson(lessonId), 201);
  });

  app.post('/api/learning/lessons/:id/retire', (c) => {
    const auth = requirePermission(c, 'learning.curate');
    const eng = engine();
    const lesson = eng.lessonRow(c.req.param('id'));
    if (!lesson) throw new HttpError(404, 'lesson_not_found', 'Lesson not found');
    if (lesson.status === 'retired' || lesson.status === 'rejected')
      throw new HttpError(409, 'lesson_inactive', `Lesson is already ${lesson.status}`);
    eng.retireLesson(lesson, 'manual', unusedStreak(eng.lessonRuns(lesson, eng.runs())), human(auth), {
      source: 'api',
    });
    return c.json(reads().lesson(lesson.lesson_id));
  });

  // The agent's structured voice (§2): a repeatable error class it hit, with the fix if known.
  app.post('/ingest/mcp/report_error', async (c) => {
    const principal = requireIngest(c, { allowSystem: false });
    const body = await readJson(c, ReportErrorBody);
    if (principal.kind !== 'session' || principal.sessionId !== body.sessionId)
      throw new HttpError(403, 'forbidden', 'Token not valid for this session');
    const e = engine().recordError(
      {
        source: 'agent_report',
        sessionId: body.sessionId,
        message: body.input.summary,
        fix: body.input.fix,
        rootCauseHint: body.input.root_cause_class,
        codeArea: body.input.code_area,
        idempotencyKey: body.idempotencyKey
          ? `report_error:${body.sessionId}:${body.idempotencyKey}`
          : undefined,
      },
      { kind: 'agent', id: body.sessionId },
      'mcp',
    );
    return c.json({ ok: true, error_id: (e.meta as MetaOf<'error.observed'>).errorId });
  });
}
