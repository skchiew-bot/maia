import { afterEach, describe, expect, it } from 'vitest';
import type {
  AmendPlanResult,
  DeclarePlanLedgerResult,
  McpErrorResult,
  ProjectTimeline,
  SessionTimeline,
  TaskDoneResult,
} from '@aoc/contracts';
import { createHarness, PLAN, type Harness } from './harness';

let h: Harness;
afterEach(async () => h?.close());

const test = (ref: string) => ({ kind: 'test', ref });

describe('declare_plan', () => {
  it('declares manifest v1 attributed to the session and its owner', async () => {
    h = await createHarness();
    const projectId = h.project();
    const s = h.session({ sessionId: 'ses_a', projectId });
    const r = await h.mcp<DeclarePlanLedgerResult>('declare_plan', s.sessionId, PLAN);
    expect(r).toEqual({
      ok: true,
      manifestVersion: 1,
      totalTasks: 3,
      totalWeight: 2 + 3 + 5,
      carriedOver: 0,
    });

    const [e] = h.events('plan.declared');
    expect(e!.meta).toMatchObject({
      sessionId: 'ses_a',
      projectId,
      manifestVersion: 1,
      phaseCount: 2,
      taskCount: 3,
      totalWeight: 10,
      ownerId: h.owner.user.id,
    });
    expect(e!.actor).toEqual({ kind: 'agent', id: 'ses_a' });
    expect(e!.scope.userId).toBe(h.owner.user.id);
    expect(h.ledger.hasManifest('ses_a')).toBe(true);

    const tl = await h.t.json<SessionTimeline>('GET', '/api/sessions/ses_a/timeline', {
      headers: h.owner.headers,
    });
    expect(tl.manifest.map((p) => p.phaseId)).toEqual(['P1', 'P2']);
    expect(tl.manifest[1]!.tasks[0]).toMatchObject({
      taskId: 't3',
      size: 'l',
      weight: 5,
      status: 'open',
      declaredBy: h.owner.user.id,
      acceptance: 'GET /widgets returns 200',
    });
  });

  it('rejects a second declaration (409 → amend_plan), duplicate ids and invalid input (422)', async () => {
    h = await createHarness();
    const projectId = h.project();
    h.session({ sessionId: 'ses_a', projectId });
    h.session({ sessionId: 'ses_b', projectId });

    const dup = await h.mcp<McpErrorResult>(
      'declare_plan',
      'ses_b',
      {
        phases: [
          { id: 'P1', name: 'x', tasks: [{ id: 't1', title: 'a', size: 's' }] },
          { id: 'P2', name: 'y', tasks: [{ id: 't1', title: 'b', size: 's' }] },
        ],
      },
      422,
    );
    expect(dup).toMatchObject({ ok: false, details: { duplicateTaskIds: ['t1'] } });
    const bad = await h.mcp<McpErrorResult>(
      'declare_plan',
      'ses_b',
      { phases: [{ id: 'P1', name: 'x', tasks: [{ id: 't1', title: 'a', size: 'huge' }] }] },
      422,
    );
    expect(bad.ok).toBe(false);
    expect(h.ledger.hasManifest('ses_b')).toBe(false);

    await h.mcp('declare_plan', 'ses_a', PLAN);
    const again = await h.mcp<McpErrorResult>('declare_plan', 'ses_a', PLAN, 409);
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/amend_plan/);
    expect(h.events('plan.declared')).toHaveLength(1);
  });

  it('authenticates with the session token of the body session only', async () => {
    h = await createHarness();
    const projectId = h.project();
    h.session({ sessionId: 'ses_a', projectId });
    h.session({ sessionId: 'ses_b', projectId });
    const noToken = await h.t.request('POST', '/ingest/mcp/declare_plan', {
      body: { sessionId: 'ses_a', input: PLAN },
    });
    expect(noToken.status).toBe(401);
    // The kernel refuses anonymous ingest before any route parses the body.
    expect(await noToken.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    const wrong = await h.t.request('POST', '/ingest/mcp/declare_plan', {
      headers: h.t.ingestHeaders('ses_b'),
      body: { sessionId: 'ses_a', input: PLAN },
    });
    expect(wrong.status).toBe(403);
    const system = await h.t.request('POST', '/ingest/mcp/declare_plan', {
      headers: h.t.ingestHeaders('system'),
      body: { sessionId: 'ses_a', input: PLAN },
    });
    expect(system.status).toBe(403);
    await h.mcp('declare_plan', 'ses_unknown', PLAN, 404);
  });
});

