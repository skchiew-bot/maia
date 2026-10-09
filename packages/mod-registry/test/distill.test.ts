import { describe, expect, it } from 'vitest';
import type { DistillResponse, MetaOf, PlaybookDTO } from '@aoc/contracts';
import type { TestRuntime } from '@aoc/kernel';
import { candidateSteps, digestRun, fileArea } from '../src';
import {
  declarePlan,
  ended,
  launch,
  LLM_PLAYBOOK,
  PHASES,
  rollover,
  seedRun,
  start,
  taskDone,
  toolUsed,
} from './helpers';

const distill = (t: TestRuntime, headers: Record<string, string>, sessionId: string) =>
  t.request('POST', '/api/playbooks/distill', { headers, body: { sessionId } });
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string; details?: { reason?: string } } }).error;

describe('distillation engine: proposal → Approver gate → active playbook', () => {
  it('distills a successful run with the LLM, raises a playbook_approval decision and binds the playbook on approval', async () => {
    const t = await start();
    t.llm.on('registry.distill', LLM_PLAYBOOK);
    await seedRun(t, { sessionId: 'ses_run1' });
    const curator = t.user('builder', 'Curator');
    const ceo = t.user('approver', 'CEO');

    const res = await distill(t, curator.headers, 'ses_run1');
    expect(res.status).toBe(201);
    const out = (await res.json()) as DistillResponse;
    expect(out.method).toBe('llm');
    expect(out.playbook).toMatchObject({
      processType: 'feature-build',
      version: 1,
      status: 'proposed',
      active: false,
      title: LLM_PLAYBOOK.title,
      sourceSessionId: 'ses_run1',
      proposedBy: curator.user.id,
    });
    expect(out.playbook.steps.map((s) => s.id)).toEqual(['design-endpoint', 'test-endpoint', 'document']);

    // The LLM was asked on the distillation model with the JSON schema, and saw the run's ordered tasks, tools and areas.
    const call = t.llm.calls.at(-1)!;
    expect(call).toMatchObject({ purpose: 'registry.distill', model: 'sonnet' });
    expect((call.schema as { required: string[] }).required).toEqual(['title', 'steps', 'rationale']);
    expect(call.prompt.indexOf('Add the orders endpoint')).toBeLessThan(
      call.prompt.indexOf('Write endpoint tests'),
    );
    expect(call.prompt).toContain('Tools: Edit×1, Read×1');
    expect(call.prompt).toContain('Areas: src/api');
    expect(call.prompt).toContain('UUIDs (Ids must not leak order volume)');
    expect(call.prompt).not.toContain('/etc/passwd');
    expect(call.system).toMatch(/untrusted data/);

    // Audited proposal: own body scope, method in the clear-text meta; gate = Approver.
    const [proposed] = t.rt.store.list({ types: ['playbook.proposed'] });
    expect(proposed!.meta).toMatchObject({
      playbookId: out.playbook.playbookId,
      method: 'llm',
      stepCount: 3,
      decisionId: out.decisionId,
      sourceSessionId: 'ses_run1',
    });
    expect(proposed!.bodyScope).toBe(out.playbook.playbookId);
    const card = t.decisions!.get(out.decisionId)!;
    expect(card).toMatchObject({
      kind: 'playbook_approval',
      requiredRole: 'approver',
      subjectType: 'playbook',
      subjectId: out.playbook.playbookId,
      status: 'open',
      requesterId: curator.user.id,
    });
    expect(card.question).toMatch(/launch on sonnet instead of opus/);
    expect(t.rt.services.get('registry').modelFor('feature-build')).toBe('opus');

    // Builders cannot pass the gate; the curator could not either (separation of duties). The Approver can.
    await expect(t.decisions!.resolve(out.decisionId, { optionId: 'approve' }, curator.user)).rejects.toThrow(
      /separation_of_duties|role/,
    );
    await t.decisions!.resolve(out.decisionId, { optionId: 'approve', comment: 'Good flow' }, ceo.user);
    await t.drain();

    const [approved] = t.rt.store.list({ types: ['playbook.approved'] });
    expect(approved!.meta).toEqual({
      playbookId: out.playbook.playbookId,
      decisionId: out.decisionId,
      approverId: ceo.user.id,
    });
    expect(approved!.actor).toEqual({ kind: 'human', id: ceo.user.id });
    const reg = t.rt.services.get('registry');
    expect(reg.activePlaybook('feature-build')).toMatchObject({
      playbookId: out.playbook.playbookId,
      status: 'approved',
      version: 1,
    });
    expect(reg.modelFor('feature-build')).toBe('sonnet');

    const pb = await t.json<PlaybookDTO>('GET', `/api/playbooks/${out.playbook.playbookId}`, {
      headers: curator.headers,
    });
    expect(pb).toMatchObject({ status: 'approved', active: true, approvedBy: ceo.user.id });
    expect(
      await t.json<PlaybookDTO[]>('GET', '/api/playbooks?processType=feature-build&status=approved', {
        headers: curator.headers,
      }),
    ).toHaveLength(1);
    expect(
      await t.json<PlaybookDTO[]>('GET', '/api/playbooks?status=proposed', { headers: curator.headers }),
    ).toHaveLength(0);
    expect((await t.request('GET', '/api/playbooks/pbk_missing', { headers: curator.headers })).status).toBe(
      404,
    );

    // Replaying the decision does not approve twice (idempotent reactor).
    const resolved = t.rt.store
      .list({ types: ['decision.resolved'] })
      .find((e) => (e.meta as MetaOf<'decision.resolved'>).decisionId === out.decisionId)!;
    t.rt.modules.find((m) => m.name === 'registry')!.reactors![0]!.react(resolved, null, t.rt.ctx);
    expect(t.rt.store.list({ types: ['playbook.approved'] })).toHaveLength(1);
    expect(t.rt.store.verifyChain().ok).toBe(true);
    await t.close();
  });

  it('falls back to the ordered task titles when the LLM fails or returns junk', async () => {
    const t = await start();
    await seedRun(t, { sessionId: 'ses_run1' });
    const curator = t.user('builder');
    const res = await distill(t, curator.headers, 'ses_run1'); // FakeLlm has no responder → throws
    expect(res.status).toBe(201);
    const out = (await res.json()) as DistillResponse;
    expect(out.method).toBe('fallback');
    expect(out.playbook.steps.map((s) => s.title)).toEqual(
      PHASES.flatMap((p) => p.tasks.map((x) => x.title)),
    );
    expect(out.playbook.steps[0]!.detail).toContain('Done when: POST /orders returns 201');
    expect(out.playbook.steps[1]!.detail).toContain(
      'Drift: scope_growth (medium): Also touched the shared validation helper',
    );
    expect(out.playbook.rationale).toMatch(/^Deterministic fallback \(llm_error\)/);

    // Junk from the model is never trusted either.
    const t2 = await start();
    t2.llm.on('registry.distill', { title: 'x', steps: 'not-an-array' });
    await seedRun(t2, { sessionId: 'ses_run2' });
    const out2 = (await (
      await distill(t2, t2.user('builder').headers, 'ses_run2')
    ).json()) as DistillResponse;
    expect(out2.method).toBe('fallback');
    expect(out2.playbook.rationale).toMatch(/llm_invalid_output/);
    expect(t2.rt.store.list({ types: ['playbook.proposed'] })[0]!.meta).toMatchObject({ method: 'fallback' });
    await t.close();
    await t2.close();
  });

  it('normalises LLM step ids into unique slugs', async () => {
    const t = await start();
    t.llm.on('registry.distill', {
      title: 'Endpoint playbook',
      steps: [
        { id: 'Step One!', title: 'A', detail: 'a' },
        { id: 'step-one', title: 'B', detail: 'b' },
        { id: '', title: 'C', detail: '' },
        { id: 'step-one', title: 'D', detail: 'd' },
      ],
      rationale: '',
    });
    await seedRun(t, { sessionId: 'ses_run1' });
    const out = (await (await distill(t, t.user('builder').headers, 'ses_run1')).json()) as DistillResponse;
    expect(out.playbook.steps.map((s) => s.id)).toEqual(['step-one', 'step-one-2', 's3', 'step-one-3']);
    expect(out.playbook.steps[2]).toEqual({ id: 's3', title: 'C' });
    expect(out.playbook.rationale).toBeNull();
    await t.close();
  });

  it('a rejection discards the proposal; the run can be distilled again', async () => {
    const t = await start();
    t.llm.on('registry.distill', LLM_PLAYBOOK);
    await seedRun(t, { sessionId: 'ses_run1' });
    const curator = t.user('builder');
    const ceo = t.user('approver');
    const out = (await (await distill(t, curator.headers, 'ses_run1')).json()) as DistillResponse;
    await t.decisions!.resolve(out.decisionId, { optionId: 'reject', comment: 'Too vague' }, ceo.user);
    await t.drain();
    expect(t.rt.store.list({ types: ['playbook.rejected'] })[0]!.meta).toMatchObject({
      playbookId: out.playbook.playbookId,
      approverId: ceo.user.id,
    });
    expect(t.rt.services.get('registry').activePlaybook('feature-build')).toBeNull();
    const again = await distill(t, curator.headers, 'ses_run1');
    expect(again.status).toBe(201);
    expect(((await again.json()) as DistillResponse).playbook.version).toBe(2);
    await t.close();
  });
});

