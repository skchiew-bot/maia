import { z } from 'zod';
import {
  AOC_MCP_TOOLS,
  INGEST_PATHS,
  type Actor,
  type AuthContext,
  type McpErrorResult,
} from '@aoc/contracts';
import {
  EventValidationError,
  HttpError,
  readJson,
  requireIngest,
  requirePermission,
  type App,
  type Ctx,
} from '@aoc/kernel';
import { LedgerError, type LedgerCore } from './core';
import { amendPlan, declarePlan, getStatus, playbookStep, taskDone } from './mcp-handlers';
import { createProject, createThread, recordEnhancement, updateProject } from './projects';
import { projectHistory, projectRollups } from './rollup';
import { projectTimeline, sessionTimeline } from './timeline';
import { projectDetail, projectSummary, threadDetail, threadSummary } from './views';

const ProjectBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().max(2000).optional(),
    repoPath: z.string().min(1).max(1000).optional(),
    defaultBranch: z.string().min(1).max(200).optional(),
  })
  .strict();
const ProjectPatch = ProjectBody.partial().refine((b) => Object.keys(b).length > 0, 'Nothing to update');
const ThreadBody = z.object({ title: z.string().trim().min(1).max(200) }).strict();
const EnhancementBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    detail: z.string().max(4000).optional(),
    sessionId: z.string().min(1).max(64).optional(),
    changeId: z.string().min(1).max(64).optional(),
  })
  .strict();
const McpEnvelope = z.object({ sessionId: z.string().min(1).max(64), input: z.unknown() });

const ERROR_CODE: Record<LedgerError['status'], string> = {
  400: 'bad_request',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  422: 'invalid',
};

const human = (auth: AuthContext): Actor => ({ kind: 'human', id: auth.user.id });
const issues = (e: z.ZodError) => e.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));

/** API routes render domain errors with the standard envelope. */
function api(handler: (c: Ctx) => Response | Promise<Response>) {
  return async (c: Ctx) => {
    try {
      return await handler(c);
    } catch (err) {
      if (err instanceof LedgerError)
        throw new HttpError(err.status, ERROR_CODE[err.status], err.message, err.details);
      throw err;
    }
  };
}

/** MCP routes always answer with the contracts' result types, or McpErrorResult. */
function mcpError(c: Ctx, err: unknown): Response {
  const body = (error: string, details?: unknown): McpErrorResult => ({
    ok: false,
    error,
    ...(details !== undefined ? { details } : {}),
  });
  if (err instanceof LedgerError) return c.json(body(err.message, err.details), err.status);
  if (err instanceof HttpError) return c.json(body(err.message, { code: err.code }), err.status);
  if (err instanceof EventValidationError) return c.json(body(err.message, err.problems), 422);
  throw err;
}

type LedgerMcpTool = 'declare_plan' | 'amend_plan' | 'task_done' | 'playbook_step' | 'get_status';