describe('amend_plan (audited, §4/§9)', () => {
  it('changes the denominator visibly and records the amendment under the developer', async () => {
    h = await createHarness();
    const projectId = h.project();
    h.session({ sessionId: 'ses_a', projectId });
    await h.mcp('declare_plan', 'ses_a', PLAN);
    expect(h.ledger.sessionProgress('ses_a')!.totalWeight).toBe(10);

    const r = await h.mcp<AmendPlanResult>('amend_plan', 'ses_a', {
      reason: 'Pagination was missed in the original plan',
      add: [
        { id: 't4', title: 'Pagination', size: 'xl', phaseId: 'P2' },
        { id: 't5', title: 'Docs', size: 'xs', phaseId: 'P3', phaseName: 'Docs' },
      ],
      resize: [{ taskId: 't1', size: 'm' }],
    });
    expect(r).toMatchObject({
      ok: true,
      manifestVersion: 2,
      prevTotalWeight: 10,
      totalWeight: 10 + 8 + 1 + 1,
      added: 2,
      removed: 0,
      resized: 1,
      totalTasks: 5,
    });
    const p = h.ledger.sessionProgress('ses_a')!;
    expect(p.totalWeight).toBe(20);
    expect(p.phases.map((x) => x.phaseId)).toEqual(['P1', 'P2', 'P3']);

    const removed = await h.mcp<AmendPlanResult>('amend_plan', 'ses_a', {
      reason: 'Docs move to another thread',
      remove: ['t5'],
    });
    expect(removed).toMatchObject({ manifestVersion: 3, prevTotalWeight: 20, totalWeight: 19, removed: 1 });

    const [a1, a2] = h.events('plan.amended');
    expect(a1!.meta).toMatchObject({
      manifestVersion: 2,
      added: 2,
      resized: 1,
      prevTotalWeight: 10,
      newTotalWeight: 20,
      ownerId: h.owner.user.id,
    });
    expect(a2!.meta).toMatchObject({ manifestVersion: 3, removed: 1, newTotalWeight: 19 });
    const tl = await h.t.json<ProjectTimeline>('GET', `/api/projects/${projectId}/timeline`, {
      headers: h.owner.headers,
    });
    expect(tl.amendments.map((a) => [a.by, a.byName, a.newTotalWeight, a.reason])).toEqual([
      [h.owner.user.id, 'Dev One', 20, 'Pagination was missed in the original plan'],
      [h.owner.user.id, 'Dev One', 19, 'Docs move to another thread'],
    ]);
  });

  it('requires a reason and a real change; done work is immutable', async () => {
    h = await createHarness();
    const projectId = h.project();
    h.session({ sessionId: 'ses_a', projectId });
    await h.mcp(
      'amend_plan',
      'ses_a',
      { reason: 'too early', add: [{ id: 'x', title: 'x', size: 's', phaseId: 'P1' }] },
      409,
    );
    await h.mcp('declare_plan', 'ses_a', PLAN);
    await h.mcp('amend_plan', 'ses_a', { add: [{ id: 't9', title: 'x', size: 's', phaseId: 'P1' }] }, 422);
    await h.mcp('amend_plan', 'ses_a', { reason: 'no-op' }, 422);
    await h.mcp('amend_plan', 'ses_a', { reason: 'same size', resize: [{ taskId: 't1', size: 's' }] }, 422);
    h.toolUsed('ses_a');
    await h.mcp('task_done', 'ses_a', { task_id: 't1', evidence: test('test/widget.test.ts > works') });

    const done = await h.mcp<McpErrorResult>(
      'amend_plan',
      'ses_a',
      { reason: 'shrink', remove: ['t1'], resize: [{ taskId: 't1', size: 'xl' }] },
      422,
    );
    expect(JSON.stringify(done.details)).toMatch(/t1/);
    const resizeDone = await h.mcp<McpErrorResult>(
      'amend_plan',
      'ses_a',
      { reason: 'inflate', resize: [{ taskId: 't1', size: 'xl' }] },
      422,
    );
    expect(JSON.stringify(resizeDone.details)).toMatch(/size is fixed/);
    const exists = await h.mcp<McpErrorResult>(
      'amend_plan',
      'ses_a',
      { reason: 'dup', add: [{ id: 't2', title: 'again', size: 's', phaseId: 'P1' }] },
      422,
    );
    expect(JSON.stringify(exists.details)).toMatch(/already exists/);
    expect(h.events('plan.amended')).toHaveLength(0);
  });

  it('removing the last open task of a phase completes (and pins) it', async () => {
    h = await createHarness();
    const projectId = h.project();
    h.session({ sessionId: 'ses_a', projectId });
    await h.mcp('declare_plan', 'ses_a', PLAN);
    h.toolUsed('ses_a');
    await h.mcp('task_done', 'ses_a', { task_id: 't1', evidence: test('test/widget.test.ts > works') });
    const r = await h.mcp<AmendPlanResult>('amend_plan', 'ses_a', {
      reason: 'store is out of scope',
      remove: ['t2'],
    });
    expect(r.phasesCompleted).toEqual([{ phaseId: 'P1', pinnedRef: null }]);
    expect(h.events('phase.completed').map((e) => e.meta.phaseId)).toEqual(['P1']);
  });
});

