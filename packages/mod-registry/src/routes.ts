import { z } from 'zod';
import {
  KNOWLEDGE_KINDS,
  PLAYBOOK_RETIRE_REASONS,
  PLAYBOOK_STATUSES,
  type RegistryRunsResponse,
} from '@aoc/contracts';
import { HttpError, parseQuery, readJson, requirePermission, type App, type Ctx } from '@aoc/kernel';
import type { RegistryEngine } from './engine';

const PlaybookListQuery = z.object({
  processType: z.string().min(1).max(80).optional(),
  status: z.enum(PLAYBOOK_STATUSES).optional(),
});
const RunsQuery = z.object({
  processType: z.string().min(1).max(80).optional(),
  outcome: z.string().min(1).max(40).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const DistillBody = z.object({ sessionId: z.string().min(1).max(64) }).strict();
const RetireBody = z.object({ reason: z.enum(PLAYBOOK_RETIRE_REASONS).optional() }).strict();
const SearchQuery = z.object({
  q: z.string().trim().min(1).max(500),
  kind: z.enum(KNOWLEDGE_KINDS).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

/** Retire takes an optional body. */
async function readOptionalJson<T>(c: Ctx, schema: z.ZodType<T>): Promise<T> {
  const text = (await c.req.text()).trim();
  let body: unknown = {};
  if (text) {
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

export function registerRoutes(app: App, engine: RegistryEngine): void {
  /** Registry hero: discovery-vs-execution economics per process type, sorted by savings opportunity. */
  app.get('/api/registry', (c) => {
    requirePermission(c, 'registry.view');
    return c.json(engine.entries());
  });

  app.get('/api/registry/process-types', (c) => {
    requirePermission(c, 'registry.view');
    return c.json(engine.typesResponse());
  });

  /** Runs and economics: run chains newest first (cost, tokens, time, kind, playbook distilled from them). */
  app.get('/api/registry/runs', (c) => {
    requirePermission(c, 'registry.view');
    const q = parseQuery(c, RunsQuery);
    const body: RegistryRunsResponse = {
      runs: engine.runs({ processType: q.processType, outcome: q.outcome, limit: q.limit ?? 100 }),
    };
    return c.json(body);
  });

  app.get('/api/playbooks', (c) => {
    requirePermission(c, 'registry.view');
    return c.json(engine.listPlaybooks(parseQuery(c, PlaybookListQuery)));
  });

  app.get('/api/playbooks/:id', (c) => {
    requirePermission(c, 'registry.view');
    const pb = engine.getPlaybook(c.req.param('id'));
    if (!pb) throw new HttpError(404, 'playbook_not_found', 'No such playbook');
    return c.json(pb);
  });

  app.post('/api/playbooks/distill', async (c) => {
    const auth = requirePermission(c, 'learning.curate');
    const body = await readJson(c, DistillBody);
    return c.json(await engine.distill(body.sessionId, auth.user), 201);
  });

  app.post('/api/playbooks/:id/retire', async (c) => {
    const auth = requirePermission(c, 'learning.curate');
    const body = await readOptionalJson(c, RetireBody);
    return c.json(engine.retire(c.req.param('id'), body.reason ?? 'manual', auth.user));
  });

  /** Team knowledge layer. Internal memory: requesters never search it, whatever their permissions. */
  app.get('/api/knowledge/search', (c) => {
    const auth = requirePermission(c, 'learning.view');
    if (auth.user.role === 'requester')
      throw new HttpError(403, 'forbidden', 'The knowledge layer is internal');
    const q = parseQuery(c, SearchQuery);
    return c.json(engine.search(q.q, q.kind ?? null, q.limit ?? 20));
  });
}
