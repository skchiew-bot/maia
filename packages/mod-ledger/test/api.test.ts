import { afterEach, describe, expect, it } from 'vitest';
import type {
  EnhancementDTO,
  ProjectDetail,
  ProjectSummary,
  ProjectTimeline,
  SessionTimeline,
  ThreadDetail,
  ThreadSummary,
} from '@aoc/contracts';
import { LEDGER_TABLES } from '../src';
import { createHarness, PLAN, type Harness } from './harness';

let h: Harness;
afterEach(async () => h?.close());

describe('project & thread API', () => {
  it('creates, lists, reads and updates projects with role checks', async () => {
    h = await createHarness();
    const requester = h.t.user('requester');
    const builder = h.owner.headers;

    expect((await h.t.request('GET', '/api/projects')).status).toBe(401);
    expect((await h.t.request('GET', '/api/projects', { headers: requester.headers })).status).toBe(403);
    expect(
      (await h.t.request('POST', '/api/projects', { headers: requester.headers, body: { name: 'X' } }))
        .status,
    ).toBe(403);
    expect(
      (await h.t.request('POST', '/api/projects', { headers: builder, body: { name: '' } })).status,
    ).toBe(422);
    expect(
      (await h.t.request('POST', '/api/projects', { headers: builder, body: { name: 'X', owner: 'me' } }))
        .status,
    ).toBe(422);

    const p = await h.t.json<ProjectDetail>('POST', '/api/projects', {
      headers: builder,
      body: {
        name: 'Widget Store!',
        description: 'Inventory',
        repoPath: '/srv/widgets',
        defaultBranch: 'main',
      },
      expect: 201,
    });
    expect(p).toMatchObject({
      name: 'Widget Store!',
      slug: 'widget-store',
      repoPath: '/srv/widgets',
      description: 'Inventory',
      defaultBranch: 'main',
      threads: [],
    });
    expect(p.projectId).toMatch(/^prj_/);
    expect(p.progress).toMatchObject({ doneTasks: 0, totalTasks: 0, pct: 0 });
    h.t.clock.advance(1000);
    const p2 = await h.t.json<ProjectDetail>('POST', '/api/projects', {
      headers: builder,
      body: { name: 'widget store' },
      expect: 201,
    });
    expect(p2.slug).toBe('widget-store-2');
    expect(h.events('project.created')[0]!.meta).toEqual({ projectId: p.projectId, slug: 'widget-store' });

    const updated = await h.t.json<ProjectDetail>('PATCH', `/api/projects/${p.projectId}`, {
      headers: builder,
      body: { description: 'Inventory v2' },
    });
    expect(updated).toMatchObject({ name: 'Widget Store!', description: 'Inventory v2' });
    expect(
      (await h.t.request('PATCH', `/api/projects/${p.projectId}`, { headers: builder, body: {} })).status,
    ).toBe(422);
    expect(
      (await h.t.request('PATCH', '/api/projects/prj_nope', { headers: builder, body: { name: 'n' } }))
        .status,
    ).toBe(404);
    expect((await h.t.request('GET', '/api/projects/prj_nope', { headers: builder })).status).toBe(404);
    expect(h.ledger.projectRepoPath(p.projectId)).toBe('/srv/widgets');

    h.session({ sessionId: 'ses_a', projectId: p.projectId });
    h.session({ sessionId: 'ses_old', projectId: p.projectId, lifecycle: 'ended' });
    await h.mcp('declare_plan', 'ses_a', PLAN);
    h.t.decisions!.request(
      {
        kind: 'agent_decision',
        test: 'ambiguity',
        title: 'Q',
        question: 'Which?',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        subjectType: 'session',
        subjectId: 'ses_a',
        sessionId: 'ses_a',
        projectId: p.projectId,
        requesterId: h.owner.user.id,
      },
      { kind: 'agent', id: 'ses_a' },
    );
    const list = await h.t.json<ProjectSummary[]>('GET', '/api/projects', { headers: builder });
    expect(list.map((x) => x.projectId)).toEqual([p.projectId, p2.projectId]);
    expect(list[0]).toMatchObject({
      activeSessions: 1,
      openDecisions: 1,
      progress: { totalTasks: 3, totalWeight: 10 },
      lastActivityAt: h.t.clock.iso(),
    });
  });

  it('creates threads, reports them and records enhancements', async () => {
    h = await createHarness();
    const builder = h.owner.headers;
    const p = await h.t.json<ProjectDetail>('POST', '/api/projects', {
      headers: builder,
      body: { name: 'Widgets' },
      expect: 201,
    });
    const other = await h.t.json<ProjectDetail>('POST', '/api/projects', {
      headers: builder,
      body: { name: 'Other' },
      expect: 201,
    });
    const thread = await h.t.json<ThreadSummary>('POST', `/api/projects/${p.projectId}/threads`, {
      headers: builder,
      body: { title: 'Checkout flow' },
      expect: 201,
    });
    expect(thread).toMatchObject({
      projectId: p.projectId,
      title: 'Checkout flow',
      activeWriterSessionId: null,
    });
    expect(
      (
        await h.t.request('POST', '/api/projects/prj_nope/threads', {
          headers: builder,
          body: { title: 'x' },
        })
      ).status,
    ).toBe(404);
    const detail = await h.t.json<ThreadDetail>('GET', `/api/threads/${thread.threadId}`, {
      headers: builder,
    });
    expect(detail).toMatchObject({ writers: [], sessionIds: [], progress: { totalTasks: 0 } });
    expect((await h.t.request('GET', '/api/threads/thr_nope', { headers: builder })).status).toBe(404);
    expect(
      (
        await h.t.json<ProjectDetail>('GET', `/api/projects/${p.projectId}`, { headers: builder })
      ).threads.map((t) => t.title),
    ).toEqual(['Checkout flow']);

    h.session({ sessionId: 'ses_a', projectId: p.projectId });
    const enh = await h.t.json<EnhancementDTO>('POST', `/api/projects/${p.projectId}/enhancements`, {
      headers: builder,
      body: { title: 'Bulk import', detail: 'CSV upload', sessionId: 'ses_a' },
      expect: 201,
    });
    expect(enh).toMatchObject({
      projectId: p.projectId,
      sessionId: 'ses_a',
      changeId: null,
      by: h.owner.user.id,
      title: 'Bulk import',
    });
    expect(h.events('enhancement.recorded')[0]!.meta).toEqual({
      projectId: p.projectId,
      sessionId: 'ses_a',
      changeId: null,
    });
    expect(
      (
        await h.t.request('POST', `/api/projects/${other.projectId}/enhancements`, {
          headers: builder,
          body: { title: 'x', sessionId: 'ses_a' },
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await h.t.request('POST', `/api/projects/${p.projectId}/enhancements`, {
          headers: h.t.user('requester').headers,
          body: { title: 'x' },
        })
      ).status,
    ).toBe(403);
  });
});

describe('projection', () => {
  it('rebuilds identically from the log and degrades to [erased] after crypto-shredding', async () => {
    h = await createHarness();
    const projectId = h.project();
    const threadId = h.thread(projectId);
    h.session({ sessionId: 'ses_a', projectId, threadId });
    h.ledger.acquireWriter(threadId, 'ses_a', { kind: 'system', id: 'supervisor' });
    await h.mcp('declare_plan', 'ses_a', PLAN);
    h.toolUsed('ses_a', { filePaths: ['/w/src/a.ts'] });
    await h.mcp('task_done', 'ses_a', {
      task_id: 't1',
      evidence: { kind: 'test', ref: 'test/widget.test.ts > a' },
    });
    await h.mcp('amend_plan', 'ses_a', {
      reason: 'scope',
      add: [{ id: 't4', title: 'More', size: 'm', phaseId: 'P2' }],
    });
    await h.mcp('playbook_step', 'ses_a', { step: 'design', state: 'started' });

    const read = async () => ({
      session: await h.t.json<SessionTimeline>('GET', '/api/sessions/ses_a/timeline', {
        headers: h.owner.headers,
      }),
      project: await h.t.json<ProjectTimeline>('GET', `/api/projects/${projectId}/timeline`, {
        headers: h.owner.headers,
      }),
      thread: await h.t.json<ThreadDetail>('GET', `/api/threads/${threadId}`, { headers: h.owner.headers }),
      boundary: h.ledger.boundaryState('ses_a'),
      brief: h.ledger.buildHandoffBrief(threadId, 'ses_a').hash,
    });
    const before = await read();
    h.t.rt.store.rebuildProjections(['ledger']);
    expect(await read()).toEqual(before);
    expect(LEDGER_TABLES.every((t) => t.startsWith('ledger_'))).toBe(true);

    h.t.rt.store.eraseScope('ses_a', { actor: { kind: 'system', id: 'test' }, reason: 'pdpa_request' });
    const erased = await h.t.json<SessionTimeline>('GET', '/api/sessions/ses_a/timeline', {
      headers: h.owner.headers,
    });
    expect(erased.manifest[0]!.tasks[0]).toMatchObject({
      taskId: 't1',
      title: '[erased]',
      status: 'done',
      evidence: { ref: '[erased]', verified: true },
    });
    expect(erased.amendments[0]!.reason).toBe('[erased]');
    expect(erased.progress).toEqual(before.session.progress);

    h.t.rt.store.rebuildProjections(['ledger']);
    const rebuilt = await h.t.json<SessionTimeline>('GET', '/api/sessions/ses_a/timeline', {
      headers: h.owner.headers,
    });
    expect(rebuilt.manifest.flatMap((p) => p.tasks).find((t) => t.taskId === 't1')).toMatchObject({
      title: '[erased]',
      status: 'done',
      weight: 2,
      size: 's',
    });
    expect(h.t.rt.store.projectionHealth()).toEqual([]);
  });
});
