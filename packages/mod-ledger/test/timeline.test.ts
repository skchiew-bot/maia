import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectTimeline, SessionTimeline } from '@aoc/contracts';
import { createHarness, PLAN, type Harness } from './harness';

let h: Harness;
afterEach(async () => h?.close());

const minutes = (n: number) => h.t.clock.advance(n * 60_000);
const at = (t0: number, min: number) => new Date(t0 + min * 60_000).toISOString();
const evidence = (n: string) => ({ kind: 'test', ref: `test/widget.test.ts > ${n}` });

describe('session timeline (hero strip, §12)', () => {
  it('scales phase bands by elapsed time and carries marks for every kind of build activity', async () => {
    h = await createHarness();
    const projectId = h.project();
    const t0 = h.t.clock.now();
    h.session({ sessionId: 'ses_a', projectId, startedAt: h.t.clock.iso() });
    await h.mcp('declare_plan', 'ses_a', PLAN);
    minutes(5);
    await h.mcp('task_done', 'ses_a', { task_id: 't1', evidence: evidence('a') }); // T+5, an empty first close: flagged
    minutes(5);
    h.toolUsed('ses_a');
    minutes(5);
    await h.mcp('task_done', 'ses_a', { task_id: 't2', evidence: evidence('b') }); // T+15, P1 complete
    minutes(5);
    await h.mcp('amend_plan', 'ses_a', {
      reason: 'pagination',
      add: [{ id: 't4', title: 'Pagination', size: 'xl', phaseId: 'P2' }],
    }); // +80% → drift
    minutes(1);
    h.t.decisions!.request(
      {
        kind: 'agent_decision',
        test: 'ambiguity',
        title: 'Cursor or offset?',
        question: 'Which pagination?',
        options: [
          { id: 'c', label: 'Cursor' },
          { id: 'o', label: 'Offset' },
        ],
        subjectType: 'session',
        subjectId: 'ses_a',
        sessionId: 'ses_a',
        projectId,
        requesterId: h.owner.user.id,
      },
      { kind: 'agent', id: 'ses_a' },
    );
    minutes(1);
    h.t.rt.store.append({
      type: 'throttle.hit',
      actor: { kind: 'system', id: 'sidecar' },
      scope: { sessionId: 'ses_a' },
      meta: { sessionId: 'ses_a', resetAt: null, source: 'stream' },
      payload: { message: 'limit' },
      source: 'sidecar',
    });
    minutes(1);
    await h.t.json('POST', `/api/projects/${projectId}/enhancements`, {
      headers: h.owner.headers,
      body: { title: 'Dark mode', sessionId: 'ses_a' },
      expect: 201,
    });
    h.t.rt.store.append({
      type: 'rollback.requested',
      actor: { kind: 'human', id: h.owner.user.id },
      scope: { projectId },
      meta: { rollbackId: 'rbk_1', projectId, targetRef: 'aoc/x/P1/1', targetSha: 'abcdef1', changeId: null },
      payload: { reason: 'bad deploy' },
      source: 'api',
    });

    const tl = await h.t.json<SessionTimeline>('GET', '/api/sessions/ses_a/timeline', {
      headers: h.owner.headers,
    });
    expect(tl).toMatchObject({ sessionId: 'ses_a', startAt: at(t0, 0), endAt: null, now: at(t0, 23) });
    expect(tl.phases).toEqual([
      {
        phaseId: 'P1',
        name: 'Foundation',
        startAt: at(t0, 0),
        endAt: at(t0, 15),
        doneWeight: 5,
        totalWeight: 5,
      },
      { phaseId: 'P2', name: 'API', startAt: at(t0, 15), endAt: null, doneWeight: 0, totalWeight: 13 },
    ]);
    expect(tl.marks.map((m) => [m.kind, m.label])).toEqual([
      ['task_done', 't1 · no_file_change'],
      ['tool', 'Edit'],
      ['task_done', 't2'],
      ['phase_complete', 'Foundation'],
      ['amendment', 'v2: +1 −0 ~0'],
      ['drift', 'scope_growth'],
      ['decision', 'Cursor or offset?'],
      ['throttle', 'Plan limit hit'],
      ['enhancement', 'Dark mode'],
      ['rollback', 'requested'],
    ]);
    expect(tl.marks.find((m) => m.kind === 'drift')!.severity).toBe('high');
    expect(tl.marks.find((m) => m.kind === 'rollback')!.refId).toBe('rbk_1');
    expect(tl.progress).toMatchObject({
      doneTasks: 2,
      totalTasks: 4,
      doneWeight: 5,
      totalWeight: 18,
      flaggedTasks: 1,
    });
    expect(tl.amendments).toHaveLength(1);
  });

  it('samples tool marks to at most 300 and 404s unknown sessions', async () => {
    h = await createHarness();
    const projectId = h.project();
    h.session({ sessionId: 'ses_a', projectId });
    await h.mcp('declare_plan', 'ses_a', PLAN);
    for (let i = 0; i < 400; i++)
      h.toolUsed('ses_a', { toolName: i === 399 ? 'Last' : 'Read', fileChanging: false });
    await h.t.drain();
    const tl = await h.t.json<SessionTimeline>('GET', '/api/sessions/ses_a/timeline', {
      headers: h.owner.headers,
    });
    const tools = tl.marks.filter((m) => m.kind === 'tool');
    expect(tools).toHaveLength(300);
    expect(tools.at(-1)!.label).toBe('Last');
    expect(
      (await h.t.request('GET', '/api/sessions/ses_nope/timeline', { headers: h.owner.headers })).status,
    ).toBe(404);
  });
});

