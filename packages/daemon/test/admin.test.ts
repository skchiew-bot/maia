import { afterEach, describe, expect, it } from 'vitest';
import type { AdminActionResultDTO, AdminRebuildResultDTO, StoredEvent } from '@aoc/contracts';
import type { AocModule } from '@aoc/kernel';
import { bootTestServer, removeTempDirs, type TestServer } from './helpers';

afterEach(() => removeTempDirs());

/** A reactor that fails while `broken`, a projector counting users, and a job that fails while `jobFails`. */
function testModule() {
  const state = { broken: true, reacted: [] as number[], jobFails: true, jobRuns: 0 };
  const mod: AocModule = {
    name: 'admin-test',
    reactors: [
      {
        name: 'test.flaky',
        handles: ['user.created'],
        react(e) {
          if (state.broken) throw new Error('dependency unavailable');
          state.reacted.push(e.seq);
        },
      },
    ],
    projectors: [
      {
        name: 'test.users',
        tables: ['test_users'],
        ddl: ['CREATE TABLE IF NOT EXISTS test_users (seq INTEGER PRIMARY KEY)'],
        handles: ['user.created'],
        apply({ db }, e) {
          db.prepare('INSERT INTO test_users (seq) VALUES (?)').run(e.seq);
        },
      },
    ],
    jobs: [
      {
        name: 'test.job',
        schedule: { everyMs: 86_400_000 },
        run() {
          state.jobRuns++;
          if (state.jobFails) throw new Error('job broke');
        },
      },
    ],
  };
  return { mod, state };
}

const post = (srv: TestServer, path: string, headers: Record<string, string>, body: unknown) =>
  srv.request(path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });

function adminEvents(srv: TestServer, type: string): StoredEvent[] {
  return srv.aoc.runtime.store.list({ types: [type] });
}