describe('measured progress', () => {
  it('hides the ETA until three tasks are done', async () => {
    h = await createHarness();
    const projectId = h.project();
    h.session({ sessionId: 'ses_a', projectId });
    await h.mcp('declare_plan', 'ses_a', {
      phases: [
        { id: 'P1', name: 'All', tasks: ['a', 'b', 'c', 'd'].map((id) => ({ id, title: id, size: 's' })) },
      ],
    });
    for (const [i, id] of ['a', 'b'].entries()) {
      h.t.clock.advance(10 * 60_000);
      h.toolUsed('ses_a');
      await h.mcp<TaskDoneResult>('task_done', 'ses_a', {
        task_id: id,
        evidence: test(`test/widget.test.ts > case ${i}`),
      });
      const p = h.ledger.sessionProgress('ses_a')!;
      expect(p.etaMs).toBeNull();
      expect(p.etaHiddenReason).toBe('fewer_than_3_done');
    }
    h.t.clock.advance(10 * 60_000);
    h.toolUsed('ses_a');
    await h.mcp('task_done', 'ses_a', { task_id: 'c', evidence: test('test/widget.test.ts > case c') });
    const p = h.ledger.sessionProgress('ses_a')!;
    expect(p.etaHiddenReason).toBeNull();
    expect(p.etaMs).toBe(10 * 60_000); // 30 min for weight 6 → 10 min for the remaining weight 2
    const tl = await h.t.json<SessionTimeline>('GET', '/api/sessions/ses_a/timeline', {
      headers: h.owner.headers,
    });
    expect(tl.progress).toMatchObject({ doneTasks: 3, totalTasks: 4, pct: 75, etaMs: 10 * 60_000 });
  });

  it('gaming: many xs tasks cannot inflate progress beyond their weights, and empty closes are flagged', async () => {
    h = await createHarness();
    const projectId = h.project();
    const other = h.t.user('builder', 'Dev Two');
    h.session({ sessionId: 'ses_gamer', projectId });
    h.session({ sessionId: 'ses_honest', projectId, ownerId: other.user.id });
    await h.mcp('declare_plan', 'ses_gamer', {
      phases: [
        {
          id: 'P1',
          name: 'Build',
          tasks: [
            { id: 'big', title: 'The real work', size: 'xl' },
            ...Array.from({ length: 8 }, (_, i) => ({ id: `xs${i}`, title: `tiny ${i}`, size: 'xs' })),
          ],
        },
      ],
    });
    await h.mcp('declare_plan', 'ses_honest', {
      phases: [{ id: 'P1', name: 'Build', tasks: [{ id: 'core', title: 'Core', size: 'l' }] }],
    });

    h.toolUsed('ses_gamer');
    const results: TaskDoneResult[] = [];
    for (let i = 0; i < 8; i++)
      results.push(
        await h.mcp<TaskDoneResult>('task_done', 'ses_gamer', {
          task_id: `xs${i}`,
          evidence: test(`test/widget.test.ts > tiny ${i}`),
        }),
      );

    expect(results[0]!.flagged).toBeNull(); // one real edit backs the first close only
    expect(results.slice(1).every((r) => r.flagged === 'no_file_change')).toBe(true);
    const p = h.ledger.sessionProgress('ses_gamer')!;
    expect([p.doneTasks, p.totalTasks]).toEqual([8, 9]); // 89% of tasks…
    expect(p.pct).toBe(50); // …but half the declared weight
    expect(p.flaggedTasks).toBe(7);

    const project = h.ledger.projectProgress(projectId)!;
    expect(project).toMatchObject({ doneWeight: 8, totalWeight: 8 + 8 + 5, flaggedTasks: 7 });
    expect(project.pct).toBe(38.1);

    const again = await h.mcp<McpErrorResult>(
      'task_done',
      'ses_gamer',
      { task_id: 'xs0', evidence: test('test/widget.test.ts > tiny 0') },
      409,
    );
    expect(again.error).toMatch(/already done/);
    await h.mcp(
      'task_done',
      'ses_gamer',
      { task_id: 'core', evidence: test('test/widget.test.ts > x') },
      422,
    ); // not this session's task
  });
});