describe('distillation engine: refusals', () => {
  it('only distills successful runs: ended completed with every declared task done', async () => {
    const t = await start();
    const curator = t.user('builder');
    await seedRun(t, { sessionId: 'ses_running', outcome: null });
    await seedRun(t, { sessionId: 'ses_failed', outcome: 'failed' });
    await seedRun(t, { sessionId: 'ses_open', skipLastTask: true });
    launch(t, { sessionId: 'ses_noplan', processType: 'feature-build' });
    ended(t, 'ses_noplan');
    // Every task descoped by an (audited) amendment: complete, but nothing was actually built.
    launch(t, { sessionId: 'ses_descoped', processType: 'feature-build' });
    declarePlan(t, 'ses_descoped', [{ id: 'p1', name: 'Only', tasks: [{ id: 't1', title: 'Never done' }] }]);
    t.rt.store.append({
      type: 'plan.amended',
      actor: { kind: 'agent', id: 'ses_descoped' },
      scope: { sessionId: 'ses_descoped', projectId: 'prj_shop' },
      meta: {
        sessionId: 'ses_descoped',
        projectId: 'prj_shop',
        manifestVersion: 2,
        added: 0,
        removed: 1,
        resized: 0,
        prevTotalWeight: 3,
        newTotalWeight: 0,
      },
      payload: { reason: 'Out of scope after review', remove: ['t1'] },
      source: 'mcp',
    });
    ended(t, 'ses_descoped');

    const cases: [string, number, string, string | undefined][] = [
      ['ses_running', 422, 'run_not_successful', 'not_ended'],
      ['ses_failed', 422, 'run_not_successful', 'not_completed'],
      ['ses_open', 422, 'run_not_successful', 'tasks_open'],
      ['ses_noplan', 422, 'run_not_successful', 'no_plan'],
      ['ses_descoped', 422, 'run_not_successful', 'no_tasks_done'],
      ['ses_unknown', 404, 'run_not_found', undefined],
    ];
    for (const [sessionId, status, code, reason] of cases) {
      const res = await distill(t, curator.headers, sessionId);
      expect(res.status, sessionId).toBe(status);
      const err = await errorOf(res);
      expect(err.code, sessionId).toBe(code);
      expect(err.details?.reason, sessionId).toBe(reason);
    }
    expect(t.rt.store.list({ types: ['playbook.proposed'] })).toHaveLength(0);
    expect(t.decisions!.list({ kind: ['playbook_approval'] })).toHaveLength(0);
    expect(t.llm.calls).toHaveLength(0);
    await t.close();
  });

  it('needs learning.curate; requesters and anonymous callers are refused', async () => {
    const t = await start();
    await seedRun(t, { sessionId: 'ses_run1' });
    expect((await distill(t, t.user('requester').headers, 'ses_run1')).status).toBe(403);
    expect((await distill(t, {}, 'ses_run1')).status).toBe(401);
    expect(
      (
        await t.request('POST', '/api/playbooks/distill', {
          headers: t.user('builder').headers,
          body: { session: 'x' },
        })
      ).status,
    ).toBe(422);
    await t.close();
  });

  it('refuses runs inside an AOC platform repository (self-modification boundary, §13) and explains why', async () => {
    const t = await start({ config: { selfModification: { aocRepoPaths: ['/srv/aoc'] } } });
    t.llm.on('registry.distill', LLM_PLAYBOOK);
    await seedRun(t, { sessionId: 'ses_self', cwd: '/srv/aoc/packages/mod-credits' });
    await seedRun(t, { sessionId: 'ses_lookalike', processType: 'bug-fix', cwd: '/srv/aoc-customer-app' });
    const curator = t.user('builder');

    const res = await distill(t, curator.headers, 'ses_self');
    expect(res.status).toBe(403);
    const err = await errorOf(res);
    expect(err.code).toBe('self_modification_boundary');
    expect(err.message).toMatch(/self-modification boundary \(§13\)/);
    expect(err.message).toContain('/srv/aoc/packages/mod-credits');
    expect(err.message).toMatch(/governance, audit and credit core/);
    expect(err.details?.reason).toBe('aoc_repo');
    expect(t.rt.store.list({ types: ['playbook.proposed'] })).toHaveLength(0);
    expect(t.llm.calls).toHaveLength(0);

    // A sibling directory that merely shares the prefix is not the AOC repo.
    expect((await distill(t, curator.headers, 'ses_lookalike')).status).toBe(201);
    await t.close();
  });

  it('fails closed when the boundary cannot be checked (working directory unknown)', async () => {
    const t = await start({ config: { selfModification: { aocRepoPaths: ['/srv/aoc'] } } });
    await seedRun(t, { sessionId: 'ses_erased' });
    t.rt.store.eraseScope('ses_erased', { actor: { kind: 'human', id: 'usr_ceo' }, reason: 'secret_leak' });
    const res = await distill(t, t.user('builder').headers, 'ses_erased');
    expect(res.status).toBe(403);
    expect((await errorOf(res)).details?.reason).toBe('cwd_unknown');
    await t.close();
  });

  it('one proposal at a time: the same run twice, or a second run while one is pending, is a conflict', async () => {
    const t = await start();
    t.llm.on('registry.distill', LLM_PLAYBOOK);
    await seedRun(t, { sessionId: 'ses_run1' });
    await seedRun(t, { sessionId: 'ses_run2' });
    const curator = t.user('builder');
    expect((await distill(t, curator.headers, 'ses_run1')).status).toBe(201);
    const dup = await distill(t, curator.headers, 'ses_run1');
    expect(dup.status).toBe(409);
    expect((await errorOf(dup)).code).toBe('already_distilled');
    const pending = await distill(t, curator.headers, 'ses_run2');
    expect(pending.status).toBe(409);
    expect((await errorOf(pending)).code).toBe('proposal_pending');
    await t.close();
  });
});

