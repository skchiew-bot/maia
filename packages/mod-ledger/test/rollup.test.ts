import { afterEach, describe, expect, it } from 'vitest';
import type { Actor, ProjectHistory, ProjectRollup } from '@aoc/contracts';
import { createHarness, PLAN, writeFile, type Harness } from './harness';

let h: Harness;
afterEach(async () => h?.close());

const supervisor: Actor = { kind: 'system', id: 'supervisor' };
const DAY = 86_400_000;

describe('GET /api/projects/rollup', () => {
  it('rolls each project up by phase, with flagged weight, the current phase, drift and amendments', async () => {
    h = await createHarness();
    const projectId = h.project();
    const empty = h.project('Empty');
    const cwd = h.repo();
    h.session({ sessionId: 'ses_a', projectId, cwd });
    await h.mcp('declare_plan', 'ses_a', PLAN);
    // An empty first close (nothing changed since the plan): flagged, still counted.
    await h.mcp('task_done', 'ses_a', {
      task_id: 't1',
      evidence: { kind: 'test', ref: 'test/widget.test.ts > works' },
    });
    writeFile(cwd, 'src/schema.ts', 'export const schema = 1;\n');
    h.toolUsed('ses_a', { filePaths: [`${cwd}/src/schema.ts`] });
    // Real work closes t2, which completes P1 and pins it.
    await h.mcp('task_done', 'ses_a', { task_id: 't2', evidence: { kind: 'diff', ref: 'src/schema.ts +1' } });
    await h.mcp('amend_plan', 'ses_a', {
      reason: 'UAT feedback',
      add: [{ id: 't4', title: 'Export', size: 'm', phaseId: 'P2' }],
    });
    h.session({ sessionId: 'ses_b', projectId });
    h.toolUsed('ses_b'); // file change before any plan: high-severity drift
    await h.t.drain();

    expect((await h.t.request('GET', '/api/projects/rollup')).status).toBe(401);
    const requester = h.t.user('requester');
    expect((await h.t.request('GET', '/api/projects/rollup', { headers: requester.headers })).status).toBe(
      403,
    );

    const rows = await h.t.json<ProjectRollup[]>('GET', '/api/projects/rollup', { headers: h.owner.headers });
    expect(rows.map((r) => r.projectId).sort()).toEqual([empty, projectId].sort());
    const row = rows.find((r) => r.projectId === projectId);
    const none = rows.find((r) => r.projectId === empty);
    expect(row!.phases).toEqual([
      {
        phaseId: 'P1',
        name: 'Foundation',
        order: 0,
        doneTasks: 2,
        totalTasks: 2,
        doneWeight: 5,
        totalWeight: 5,
        flaggedTasks: 1,
        flaggedWeight: 2,
        completedAt: expect.any(String),
        pinnedTag: expect.stringMatching(/^aoc\/.+\/P1\/\d+$/),
        pinnedSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      },
      {
        phaseId: 'P2',
        name: 'API',
        order: 1,
        doneTasks: 0,
        totalTasks: 2,
        doneWeight: 0,
        totalWeight: 8,
        flaggedTasks: 0,
        flaggedWeight: 0,
        completedAt: null,
        pinnedTag: null,
        pinnedSha: null,
      },
    ]);
    expect(row).toMatchObject({
      currentPhaseId: 'P2',
      drift: { total: 1, last7d: 1, highLast7d: 1, lastAt: expect.any(String) },
      amendments: { count: 1, last7d: 1, lastAt: expect.any(String) },
    });
    expect(none).toEqual({
      projectId: empty,
      phases: [],
      currentPhaseId: null,
      drift: { total: 0, last7d: 0, highLast7d: 0, lastAt: null },
      amendments: { count: 0, last7d: 0, lastAt: null },
    });

    h.t.clock.advance(8 * DAY);
    const later = await h.t.json<ProjectRollup[]>('GET', '/api/projects/rollup', {
      headers: h.owner.headers,
    });
    expect(later.find((r) => r.projectId === projectId)).toMatchObject({
      drift: { total: 1, last7d: 0, highLast7d: 0 },
      amendments: { count: 1, last7d: 0 },
    });
    // The static /rollup route sits before /:id without shadowing real project ids.
    expect(
      (await h.t.request('GET', `/api/projects/${projectId}`, { headers: h.owner.headers })).status,
    ).toBe(200);
  });
});

