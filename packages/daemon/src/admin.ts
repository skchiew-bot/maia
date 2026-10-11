import type { Hono } from 'hono';
import {
  AdminRebuildSchema,
  AdminRedriveSchema,
  AdminRunJobSchema,
  type AdminActionResultDTO,
  type AdminOutcome,
  type AdminRebuildResultDTO,
  type MetaOf,
  type StoredEvent,
} from '@aoc/contracts';
import { HttpError, readJson, requirePermission, type AocRuntime, type AppEnv } from '@aoc/kernel';

const LABEL = /^[a-z0-9_.:/-]{1,80}$/i;

/**
 * Operator actions on the runtime itself (threat model O-26), Approver only (`ops.admin`): re-drive one
 * dead-lettered reaction, rebuild named projections, run a job by name. Each appends an event naming who acted
 * (the actor), why (the payload) and how it went, after the action, so the record carries the outcome.
 */
export function mountAdmin(app: Hono<AppEnv>, runtime: AocRuntime): void {
  const record = <T extends 'admin.reactor_redriven' | 'admin.projections_rebuilt' | 'admin.job_run'>(
    type: T,
    userId: string,
    meta: Omit<MetaOf<T>, 'outcome'>,
    reason: string,
    error: string | null,
  ): StoredEvent =>
    runtime.store.append({
      type,
      actor: { kind: 'human', id: userId },
      meta: { ...meta, outcome: error === null ? 'ok' : 'failed' } as MetaOf<T>,
      payload: error === null ? { reason } : { reason, error },
      source: 'api',
    });
  const result = (e: StoredEvent, error: string | null): AdminActionResultDTO => ({
    outcome: (error === null ? 'ok' : 'failed') satisfies AdminOutcome,
    error,
    eventSeq: e.seq,
  });
  const nameParam = (raw: string, what: string): string => {
    if (!LABEL.test(raw)) throw new HttpError(400, 'bad_request', `Not a ${what} name`);
    return raw;
  };

  app.post('/api/admin/reactors/:name/redrive', async (c) => {
    const auth = requirePermission(c, 'ops.admin');
    const reactor = nameParam(c.req.param('name'), 'reactor');
    const body = await readJson(c, AdminRedriveSchema);
    const r = await runtime.redrive(reactor, body.seq);
    if (r.status === 'unknown_reactor') throw new HttpError(404, 'unknown_reactor', `No reactor named ${reactor}`);
    if (r.status === 'not_dead_lettered')
      throw new HttpError(409, 'not_dead_lettered', `Reactor ${reactor} has no dead-lettered reaction at seq ${body.seq}`);
    if (r.status === 'stopping') throw new HttpError(503, 'stopping', 'aocd is stopping');
    const error = r.status === 'failed' ? r.error : null;
    const e = record('admin.reactor_redriven', auth.user.id, { reactor, seq: body.seq }, body.reason, error);
    return c.json(result(e, error));
  });

  app.post('/api/admin/projections/rebuild', async (c) => {
    const auth = requirePermission(c, 'ops.admin');
    const body = await readJson(c, AdminRebuildSchema);
    const known = new Set(runtime.store.projectorNames());
    const unknown = body.projectors.filter((p) => !known.has(p));
    if (unknown.length)
      throw new HttpError(404, 'unknown_projector', `No projector named ${unknown.join(', ')}`, { unknown });
    const projectors = [...new Set(body.projectors)];
    let error: string | null = null;
    try {
      runtime.store.rebuildProjections(projectors);
    } catch (err) {
      // The rebuild rolled back: the projections are as they were.
      error = String(err).slice(0, 1000);
    }
    const degraded = runtime.store
      .projectionHealth()
      .filter((p) => p.status !== 'ok' && projectors.includes(p.name))
      .map((p) => p.name);
    const e = record('admin.projections_rebuilt', auth.user.id, { projectors, degraded }, body.reason, error);
    const out: AdminRebuildResultDTO = { ...result(e, error), projectors, degraded };
    return c.json(out);
  });

  app.post('/api/admin/jobs/:name/run', async (c) => {
    const auth = requirePermission(c, 'ops.admin');
    const job = nameParam(c.req.param('name'), 'job');
    const body = await readJson(c, AdminRunJobSchema);
    if (!runtime.jobNames().includes(job)) throw new HttpError(404, 'unknown_job', `No job named ${job}`);
    let r;
    try {
      r = await runtime.runJob(job);
    } catch {
      throw new HttpError(503, 'stopping', 'aocd is stopping');
    }
    const e = record('admin.job_run', auth.user.id, { job }, body.reason, r.error);
    return c.json(result(e, r.error));
  });
}
