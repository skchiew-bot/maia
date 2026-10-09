import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectTimeline, SessionTimeline } from '@aoc/contracts';
import { LEDGER_TABLES } from '../src';
import { createHarness, PLAN, type Harness } from './harness';

let h: Harness;
afterEach(async () => h?.close());

/** Every row of every ledger table. */
function rows(): Record<string, string[]> {
  return Object.fromEntries(
    LEDGER_TABLES.map((t) => [t, (h.t.rt.store.db.prepare(`SELECT * FROM ${t}`).all() as object[]).map((r) => JSON.stringify(r)).sort()]),
  );
}

describe('erasing a session\'s manifest keeps the denominator (§9) and a rebuild agrees', () => {
  async function setup() {
    h = await createHarness();
    const projectId = h.project();
    const threadId = h.thread(projectId);
    h.session({ sessionId: 'ses_a', projectId, threadId });
    h.ledger.acquireWriter(threadId, 'ses_a', { kind: 'system', id: 'supervisor' });
    await h.mcp('declare_plan', 'ses_a', PLAN); // t1 s, t2 m (P1); t3 l (P2): weights 2, 3, 5
    h.toolUsed('ses_a', { filePaths: ['/w/src/a.ts'] });
    await h.mcp('task_done', 'ses_a', { task_id: 't1', evidence: { kind: 'test', ref: 'test/widget.test.ts > a' } });
    // An amendment that adds, removes and resizes: the part of the plan that only the erased body described.
    await h.mcp('amend_plan', 'ses_a', {
      reason: 'rethink the api',
      add: [{ id: 't4', title: 'Docs for the api', size: 'xs', phaseId: 'P3', phaseName: 'Docs' }],
      remove: ['t2'],
      resize: [{ taskId: 't3', size: 'xl' }],
    });
    return { projectId, threadId };
  }
  const timeline = (id: string) => h.t.json<SessionTimeline>('GET', `/api/sessions/${id}/timeline`, { headers: h.owner.headers });

  it('open tasks, their phases and the amendment survive the erasure and the rebuild, with the same progress', async () => {
    const { projectId } = await setup();
    const before = await timeline('ses_a');
    const beforeProject = await h.t.json<ProjectTimeline>('GET', `/api/projects/${projectId}/timeline`, { headers: h.owner.headers });
    // t1 done (2) of t1 (2) + t3 xl (8) + t4 xs (1): t2 was removed.
    expect(before.progress).toMatchObject({ doneTasks: 1, totalTasks: 3, doneWeight: 2, totalWeight: 11 });

    h.t.rt.store.eraseScope('ses_a', { actor: { kind: 'human', id: 'usr_dpo' }, reason: 'secret_leak' });
    const live = rows();
    const erased = await timeline('ses_a');
    expect(erased.progress).toEqual(before.progress);
    expect(erased.manifest.flatMap((p) => p.tasks).map((t) => [t.taskId, t.status, t.weight, t.title])).toEqual(
      before.manifest.flatMap((p) => p.tasks).map((t) => [t.taskId, t.status, t.weight, '[erased]']),
    );

    h.t.rt.store.rebuildProjections(['ledger']);
    expect(rows()).toEqual(live);
    const rebuilt = await timeline('ses_a');
    expect(rebuilt).toEqual(erased);
    expect(rebuilt.progress).toEqual(before.progress);
    const project = await h.t.json<ProjectTimeline>('GET', `/api/projects/${projectId}/timeline`, { headers: h.owner.headers });
    expect(project.progress).toEqual(beforeProject.progress);
    expect(h.t.rt.store.projectionHealth()).toEqual([]);
  });

  it('a session whose plan was erased can still close its open tasks', async () => {
    await setup();
    h.t.rt.store.eraseScope('ses_a', { actor: { kind: 'human', id: 'usr_dpo' }, reason: 'secret_leak' });
    h.t.rt.store.rebuildProjections(['ledger']);
    await h.mcp('task_done', 'ses_a', { task_id: 't3', evidence: { kind: 'diff', ref: 'src/a.ts +9' } });
    const after = await timeline('ses_a');
    expect(after.progress).toMatchObject({ doneTasks: 2, totalTasks: 3, doneWeight: 10, totalWeight: 11 });
  });
});