describe('project timeline (master timeline, §9)', () => {
  it('stacks per-phase segments per contributing developer across sessions', async () => {
    h = await createHarness();
    const projectId = h.project();
    const dev2 = h.t.user('builder', 'Dev Two');
    h.session({ sessionId: 'ses_1', projectId });
    h.session({ sessionId: 'ses_2', projectId, ownerId: dev2.user.id });
    await h.mcp('declare_plan', 'ses_1', {
      phases: [
        { id: 'P1', name: 'Core', tasks: [{ id: 'a', title: 'a', size: 'm' }] },
        { id: 'P2', name: 'API', tasks: [{ id: 'b', title: 'b', size: 's' }] },
      ],
    });
    await h.mcp('declare_plan', 'ses_2', {
      phases: [
        { id: 'P1', name: 'Core', tasks: [{ id: 'c', title: 'c', size: 'l' }] },
        { id: 'P3', name: 'Docs', tasks: [{ id: 'd', title: 'd', size: 'xs' }] },
      ],
    });
    h.toolUsed('ses_1');
    await h.mcp('task_done', 'ses_1', { task_id: 'a', evidence: evidence('a') });
    h.toolUsed('ses_2');
    await h.mcp('task_done', 'ses_2', { task_id: 'd', evidence: evidence('d') });

    const tl = await h.t.json<ProjectTimeline>('GET', `/api/projects/${projectId}/timeline`, {
      headers: h.owner.headers,
    });
    expect(tl.progress).toMatchObject({
      doneTasks: 2,
      totalTasks: 4,
      doneWeight: 4,
      totalWeight: 11,
      pct: 36.4,
    });
    expect(tl.phases).toEqual([
      {
        phaseId: 'P1',
        name: 'Core',
        order: 0,
        doneWeight: 3,
        totalWeight: 8,
        completedAt: null,
        segments: [
          { ownerId: h.owner.user.id, ownerName: 'Dev One', doneWeight: 3, totalWeight: 3 },
          { ownerId: dev2.user.id, ownerName: 'Dev Two', doneWeight: 0, totalWeight: 5 },
        ],
      },
      {
        phaseId: 'P2',
        name: 'API',
        order: 1,
        doneWeight: 0,
        totalWeight: 2,
        completedAt: null,
        segments: [{ ownerId: h.owner.user.id, ownerName: 'Dev One', doneWeight: 0, totalWeight: 2 }],
      },
      {
        phaseId: 'P3',
        name: 'Docs',
        order: 2,
        doneWeight: 1,
        totalWeight: 1,
        completedAt: expect.any(String),
        segments: [{ ownerId: dev2.user.id, ownerName: 'Dev Two', doneWeight: 1, totalWeight: 1 }],
      },
    ]);
    expect(tl.manifest[0]!.tasks.map((t) => [t.taskId, t.declaredBy])).toEqual([
      ['a', h.owner.user.id],
      ['c', dev2.user.id],
    ]);
    // A session's own phase completes (and pins) independently of other developers' work in that phase.
    expect(h.events('phase.completed').map((e) => [e.meta.sessionId, e.meta.phaseId])).toEqual([
      ['ses_1', 'P1'],
      ['ses_2', 'P3'],
    ]);
  });
});
