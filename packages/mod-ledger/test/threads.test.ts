import { afterEach, describe, expect, it } from 'vitest';
import type {
  Actor,
  DeclarePlanLedgerResult,
  McpErrorResult,
  ProjectTimeline,
  SessionTimeline,
  ThreadDetail,
} from '@aoc/contracts';
import { createHarness, PLAN, type Harness } from './harness';

let h: Harness;
afterEach(async () => h?.close());

const supervisor: Actor = { kind: 'system', id: 'supervisor' };

describe('threads and the single writer (§5)', () => {
  it('ensureThread creates the project and thread once and refuses a thread of another project', async () => {
    h = await createHarness();
    const t = h.ledger.ensureThread({ projectId: 'prj_new', title: 'Main line' }, supervisor);
    expect(t).toMatchObject({ projectId: 'prj_new', title: 'Main line', activeWriterSessionId: null });
    expect(t.threadId).toMatch(/^thr_/);
    expect(h.ledger.ensureThread({ projectId: 'prj_new', threadId: t.threadId }, supervisor)).toEqual(t);
    expect(h.ledger.getThread(t.threadId)).toEqual(t);
    expect(h.events('project.created')).toHaveLength(1);
    expect(() => h.ledger.ensureThread({ projectId: 'prj_other', threadId: t.threadId }, supervisor)).toThrow(
      /belongs to project prj_new/,
    );
    const named = h.ledger.ensureThread({ projectId: 'prj_new', threadId: 'thr_fixed' }, supervisor);
    expect(named).toMatchObject({ threadId: 'thr_fixed', title: 'Thread 2' });
  });

  it('allows one live writer; stale holders whose session ended or failed are released', async () => {
    h = await createHarness();
    const projectId = h.project();
    const threadId = h.thread(projectId);
    h.session({ sessionId: 'ses_a', projectId, threadId });
    h.session({ sessionId: 'ses_b', projectId, threadId });
    h.session({ sessionId: 'ses_c', projectId, threadId });

    expect(h.ledger.acquireWriter(threadId, 'ses_a', supervisor)).toBe(true);
    expect(h.ledger.acquireWriter(threadId, 'ses_a', supervisor)).toBe(true); // idempotent
    expect(h.ledger.acquireWriter(threadId, 'ses_b', supervisor)).toBe(false);
    h.t.sessions!.get('ses_a')!.lifecycle = 'waiting_decision'; // still live: a waiting writer keeps the thread
    expect(h.ledger.acquireWriter(threadId, 'ses_b', supervisor)).toBe(false);
    expect(h.events('thread.writer_acquired')).toHaveLength(1);

    h.t.sessions!.get('ses_a')!.lifecycle = 'failed';
    expect(h.ledger.acquireWriter(threadId, 'ses_b', supervisor)).toBe(true);
    expect(h.events('thread.writer_released').map((e) => e.meta)).toEqual([
      { threadId, sessionId: 'ses_a', reason: 'failed', stale: true },
    ]);
    expect(h.ledger.getThread(threadId)!.activeWriterSessionId).toBe('ses_b');

    h.ledger.releaseWriter(threadId, 'ses_c', 'stopped', supervisor); // not the holder: no-op
    expect(h.events('thread.writer_released')).toHaveLength(1);
    h.t.sessions!.sessions.delete('ses_b'); // the directory no longer knows the holder
    expect(h.ledger.acquireWriter(threadId, 'ses_c', supervisor)).toBe(true);
    expect(h.events('thread.writer_released').at(-1)!.meta).toMatchObject({
      sessionId: 'ses_b',
      reason: 'ended',
      stale: true,
    });
    expect(() => h.ledger.acquireWriter('thr_missing', 'ses_c', supervisor)).toThrow(/Unknown thread/);
  });

  it('releases the lock when the holder session ends (backstop reactor)', async () => {
    h = await createHarness();
    const projectId = h.project();
    const threadId = h.thread(projectId);
    h.session({ sessionId: 'ses_a', projectId, threadId });
    h.ledger.acquireWriter(threadId, 'ses_a', supervisor);
    const ended = h.t.rt.store.append({
      type: 'session.ended',
      actor: supervisor,
      scope: { sessionId: 'ses_a' },
      meta: { sessionId: 'ses_a', outcome: 'killed' },
      source: 'supervisor',
    });
    await h.t.drain();
    expect(h.ledger.getThread(threadId)!.activeWriterSessionId).toBeNull();
    const [rel] = h.events('thread.writer_released');
    expect(rel!.meta).toEqual({ threadId, sessionId: 'ses_a', reason: 'stopped' });
    expect(rel!.causationId).toBe(ended.id);
  });

  it('rollover: the successor re-declares open task ids and the master timeline counts them once', async () => {
    h = await createHarness();
    const projectId = h.project();
    const threadId = h.thread(projectId);
    h.session({ sessionId: 'ses_1', projectId, threadId });
    h.ledger.acquireWriter(threadId, 'ses_1', supervisor);
    await h.mcp('declare_plan', 'ses_1', PLAN);
    h.toolUsed('ses_1');
    await h.mcp('task_done', 'ses_1', {
      task_id: 't1',
      evidence: { kind: 'test', ref: 'test/widget.test.ts > schema' },
    });

    h.ledger.releaseWriter(threadId, 'ses_1', 'rollover', supervisor);
    h.t.sessions!.get('ses_1')!.lifecycle = 'retired';
    h.session({ sessionId: 'ses_2', projectId, threadId });
    expect(h.ledger.acquireWriter(threadId, 'ses_2', supervisor)).toBe(true);

    const redeclare = await h.mcp<McpErrorResult>('declare_plan', 'ses_2', PLAN, 422);
    expect(redeclare.error).toMatch(/already completed earlier in this thread.*: t1\./);
    const r = await h.mcp<DeclarePlanLedgerResult>('declare_plan', 'ses_2', {
      phases: [
        { id: 'P1', name: 'Foundation', tasks: [{ id: 't2', title: 'Store', size: 'm' }] },
        { id: 'P2', name: 'API', tasks: [{ id: 't3', title: 'Routes', size: 'l' }] },
      ],
    });
    expect(r).toMatchObject({ totalTasks: 2, carriedOver: 2 });
    expect(h.events('plan.declared')[1]!.meta.carriedOver).toBe(2);

    // Project: 3 tasks, not 5.
    expect(h.ledger.projectProgress(projectId)).toMatchObject({
      doneTasks: 1,
      totalTasks: 3,
      doneWeight: 2,
      totalWeight: 10,
    });
    // The predecessor's own record still shows the work it did not finish, marked as handed over.
    expect(h.ledger.sessionProgress('ses_1')).toMatchObject({ doneTasks: 1, totalTasks: 3 });
    const s1 = await h.t.json<SessionTimeline>('GET', '/api/sessions/ses_1/timeline', {
      headers: h.owner.headers,
    });
    expect(s1.manifest[0]!.tasks[1]).toMatchObject({
      taskId: 't2',
      status: 'open',
      carriedToSessionId: 'ses_2',
    });
    await h.mcp(
      'task_done',
      'ses_1',
      { task_id: 't2', evidence: { kind: 'test', ref: 'test/widget.test.ts > store' } },
      409,
    );

    h.toolUsed('ses_2');
    await h.mcp('task_done', 'ses_2', {
      task_id: 't2',
      evidence: { kind: 'test', ref: 'test/widget.test.ts > store' },
    });
    const project = await h.t.json<ProjectTimeline>('GET', `/api/projects/${projectId}/timeline`, {
      headers: h.owner.headers,
    });
    expect(project.manifest[0]!.tasks.map((t) => [t.taskId, t.sessionId, t.status])).toEqual([
      ['t1', 'ses_1', 'done'],
      ['t2', 'ses_2', 'done'],
    ]);
    expect(project.phases[0]).toMatchObject({
      phaseId: 'P1',
      doneWeight: 5,
      totalWeight: 5,
      completedAt: expect.any(String),
    });

    const thread = await h.t.json<ThreadDetail>('GET', `/api/threads/${threadId}`, {
      headers: h.owner.headers,
    });
    expect(thread).toMatchObject({
      threadId,
      projectId,
      activeWriterSessionId: 'ses_2',
      sessionIds: ['ses_1', 'ses_2'],
    });
    expect(thread.writers.map((w) => [w.sessionId, w.reason])).toEqual([
      ['ses_1', 'rollover'],
      ['ses_2', null],
    ]);
    expect(thread.progress).toMatchObject({ doneTasks: 2, totalTasks: 3, doneWeight: 5, totalWeight: 10 });
  });

  it('parallel sessions that never held the writer do not take over tasks', async () => {
    h = await createHarness();
    const projectId = h.project();
    const threadId = h.thread(projectId);
    h.session({ sessionId: 'ses_w', projectId, threadId });
    h.session({ sessionId: 'ses_triage', projectId, threadId, readOnly: true });
    h.ledger.acquireWriter(threadId, 'ses_w', supervisor);
    await h.mcp('declare_plan', 'ses_w', PLAN);
    const r = await h.mcp<DeclarePlanLedgerResult>('declare_plan', 'ses_triage', PLAN);
    expect(r.carriedOver).toBe(0);
    expect(h.ledger.sessionProgress('ses_w')!.totalTasks).toBe(3);
  });
});