describe('GET /api/projects/:id/history', () => {
  it('lists every denominator change with exact project totals, counting rollover carry-over once', async () => {
    h = await createHarness();
    const projectId = h.project();
    const threadId = h.thread(projectId);
    h.session({ sessionId: 'ses_1', projectId, threadId });
    h.ledger.acquireWriter(threadId, 'ses_1', supervisor);
    await h.mcp('declare_plan', 'ses_1', PLAN); // t1 s, t2 m, t3 l → 10
    h.toolUsed('ses_1');
    await h.mcp('task_done', 'ses_1', {
      task_id: 't1',
      evidence: { kind: 'test', ref: 'test/widget.test.ts > a' },
    });
    await h.mcp('amend_plan', 'ses_1', {
      reason: 'Export was missing',
      add: [{ id: 't4', title: 'Export', size: 'm', phaseId: 'P2' }],
    }); // 10 → 13

    // Rollover: ses_2 takes over t2 and t3 (already counted) and adds t5 (xs, new scope).
    h.ledger.releaseWriter(threadId, 'ses_1', 'rollover', supervisor);
    h.t.sessions!.get('ses_1')!.lifecycle = 'retired';
    const cwd = h.repo();
    h.session({ sessionId: 'ses_2', projectId, threadId, cwd });
    h.ledger.acquireWriter(threadId, 'ses_2', supervisor);
    await h.mcp('declare_plan', 'ses_2', {
      phases: [
        { id: 'P1', name: 'Foundation', tasks: [{ id: 't2', title: 'Store', size: 'm' }] },
        {
          id: 'P2',
          name: 'API',
          tasks: [
            { id: 't3', title: 'Routes', size: 'l' },
            { id: 't5', title: 'Docs', size: 'xs' },
          ],
        },
      ],
    });
    await h.mcp('amend_plan', 'ses_2', { reason: 'Docs move to the handbook', remove: ['t5'] });
    writeFile(cwd, 'src/store.ts', 'export const store = 1;\n');
    h.toolUsed('ses_2', { filePaths: [`${cwd}/src/store.ts`] });
    await h.mcp('task_done', 'ses_2', { task_id: 't2', evidence: { kind: 'diff', ref: 'src/store.ts +1' } });

    h.session({ sessionId: 'ses_x', projectId });
    h.toolUsed('ses_x');
    await h.t.drain();
    await h.t.json('POST', `/api/projects/${projectId}/enhancements`, {
      headers: h.owner.headers,
      body: { title: 'Bulk import' },
      expect: 201,
    });

    const read = () =>
      h.t.json<ProjectHistory>('GET', `/api/projects/${projectId}/history`, { headers: h.owner.headers });
    const history = await read();
    const owner = { ownerId: h.owner.user.id, ownerName: 'Dev One' };
    expect(history.scope).toEqual([
      expect.objectContaining({
        kind: 'declared',
        sessionId: 'ses_1',
        ...owner,
        manifestVersion: 1,
        added: 3,
        carriedOver: 0,
        weightDelta: 10,
        projectWeightBefore: 0,
        projectWeightAfter: 10,
        reason: null,
      }),
      expect.objectContaining({
        kind: 'amended',
        sessionId: 'ses_1',
        ...owner,
        manifestVersion: 2,
        added: 1,
        removed: 0,
        weightDelta: 3,
        projectWeightAfter: 13,
        reason: 'Export was missing',
      }),
      expect.objectContaining({
        kind: 'declared',
        sessionId: 'ses_2',
        added: 3,
        carriedOver: 2,
        weightDelta: 1,
        projectWeightBefore: 13,
        projectWeightAfter: 14,
      }),
      expect.objectContaining({
        kind: 'amended',
        sessionId: 'ses_2',
        removed: 1,
        weightDelta: -1,
        projectWeightAfter: 13,
        reason: 'Docs move to the handbook',
      }),
    ]);
    expect(history.scope.at(-1)!.projectWeightAfter).toBe(h.ledger.projectProgress(projectId)!.totalWeight);

    expect(history.drift).toEqual([
      {
        seq: expect.any(Number),
        at: expect.any(String),
        sessionId: 'ses_x',
        kind: 'off_plan_change',
        severity: 'high',
        taskId: null,
        detail: expect.stringMatching(/before a plan manifest was declared/),
      },
    ]);
    expect(history.enhancements.map((e) => [e.title, e.by, e.byName])).toEqual([
      ['Bulk import', h.owner.user.id, 'Dev One'],
    ]);
    expect(history.pins).toEqual([
      {
        phaseId: 'P1',
        sessionId: 'ses_2',
        tag: expect.stringMatching(/^aoc\/.+\/P1\/\d+$/),
        sha: expect.stringMatching(/^[0-9a-f]{40}$/),
        at: expect.any(String),
      },
    ]);

    // Crypto-shredding a session's bodies keeps the totals (they are chained meta) and erases its text.
    h.t.rt.store.eraseScope('ses_1', { actor: { kind: 'system', id: 'test' }, reason: 'pdpa_request' });
    const erased = await read();
    expect(erased.scope.map((s) => s.projectWeightAfter)).toEqual([10, 13, 14, 13]);
    expect(erased.scope[1]!.reason).toBe('[erased]');

    expect(
      (await h.t.request('GET', '/api/projects/prj_nope/history', { headers: h.owner.headers })).status,
    ).toBe(404);
    const requester = h.t.user('requester');
    expect(
      (await h.t.request('GET', `/api/projects/${projectId}/history`, { headers: requester.headers })).status,
    ).toBe(403);
  });
});