export function mountLedgerRoutes(app: App, core: LedgerCore): void {
  // ── MCP ingest (session token; the token's session must be the body's session) ──
  const mcp: {
    [K in LedgerMcpTool]: (
      sessionId: string,
      input: z.infer<(typeof AOC_MCP_TOOLS)[K]['input']>,
    ) => object | Promise<object>;
  } = {
    declare_plan: (s, i) => declarePlan(core, s, i),
    amend_plan: (s, i) => amendPlan(core, s, i),
    task_done: (s, i) => taskDone(core, s, i),
    playbook_step: (s, i) => playbookStep(core, s, i),
    get_status: (s) => getStatus(core, s),
  };
  for (const tool of Object.keys(mcp) as LedgerMcpTool[]) {
    app.post(INGEST_PATHS.mcp(tool), async (c) => {
      try {
        if (!c.get('ingest')) throw new HttpError(401, 'unauthenticated', 'Ingest token required');
        let raw: unknown;
        try {
          raw = await c.req.json();
        } catch {
          throw new LedgerError(400, 'Request body must be JSON');
        }
        const env = McpEnvelope.safeParse(raw);
        if (!env.success) throw new LedgerError(422, 'Body must be { sessionId, input }', issues(env.error));
        requireIngest(c, { sessionId: env.data.sessionId, allowSystem: false });
        const input = AOC_MCP_TOOLS[tool].input.safeParse(env.data.input ?? {});
        if (!input.success) throw new LedgerError(422, `Invalid ${tool} input`, issues(input.error));
        return c.json(await mcp[tool](env.data.sessionId, input.data as never), 200);
      } catch (err) {
        return mcpError(c, err);
      }
    });
  }

  // ── projects ───────────────────────────────────────────────────────────────
  const projectOr404 = (id: string | undefined) => {
    const row = id ? core.read.project(id) : null;
    if (!row) throw new HttpError(404, 'not_found', `Unknown project ${id ?? ''}`);
    return row;
  };

  app.get('/api/projects', (c) => {
    requirePermission(c, 'session.view');
    return c.json(core.read.projects().map((p) => projectSummary(core, p)));
  });

  app.post(
    '/api/projects',
    api(async (c) => {
      const auth = requirePermission(c, 'project.manage');
      const body = await readJson(c, ProjectBody);
      return c.json(projectDetail(core, createProject(core, body, human(auth))), 201);
    }),
  );

  // Registered before /api/projects/:id so the static segment is not read as a project id.
  app.get('/api/projects/rollup', (c) => {
    requirePermission(c, 'session.view');
    return c.json(projectRollups(core));
  });

  app.get('/api/projects/:id', (c) => {
    requirePermission(c, 'session.view');
    return c.json(projectDetail(core, projectOr404(c.req.param('id'))));
  });

  app.patch(
    '/api/projects/:id',
    api(async (c) => {
      const auth = requirePermission(c, 'project.manage');
      const id = projectOr404(c.req.param('id')).project_id;
      const body = await readJson(c, ProjectPatch);
      return c.json(projectDetail(core, updateProject(core, id, body, human(auth))));
    }),
  );

  app.get('/api/projects/:id/timeline', (c) => {
    requirePermission(c, 'session.view');
    const timeline = projectTimeline(core, projectOr404(c.req.param('id')).project_id);
    return c.json(timeline);
  });

  app.get('/api/projects/:id/history', (c) => {
    requirePermission(c, 'session.view');
    return c.json(projectHistory(core, projectOr404(c.req.param('id')).project_id));
  });

  app.post(
    '/api/projects/:id/threads',
    api(async (c) => {
      const auth = requirePermission(c, 'project.manage');
      const id = projectOr404(c.req.param('id')).project_id;
      const body = await readJson(c, ThreadBody);
      return c.json(threadSummary(createThread(core, id, body.title, human(auth))), 201);
    }),
  );

  app.post(
    '/api/projects/:id/enhancements',
    api(async (c) => {
      const auth = requirePermission(c, 'project.manage');
      const id = projectOr404(c.req.param('id')).project_id;
      const body = await readJson(c, EnhancementBody);
      return c.json(recordEnhancement(core, id, body, human(auth)), 201);
    }),
  );

  // ── threads & sessions ─────────────────────────────────────────────────────
  app.get('/api/threads/:id', (c) => {
    requirePermission(c, 'session.view');
    const t = core.read.thread(c.req.param('id'));
    if (!t) throw new HttpError(404, 'not_found', `Unknown thread ${c.req.param('id')}`);
    return c.json(threadDetail(core, t));
  });

  app.get('/api/sessions/:id/timeline', (c) => {
    requirePermission(c, 'session.view');
    const timeline = sessionTimeline(core, c.req.param('id'));
    if (!timeline) throw new HttpError(404, 'not_found', `Unknown session ${c.req.param('id')}`);
    return c.json(timeline);
  });
}