describe('audited admin actions (O-26, G-47)', () => {
  it('re-drives one dead-lettered reaction for one reactor and records who did it, why and how it went', async () => {
    const { mod, state } = testModule();
    const srv = await bootTestServer({ modules: [mod] });
    const approver = srv.user('approver');
    await srv.aoc.runtime.drain();
    const db = srv.aoc.runtime.store.db;
    const dead = () => db.prepare("SELECT seq, error FROM reactor_failures WHERE reactor = 'test.flaky'").all() as { seq: number; error: string }[];
    const [{ seq }] = dead() as [{ seq: number; error: string }];
    const path = '/api/admin/reactors/test.flaky/redrive';

    expect((await post(srv, path, srv.user('builder').headers, { seq, reason: 'retry' })).status).toBe(403);
    expect((await post(srv, path, approver.headers, { seq })).status).toBe(422);
    expect((await post(srv, '/api/admin/reactors/test.nope/redrive', approver.headers, { seq, reason: 'x' })).status).toBe(404);

    // Still broken: the dead letter stays (once, with the new error) and the failed attempt is on the record.
    const failed = await post(srv, path, approver.headers, { seq, reason: 'dependency should be back' });
    expect(failed.status).toBe(200);
    expect((await failed.json()) as AdminActionResultDTO).toMatchObject({ outcome: 'failed', error: expect.stringContaining('dependency unavailable') });
    expect(dead().filter((d) => d.seq === seq)).toHaveLength(1);

    state.broken = false;
    const ok = (await (await post(srv, path, approver.headers, { seq, reason: 'dependency restored' })).json()) as AdminActionResultDTO;
    expect(ok).toMatchObject({ outcome: 'ok', error: null });
    expect(state.reacted).toEqual([seq]);
    expect(dead().filter((d) => d.seq === seq)).toEqual([]);

    const records = adminEvents(srv, 'admin.reactor_redriven');
    expect(records.map((e) => e.meta)).toEqual([
      { reactor: 'test.flaky', seq, outcome: 'failed' },
      { reactor: 'test.flaky', seq, outcome: 'ok' },
    ]);
    const approverId = records[1]!.actor.id;
    expect(records[1]!.actor).toEqual({ kind: 'human', id: approverId });
    expect(srv.identity.getUser(approverId)?.role).toBe('approver');
    expect(records[1]!.seq).toBe(ok.eventSeq);
    expect(srv.aoc.runtime.store.readPayload(records[1]!)).toEqual({ reason: 'dependency restored' });
    expect(srv.aoc.runtime.store.readPayload(records[0]!)).toMatchObject({ reason: 'dependency should be back', error: expect.stringContaining('dependency unavailable') });

    // Nothing left to re-drive at that seq: an arbitrary event cannot be replayed through a reactor.
    expect((await post(srv, path, approver.headers, { seq, reason: 'again' })).status).toBe(409);
    await srv.close();
  });

  it('rebuilds named projections from the log and records it; an unknown name is refused before anything runs', async () => {
    const { mod } = testModule();
    const srv = await bootTestServer({ modules: [mod] });
    const approver = srv.user('approver');
    srv.user('builder');
    const db = srv.aoc.runtime.store.db;
    const count = () => (db.prepare('SELECT COUNT(*) AS n FROM test_users').get() as { n: number }).n;
    const before = count();
    expect(before).toBeGreaterThanOrEqual(2);
    db.exec('DELETE FROM test_users');

    const path = '/api/admin/projections/rebuild';
    expect((await post(srv, path, approver.headers, { projectors: ['test.users', 'nope'], reason: 'x' })).status).toBe(404);
    expect(count()).toBe(0);
    expect(adminEvents(srv, 'admin.projections_rebuilt')).toEqual([]);

    const res = (await (await post(srv, path, approver.headers, { projectors: ['test.users'], reason: 'read model looked wrong' })).json()) as AdminRebuildResultDTO;
    expect(res).toMatchObject({ outcome: 'ok', error: null, projectors: ['test.users'], degraded: [] });
    expect(count()).toBe(before);
    const [e] = adminEvents(srv, 'admin.projections_rebuilt');
    expect(e!.meta).toEqual({ projectors: ['test.users'], degraded: [], outcome: 'ok' });
    expect(e!.actor.kind).toBe('human');
    expect(srv.aoc.runtime.store.readPayload(e!)).toEqual({ reason: 'read model looked wrong' });
    await srv.close();
  });

  it('runs a job by name and records the run with its outcome', async () => {
    const { mod, state } = testModule();
    const srv = await bootTestServer({ modules: [mod] });
    const approver = srv.user('approver');
    expect((await post(srv, '/api/admin/jobs/test.job/run', srv.user('builder').headers, { reason: 'x' })).status).toBe(403);
    expect((await post(srv, '/api/admin/jobs/test.nope/run', approver.headers, { reason: 'x' })).status).toBe(404);
    expect(state.jobRuns).toBe(0);

    const failed = (await (await post(srv, '/api/admin/jobs/test.job/run', approver.headers, { reason: 'missed last night' })).json()) as AdminActionResultDTO;
    expect(failed).toMatchObject({ outcome: 'failed', error: expect.stringContaining('job broke') });
    state.jobFails = false;
    const ok = (await (await post(srv, '/api/admin/jobs/test.job/run', approver.headers, { reason: 'after the fix' })).json()) as AdminActionResultDTO;
    expect(ok).toMatchObject({ outcome: 'ok', error: null });
    expect(state.jobRuns).toBe(2);

    expect(adminEvents(srv, 'admin.job_run').map((e) => e.meta)).toEqual([
      { job: 'test.job', outcome: 'failed' },
      { job: 'test.job', outcome: 'ok' },
    ]);
    expect(srv.aoc.runtime.store.db.prepare("SELECT last_status FROM job_runs WHERE name = 'test.job'").get()).toEqual({ last_status: 'ok' });
    await srv.close();
  });
});
