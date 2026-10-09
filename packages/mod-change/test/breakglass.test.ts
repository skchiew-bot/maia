import { afterEach, describe, expect, it } from 'vitest';
import type { BreakglassDTO, ChangeRequestDTO, ChangeService } from '@aoc/contracts';
import { PASSKEY, harness, makeRepo, type Harness, type TestRepo } from './helpers';

const PROJECT = 'prj_ops';
const HOUR = 3_600_000;

describe('break-glass (§8): the most audited path, straight to the approver, provenance bypassed', () => {
  let h: Harness;
  let repo: TestRepo;
  let base: string;
  let hotfix: string;
  afterEach(async () => h?.close());

  async function setup() {
    h = await harness();
    repo = makeRepo({ 'pool.conf': 'size=10\n' });
    base = repo.head();
    repo.git('checkout', '-q', '-b', 'hotfix/pool');
    hotfix = repo.commit('hotfix: raise db pool size', { 'pool.conf': 'size=50\n' }); // no AOC trailer: an orphan
    repo.git('checkout', '-q', 'main');
    h.addProject(PROJECT, repo.dir);
    h.t.llm.on('change.draft', (req) => ({
      impact: `Post-incident: ${req.prompt.includes('DB pool exhausted') ? 'pool exhaustion' : 'unknown'}`,
      mitigation: 'Alert on pool saturation.',
      rollbackPlan: 'Return to the pre-incident commit.',
      rollbackRef: base,
      acceptanceTest: 'npm test',
    }));
  }

  const invoke = () =>
    h.t.json<BreakglassDTO>('POST', '/api/breakglass', {
      headers: h.builder.headers,
      body: { projectId: PROJECT, ref: 'hotfix/pool', justification: 'Checkout is down: DB pool exhausted' },
      expect: 202,
    });
  const get = (id: string) =>
    h.t.json<BreakglassDTO>('GET', `/api/breakglass/${id}`, { headers: h.approver.headers });

  async function invokeAndApprove(): Promise<BreakglassDTO> {
    const bg = await invoke();
    await h.t.decisions!.resolve(bg.decisionId, { optionId: 'approve', ...PASSKEY }, h.approver.user);
    await h.settle();
    return get(bg.breakglassId);
  }

  it('raises a passkey decision for the approver, promotes the recorded SHA bypassing provenance, and auto-drafts the post-incident record', async () => {
    await setup();
    const bg = await invoke();
    expect(bg).toMatchObject({
      status: 'pending',
      sha: hotfix,
      invokedBy: h.builder.user.id,
      justification: 'Checkout is down: DB pool exhausted',
    });
    expect(h.t.decisions!.get(bg.decisionId)).toMatchObject({
      kind: 'break_glass',
      requiredRole: 'approver',
      requiresPasskey: true,
      subjectType: 'breakglass',
      subjectId: bg.breakglassId,
    });
    expect(h.notifications).toContainEqual(
      expect.objectContaining({
        kind: 'breakglass',
        severity: 'danger',
        refs: expect.objectContaining({ breakglassId: bg.breakglassId }),
      }),
    );
    // The normal path would refuse this commit: it traces to no gate.
    const change = h.t.rt.services.get('change') as ChangeService;
    expect(change.provenance(PROJECT, hotfix)).toMatchObject({ ok: false, orphanShas: [hotfix] });

    const approvedAt = h.t.clock.now();
    await h.t.decisions!.resolve(bg.decisionId, { optionId: 'approve', ...PASSKEY }, h.approver.user);
    await h.settle();
    const done = await get(bg.breakglassId);
    expect(done).toMatchObject({
      status: 'approved',
      approval: { approverId: h.approver.user.id, passkeyVerified: true },
      dueAt: new Date(approvedAt + 24 * HOUR).toISOString(),
      overdue: false,
      promotion: {
        status: 'completed',
        breakglass: true,
        breakglassId: bg.breakglassId,
        completion: { mainShaBefore: base, mainShaAfter: hotfix },
      },
    });
    expect(repo.head('main')).toBe(hotfix);
    const completed = h.t.rt.store.list({ types: ['promotion.completed'] })[0]!;
    expect(completed.meta).toMatchObject({
      breakglass: true,
      decisionId: bg.decisionId,
      mainShaAfter: hotfix,
    });
    expect(h.t.rt.store.list({ types: ['promotion.requested'] })[0]!.meta).toMatchObject({
      breakglassId: bg.breakglassId,
      fromSha: hotfix,
    });
    // No remote anywhere: the project's own branch moved as the session user; no credential was used.
    expect(h.sup.calls.every((c) => c.credentialProfile === null)).toBe(true);

    // The mandatory post-incident change record: production scope, owned by the invoker, due in 24h.
    const post = await h.t.json<ChangeRequestDTO>('GET', `/api/changes/${done.postIncidentChangeId}`, {
      headers: h.builder.headers,
    });
    expect(post).toMatchObject({
      status: 'draft',
      scope: 'production',
      breakglassId: bg.breakglassId,
      ownerId: h.builder.user.id,
      draftedBy: 'ai',
      dueAt: done.dueAt,
    });
    expect(post.fields[0]!.draft).toBe('Post-incident: pool exhaustion');
    expect(h.types('breakglass.')).toEqual(['breakglass.invoked', 'breakglass.approved']);
    expect(h.t.rt.store.verifyChain().ok).toBe(true);
  });

  it('flags the post-incident record overdue once it misses its 24h deadline (10-minute job)', async () => {
    await setup();
    const bg = await invokeAndApprove();
    h.notifications.length = 0;
    h.t.clock.advance(23 * HOUR);
    expect(await h.t.rt.tickJobs()).toContain('change.breakglass-overdue');
    expect(h.types('breakglass.post_incident_overdue')).toEqual([]);
    h.t.clock.advance(HOUR + 60_000);
    await h.t.rt.runJob('change.breakglass-overdue');
    const overdue = h.t.rt.store.list({ types: ['breakglass.post_incident_overdue'] });
    expect(overdue.map((e) => e.meta)).toEqual([
      { breakglassId: bg.breakglassId, changeId: bg.postIncidentChangeId, dueAt: bg.dueAt },
    ]);
    expect(h.notifications).toEqual([expect.objectContaining({ kind: 'breakglass', severity: 'danger' })]);
    expect(await get(bg.breakglassId)).toMatchObject({ overdue: true, overdueFlaggedAt: h.t.clock.iso() });
    h.t.clock.advance(10 * 60_000);
    expect(await h.t.rt.tickJobs()).toContain('change.breakglass-overdue');
    expect(h.t.rt.store.list({ types: ['breakglass.post_incident_overdue'] })).toHaveLength(1);
  });

  it('a post-incident record completed in time is never flagged', async () => {
    await setup();
    const bg = await invokeAndApprove();
    const id = bg.postIncidentChangeId!;
    for (const field of ['impact', 'mitigation', 'rollbackPlan', 'acceptanceTest']) {
      await h.t.json('POST', `/api/changes/${id}/fields/${field}`, {
        headers: h.builder.headers,
        body: { value: `Reviewed ${field} after the incident`, dwellMs: 20_000 },
      });
    }
    const submitted = await h.t.json<ChangeRequestDTO>('POST', `/api/changes/${id}/submit`, {
      headers: h.builder.headers,
    });
    expect(h.t.decisions!.get(submitted.decisionId!)).toMatchObject({
      kind: 'change_request',
      requiredRole: 'approver',
    });
    await h.t.decisions!.resolve(submitted.decisionId!, { optionId: 'approve' }, h.approver.user);
    await h.settle();
    expect(
      (
        await h.t.json<ChangeRequestDTO>('POST', `/api/changes/${id}/complete`, {
          headers: h.builder.headers,
        })
      ).status,
    ).toBe('completed');
    h.t.clock.advance(25 * HOUR);
    await h.t.rt.runJob('change.breakglass-overdue');
    expect(h.types('breakglass.post_incident_overdue')).toEqual([]);
    expect(await get(bg.breakglassId)).toMatchObject({ overdue: false, postIncidentStatus: 'completed' });
  });

  it('rejection leaves main untouched; requesters cannot invoke; a ref must resolve', async () => {
    await setup();
    const bg = await invoke();
    await h.t.decisions!.resolve(
      bg.decisionId,
      { optionId: 'reject', comment: 'Fail over to the replica instead', ...PASSKEY },
      h.approver.user,
    );
    await h.settle();
    expect(await get(bg.breakglassId)).toMatchObject({
      status: 'rejected',
      postIncidentChangeId: null,
      promotion: null,
      rejection: { comment: 'Fail over to the replica instead' },
    });
    expect(repo.head('main')).toBe(base);
    expect(h.t.rt.store.list({ typePrefix: 'promotion.' })).toHaveLength(0);
    const requester = h.t.user('requester');
    expect(
      (
        await h.t.request('POST', '/api/breakglass', {
          headers: requester.headers,
          body: { projectId: PROJECT, ref: 'main', justification: 'Production is down!!' },
        })
      ).status,
    ).toBe(403);
    const res = await h.t.request('POST', '/api/breakglass', {
      headers: h.builder.headers,
      body: { projectId: PROJECT, ref: 'nope/branch', justification: 'Production is down!!' },
    });
    expect(res.status).toBe(422);
  });
});