describe('playbook lifecycle: retire and supersede', () => {
  it('retiring the active playbook sends the type back to its discovery model; retiring a proposal withdraws its decision', async () => {
    const t = await start();
    t.llm.on('registry.distill', LLM_PLAYBOOK);
    await seedRun(t, { sessionId: 'ses_run1' });
    await seedRun(t, { sessionId: 'ses_run2' });
    const curator = t.user('builder');
    const ceo = t.user('approver');
    const reg = t.rt.services.get('registry');

    const v1 = (await (await distill(t, curator.headers, 'ses_run1')).json()) as DistillResponse;
    await t.decisions!.resolve(v1.decisionId, { optionId: 'approve' }, ceo.user);
    await t.drain();
    expect(reg.modelFor('feature-build')).toBe('sonnet');

    const retired = await t.json<PlaybookDTO>('POST', `/api/playbooks/${v1.playbook.playbookId}/retire`, {
      headers: curator.headers,
      body: { reason: 'obsolete' },
    });
    expect(retired).toMatchObject({ status: 'retired', retireReason: 'obsolete', active: false });
    expect(reg.activePlaybook('feature-build')).toBeNull();
    expect(reg.modelFor('feature-build')).toBe('opus');
    expect(
      (
        await t.request('POST', `/api/playbooks/${v1.playbook.playbookId}/retire`, {
          headers: curator.headers,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await t.request('POST', `/api/playbooks/${v1.playbook.playbookId}/retire`, {
          headers: t.user('requester').headers,
        })
      ).status,
    ).toBe(403);

    const v2 = (await (await distill(t, curator.headers, 'ses_run2')).json()) as DistillResponse;
    expect(v2.playbook.version).toBe(2);
    const res = await t.request('POST', `/api/playbooks/${v2.playbook.playbookId}/retire`, {
      headers: curator.headers,
    }); // no body → manual
    expect(res.status).toBe(200);
    await t.drain();
    expect(t.decisions!.get(v2.decisionId)!.status).toBe('withdrawn');
    const v2Retirements = t.rt.store
      .list({ types: ['playbook.retired'] })
      .filter((e) => (e.meta as MetaOf<'playbook.retired'>).playbookId === v2.playbook.playbookId);
    expect(v2Retirements.map((e) => (e.meta as MetaOf<'playbook.retired'>).reason)).toEqual(['manual']);
    await t.close();
  });

  it('approving a newer version supersedes the active one', async () => {
    const t = await start();
    t.llm.on('registry.distill', LLM_PLAYBOOK);
    await seedRun(t, { sessionId: 'ses_run1' });
    await seedRun(t, { sessionId: 'ses_run2' });
    const curator = t.user('builder');
    const ceo = t.user('approver');
    const v1 = (await (await distill(t, curator.headers, 'ses_run1')).json()) as DistillResponse;
    await t.decisions!.resolve(v1.decisionId, { optionId: 'approve' }, ceo.user);
    await t.drain();
    const v2 = (await (await distill(t, curator.headers, 'ses_run2')).json()) as DistillResponse;
    await t.decisions!.resolve(v2.decisionId, { optionId: 'approve' }, ceo.user);
    await t.drain();
    const list = await t.json<PlaybookDTO[]>('GET', '/api/playbooks?processType=feature-build', {
      headers: curator.headers,
    });
    expect(list.map((p) => [p.version, p.status, p.active, p.retireReason])).toEqual([
      [2, 'approved', true, null],
      [1, 'retired', false, 'superseded'],
    ]);
    expect(t.rt.services.get('registry').activePlaybook('feature-build')?.version).toBe(2);
    await t.close();
  });
});

describe('distillation inputs', () => {
  it('follows a context-rollover chain: tasks across successor sessions form one run', async () => {
    const t = await start();
    launch(t, { sessionId: 'ses_a', processType: 'feature-build' });
    declarePlan(t, 'ses_a', PHASES);
    toolUsed(t, 'ses_a', 'Edit', ['/work/shop/src/api/orders.ts'], true);
    taskDone(t, 'ses_a', 't1', 'p1');
    ended(t, 'ses_a', 'retired');
    launch(t, { sessionId: 'ses_b', processType: 'feature-build' });
    rollover(t, 'ses_a', 'ses_b');
    toolUsed(t, 'ses_b', 'Write', ['/work/shop/test/orders.test.ts'], true);
    taskDone(t, 'ses_b', 't2', 'p1');
    taskDone(t, 'ses_b', 't3', 'p2');
    ended(t, 'ses_b', 'completed');
    const out = (await (await distill(t, t.user('builder').headers, 'ses_a')).json()) as DistillResponse;
    expect(out.playbook.steps.map((s) => s.title)).toEqual([
      'Add the orders endpoint',
      'Write endpoint tests',
      'Update the API docs',
    ]);
    expect(out.playbook.sourceSessionId).toBe('ses_b');
    await t.close();
  });

  it('maps file paths to coarse areas and never leaks paths outside the session cwd', () => {
    expect(fileArea('/work/shop/packages/kernel/src/store.ts', '/work/shop')).toBe('packages/kernel');
    expect(fileArea('src/api/orders.ts', null)).toBe('src/api');
    expect(fileArea('/work/shop/README.md', '/work/shop/')).toBe('(root)');
    expect(fileArea('/home/alice/.ssh/id_rsa', '/work/shop')).toBeNull();
    expect(fileArea('../secrets/x.txt', '/work/shop')).toBeNull();
    expect(candidateSteps(digestRun([]))).toEqual([]);
  });
});
