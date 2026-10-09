import { afterEach, describe, expect, it } from 'vitest';
import type { ChangeRequestDTO, ChangeService, LedgerService } from '@aoc/contracts';
import {
  approveChange,
  cloneGit,
  cloneRef,
  draftAndAffirm,
  harness,
  makeRepo,
  type Harness,
  type TestRepo,
} from './helpers';

const DRAFT = {
  impact: 'Changes the session cookie format; every logged-in user is re-authenticated once.',
  mitigation: 'Dual-read both cookie formats for a week; alert on login failure rate.',
  rollbackPlan: 'Revert to the pinned tag and redeploy.',
  rollbackRef: 'v1.0.0',
  acceptanceTest: 'npm test',
};

describe('change requests (§8, §14)', () => {
  let h: Harness;
  let repo: TestRepo;
  afterEach(async () => h?.close());

  async function setup(ledger?: Partial<LedgerService>) {
    h = await harness({ ledger });
    repo = makeRepo();
    repo.git('tag', '-a', 'v1.0.0', '-m', 'release 1.0.0');
    h.addProject('prj_app', repo.dir);
  }

  it('drafts the four fields with the LLM (sonnet, change.draft, JSON schema) using session context', async () => {
    await setup({
      projectRepoPath: () => null,
      sessionProgress: () => ({
        doneTasks: 2,
        totalTasks: 5,
        doneWeight: 4,
        totalWeight: 10,
        pct: 40,
        flaggedTasks: 0,
        phases: [],
        etaMs: null,
        etaHiddenReason: 'fewer_than_3_done',
      }),
      buildHandoffBrief: (threadId, fromSessionId) => ({
        threadId,
        projectId: 'prj_app',
        fromSessionId,
        text: 'BRIEF: cookie rotation half done',
        openTaskIds: [],
        openDecisionIds: [],
        filePointers: [],
        hash: 'h',
      }),
    });
    h.t.sessions!.add({
      sessionId: 'ses_work',
      projectId: 'prj_app',
      threadId: 'thr_1',
      ownerId: h.builder.user.id,
    });
    h.t.llm.on('change.draft', DRAFT);
    const c = await h.t.json<ChangeRequestDTO>('POST', '/api/changes', {
      headers: h.builder.headers,
      body: { projectId: 'prj_app', scope: 'main', title: 'Rotate session cookies', sessionId: 'ses_work' },
      expect: 201,
    });
    expect(c).toMatchObject({
      status: 'draft',
      draftedBy: 'ai',
      ownerId: h.builder.user.id,
      rollbackRef: 'v1.0.0',
      affirmedCount: 0,
      sessionId: 'ses_work',
    });
    expect(c.fields.map((f) => [f.field, f.draft === f.value, f.affirmed])).toEqual([
      ['impact', true, false],
      ['mitigation', true, false],
      ['rollbackPlan', true, false],
      ['acceptanceTest', true, false],
    ]);
    const call = h.t.llm.calls[0]!;
    expect(call).toMatchObject({ purpose: 'change.draft', model: 'sonnet' });
    expect(call.schema).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['impact', 'rollbackRef']),
    });
    expect(call.prompt).toContain('BRIEF: cookie rotation half done');
    expect(call.prompt).toContain('2/5 tasks done');
    expect(call.prompt).toContain('Rotate session cookies');
    // Free text lives in the encrypted payload; the chained meta carries ids and enums only.
    const drafted = h.t.rt.store.list({ types: ['change.drafted'] })[0]!;
    expect(drafted.meta).toMatchObject({
      changeId: c.changeId,
      draftedBy: 'ai',
      sessionId: 'ses_work',
      breakglassId: null,
    });
    expect(JSON.stringify(drafted.meta)).not.toContain('cookie');
  });

  it('falls back to an empty human draft when the LLM fails', async () => {
    await setup();
    const c = await h.t.json<ChangeRequestDTO>('POST', '/api/changes', {
      headers: h.builder.headers,
      body: { projectId: 'prj_app', scope: 'data', title: 'Backfill orders' },
      expect: 201,
    });
    expect(c.draftedBy).toBe('human');
    expect(c.fields.every((f) => f.draft === '')).toBe(true);
    // Every field must now be supplied: an empty draft "edited" into text is a full edit.
    const r = await h.t.json<ChangeRequestDTO & { affirmation: { edited: boolean; editRatio: number } }>(
      'POST',
      `/api/changes/${c.changeId}/fields/impact`,
      {
        headers: h.builder.headers,
        body: { value: 'Rewrites 2M order rows.', dwellMs: 1000 },
      },
    );
    expect(r.affirmation).toMatchObject({ edited: true, editRatio: 1 });
  });

  it('cannot be submitted until all four fields are supplied and affirmed; rollbackRef must be an exact, resolvable ref', async () => {
    await setup();
    h.t.llm.on('change.draft', DRAFT);
    const { changeId } = await h.t.json<{ changeId: string }>('POST', '/api/changes', {
      headers: h.builder.headers,
      body: { projectId: 'prj_app', scope: 'main', title: 'Rotate cookies' },
      expect: 201,
    });
    const submit = () =>
      h.t.request('POST', `/api/changes/${changeId}/submit`, { headers: h.builder.headers });
    let res = await submit();
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: {
        code: 'fields_not_affirmed',
        details: { missing: ['impact', 'mitigation', 'rollbackPlan', 'acceptanceTest'] },
      },
    });

    const affirm = (field: string, body: Record<string, unknown>) =>
      h.t.request('POST', `/api/changes/${changeId}/fields/${field}`, { headers: h.builder.headers, body });
    for (const field of ['impact', 'mitigation', 'acceptanceTest'])
      expect((await affirm(field, { value: 'reviewed: ' + field, dwellMs: 6000 })).status).toBe(200);
    res = await submit();
    expect(
      ((await res.json()) as { error: { details: { missing: string[] } } }).error.details.missing,
    ).toEqual(['rollbackPlan']);

    const code = async (r: Response) => ((await r.json()) as { error?: { code: string } }).error?.code;
    expect(
      await code(
        await affirm('rollbackPlan', { value: 'Return to main', dwellMs: 6000, rollbackRef: 'main' }),
      ),
    ).toBe('rollback_ref_not_immutable');
    expect(
      await code(
        await affirm('rollbackPlan', { value: 'Return', dwellMs: 6000, rollbackRef: 'deadbeefdeadbeef' }),
      ),
    ).toBe('rollback_ref_unresolvable');
    expect(await code(await affirm('rollbackPlan', { value: '   ', dwellMs: 6000 }))).toBe('empty_value');
    expect((await affirm('nonsense', { value: 'x', dwellMs: 1 })).status).toBe(404);
    const sha = repo.head();
    expect(
      (
        await affirm('rollbackPlan', {
          value: 'Return to the initial commit',
          dwellMs: 6000,
          rollbackRef: sha,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await affirm('rollbackPlan', {
          value: 'Return to the release tag',
          dwellMs: 6000,
          rollbackRef: 'v1.0.0',
        })
      ).status,
    ).toBe(200);

    res = await submit();
    expect(res.status).toBe(200);
    const c = (await res.json()) as ChangeRequestDTO;
    expect(c).toMatchObject({
      status: 'submitted',
      rollbackRef: 'v1.0.0',
      rollbackSha: repo.head('v1.0.0^{commit}'),
      selfApprovable: false,
    });
    // Fields are locked once submitted.
    expect(await code(await affirm('impact', { value: 'late edit', dwellMs: 9000 }))).toBe('not_editable');
  });

  it('builders self-approve reversible off-main work — still a full change record — but nothing else', async () => {
    await setup();
    const sha = repo.head();
    const offMain = await draftAndAffirm(h, {
      projectId: 'prj_app',
      scope: 'reversible_off_main',
      owner: h.builder,
      rollbackRef: sha,
    });
    const c = await h.t.json<ChangeRequestDTO>('POST', `/api/changes/${offMain}/submit`, {
      headers: h.builder.headers,
    });
    expect(c).toMatchObject({
      status: 'approved',
      selfApprovable: true,
      decisionId: null,
      approval: { approverId: h.builder.user.id, selfApproved: true },
    });
    expect(h.types('change.')).toEqual([
      'change.drafted',
      'change.field_affirmed',
      'change.field_affirmed',
      'change.field_affirmed',
      'change.field_affirmed',
      'change.submitted',
      'change.approved',
    ]);
    expect(h.t.decisions!.list({ kind: ['change_request'] })).toHaveLength(0);

    // Main-touching work by a builder goes to the approver.
    const onMain = await draftAndAffirm(h, {
      projectId: 'prj_app',
      scope: 'main',
      owner: h.builder,
      rollbackRef: sha,
    });
    const submitted = await h.t.json<ChangeRequestDTO>('POST', `/api/changes/${onMain}/submit`, {
      headers: h.builder.headers,
    });
    expect(submitted.status).toBe('submitted');
    const card = h.t.decisions!.get(submitted.decisionId!)!;
    expect(card).toMatchObject({
      kind: 'change_request',
      requiredRole: 'approver',
      subjectType: 'change',
      subjectId: onMain,
      requesterId: h.builder.user.id,
    });
    expect(card.context).toContain('Touches the login flow');

    // An approver submitting reversible off-main work does not self-approve: the decision bounces to an approver.
    const approverOwned = await draftAndAffirm(h, {
      projectId: 'prj_app',
      scope: 'reversible_off_main',
      owner: h.approver,
      rollbackRef: sha,
    });
    const byApprover = await h.t.json<ChangeRequestDTO>('POST', `/api/changes/${approverOwned}/submit`, {
      headers: h.approver.headers,
    });
    expect(byApprover.status).toBe('submitted');
    expect(h.t.decisions!.get(byApprover.decisionId!)).toMatchObject({
      requiredRole: 'approver',
      excludedApproverIds: [h.approver.user.id],
    });
  });

  it('approval and rejection flow through the decision reactor; only approved work starts, completion pins a tag', async () => {
    await setup();
    const sha = repo.head();
    h.t.sessions!.add({ sessionId: 'ses_build', projectId: 'prj_app' });
    const changeId = await draftAndAffirm(h, {
      projectId: 'prj_app',
      scope: 'production',
      owner: h.builder,
      rollbackRef: sha,
    });
    const submitted = await h.t.json<ChangeRequestDTO>('POST', `/api/changes/${changeId}/submit`, {
      headers: h.builder.headers,
    });
    const start = () =>
      h.t.request('POST', `/api/changes/${changeId}/start`, {
        headers: h.builder.headers,
        body: { sessionId: 'ses_build' },
      });
    expect((await start()).status).toBe(409);
    await expect(
      h.t.decisions!.resolve(submitted.decisionId!, { optionId: 'approve' }, h.builder.user),
    ).rejects.toThrow(/separation_of_duties|role/);
    await h.t.decisions!.resolve(submitted.decisionId!, { optionId: 'approve' }, h.approver.user);
    await h.settle();
    await h.settle(); // reactor follow-ups are idempotent
    const approved = h.t.rt.store.list({ types: ['change.approved'] });
    expect(approved).toHaveLength(1);
    expect(approved[0]!.meta).toEqual({
      changeId,
      decisionId: submitted.decisionId,
      approverId: h.approver.user.id,
      selfApproved: false,
    });

    expect(
      (
        await h.t.request('POST', `/api/changes/${changeId}/start`, {
          headers: h.builder.headers,
          body: { sessionId: 'ses_unknown' },
        })
      ).status,
    ).toBe(404);
    expect((await start()).status).toBe(200);
    expect((await start()).status).toBe(200);
    expect(h.t.rt.store.list({ types: ['change.started'] })).toHaveLength(1);

    const work = repo.commit('feat: rotate cookies\n\nAOC-Session: ses_build', {
      'src/cookie.ts': 'export const v = 2;\n',
    });
    const done = await h.t.json<ChangeRequestDTO>('POST', `/api/changes/${changeId}/complete`, {
      headers: h.builder.headers,
    });
    expect(done).toMatchObject({ status: 'completed', pinnedSha: work, pinnedTag: `aoc/change/${changeId}` });
    // The pin is an annotated tag in the service clone, where no agent can move it; the project repository has none.
    expect(cloneGit(h, 'prj_app', 'cat-file', '-t', `refs/tags/aoc/change/${changeId}`).stdout.trim()).toBe('tag');
    expect(cloneRef(h, 'prj_app', `refs/tags/aoc/change/${changeId}^{commit}`)).toBe(work);
    expect(() => repo.git('rev-parse', '--verify', `refs/tags/aoc/change/${changeId}`)).toThrow();
    expect(h.t.rt.store.list({ types: ['git.ref_pinned'] })[0]!.meta).toEqual({
      projectId: 'prj_app',
      tag: `aoc/change/${changeId}`,
      sha: work,
      reason: 'change.completed',
    });

    // A rejected change can never start.
    const rejected = await draftAndAffirm(h, {
      projectId: 'prj_app',
      scope: 'data',
      owner: h.builder,
      rollbackRef: sha,
    });
    const r = await h.t.json<ChangeRequestDTO>('POST', `/api/changes/${rejected}/submit`, {
      headers: h.builder.headers,
    });
    await h.t.decisions!.resolve(
      r.decisionId!,
      { optionId: 'reject', comment: 'Needs a data backup first' },
      h.approver.user,
    );
    await h.settle();
    const detail = await h.t.json<ChangeRequestDTO>('GET', `/api/changes/${rejected}`, {
      headers: h.builder.headers,
    });
    expect(detail).toMatchObject({
      status: 'rejected',
      rejection: { approverId: h.approver.user.id, comment: 'Needs a data backup first' },
    });
    expect(
      (
        await h.t.request('POST', `/api/changes/${rejected}/start`, {
          headers: h.builder.headers,
          body: { sessionId: 'ses_build' },
        })
      ).status,
    ).toBe(409);

    const list = await h.t.json<{ items: ChangeRequestDTO[] }>(
      'GET',
      '/api/changes?projectId=prj_app&status=completed',
      { headers: h.approver.headers },
    );
    expect(list.items.map((c) => c.changeId)).toEqual([changeId]);
    expect(h.t.rt.store.verifyChain().ok).toBe(true);
  });

  it('only the owner (or an approver) acts on a change record; requesters see nothing', async () => {
    await setup();
    const other = h.t.user('builder', 'Other Builder');
    const requester = h.t.user('requester');
    const changeId = await draftAndAffirm(h, {
      projectId: 'prj_app',
      scope: 'main',
      owner: h.builder,
      rollbackRef: repo.head(),
    });
    expect(
      (await h.t.request('POST', `/api/changes/${changeId}/submit`, { headers: other.headers })).status,
    ).toBe(403);
    expect(
      (await h.t.request('GET', `/api/changes/${changeId}`, { headers: requester.headers })).status,
    ).toBe(403);
    expect(
      (
        await h.t.request('POST', '/api/changes', {
          headers: requester.headers,
          body: { projectId: 'prj_app', scope: 'main', title: 'nope' },
        })
      ).status,
    ).toBe(403);
  });

  it('tracks per-developer affirm-without-edit rate and blind confirms for approvers (not a ranking)', async () => {
    await setup();
    h.t.llm.on('change.draft', { ...DRAFT, rollbackRef: 'v1.0.0' });
    const blind = h.t.user('builder', 'Zed Quickclick');
    // Bea edits every field; Zed one-click confirms every field without reading.
    await draftAndAffirm(h, { projectId: 'prj_app', scope: 'main', owner: h.builder, rollbackRef: 'v1.0.0' });
    const { changeId } = await h.t.json<{ changeId: string }>('POST', '/api/changes', {
      headers: blind.headers,
      body: { projectId: 'prj_app', scope: 'main', title: 'Quick one' },
      expect: 201,
    });
    for (const field of ['impact', 'mitigation', 'rollbackPlan', 'acceptanceTest']) {
      const r = await h.t.json<ChangeRequestDTO>('POST', `/api/changes/${changeId}/fields/${field}`, {
        headers: blind.headers,
        body: { value: DRAFT[field as keyof typeof DRAFT], dwellMs: 450 },
      });
      expect(r.fields.find((f) => f.field === field)).toMatchObject({
        affirmed: true,
        edited: false,
        editRatio: 0,
        blind: true,
      });
    }
    // The affirmation is chained with its flag; one more careful read does not count as blind.
    await h.t.json('POST', `/api/changes/${changeId}/fields/impact`, {
      headers: blind.headers,
      body: { value: DRAFT.impact, dwellMs: 12_000 },
    });
    expect(h.t.rt.store.list({ types: ['change.field_affirmed'] }).at(-1)!.meta).toMatchObject({
      edited: false,
      blind: false,
      dwellMs: 12_000,
    });

    expect(
      (await h.t.request('GET', '/api/governance/affirm-rate', { headers: h.builder.headers })).status,
    ).toBe(403);
    const rate = await h.t.json<{
      rows: {
        name: string;
        affirmations: number;
        affirmedWithoutEdit: number;
        affirmWithoutEditRate: number;
        flagged: number;
      }[];
      totals: { affirmations: number; flagged: number };
    }>('GET', '/api/governance/affirm-rate', { headers: h.approver.headers });
    expect(rate.rows.map((r) => r.name)).toEqual(['Bea Builder', 'Zed Quickclick']);
    expect(rate.rows[0]).toMatchObject({
      affirmations: 4,
      affirmedWithoutEdit: 0,
      affirmWithoutEditRate: 0,
      flagged: 0,
    });
    expect(rate.rows[1]).toMatchObject({
      affirmations: 5,
      affirmedWithoutEdit: 5,
      affirmWithoutEditRate: 1,
      flagged: 4,
    });
    expect(rate.totals).toMatchObject({ affirmations: 9, flagged: 4 });
  });

  it('rebuilds deterministically and degrades to "[erased]" when the project bodies are crypto-shredded', async () => {
    await setup();
    h.t.llm.on('change.draft', DRAFT);
    const changeId = await draftAndAffirm(h, {
      projectId: 'prj_app',
      scope: 'reversible_off_main',
      owner: h.builder,
      rollbackRef: 'v1.0.0',
    });
    await approveChange(h, changeId, h.builder);
    const read = () =>
      h.t.json<ChangeRequestDTO>('GET', `/api/changes/${changeId}`, { headers: h.approver.headers });
    const before = await read();
    h.t.rt.store.rebuildProjections(['change']);
    expect(await read()).toEqual(before);

    h.t.rt.store.eraseScope('prj_app', {
      actor: { kind: 'human', id: h.approver.user.id },
      reason: 'pdpa_request',
    });
    const erased = await read();
    expect(erased).toMatchObject({
      erased: true,
      title: null,
      rollbackRef: null,
      status: 'approved',
      affirmedCount: 4,
      rollbackSha: before.rollbackSha,
    });
    expect(erased.fields.every((f) => f.value === null && f.draft === null && f.affirmed)).toBe(true);
    h.t.rt.store.rebuildProjections(['change']);
    expect(await read()).toEqual(erased);
    expect(h.t.rt.store.verifyChain().ok).toBe(true);
  });

  it('exposes createDraft through the change service', async () => {
    await setup();
    const svc = h.t.rt.services.get('change') as ChangeService;
    const { changeId } = await svc.createDraft(
      { projectId: 'prj_app', scope: 'reversible_off_main', title: 'From a service' },
      { kind: 'human', id: h.builder.user.id },
    );
    const c = await h.t.json<ChangeRequestDTO>('GET', `/api/changes/${changeId}`, {
      headers: h.builder.headers,
    });
    expect(c).toMatchObject({ status: 'draft', draftedBy: 'human', ownerId: h.builder.user.id });
    // Drafted by an agent session: accountability goes to the person who owns that session.
    h.t.sessions!.add({ sessionId: 'ses_agent', projectId: 'prj_app', ownerId: h.builder.user.id });
    const fromAgent = await svc.createDraft(
      { projectId: 'prj_app', scope: 'main', title: 'Agent proposal', sessionId: 'ses_agent' },
      { kind: 'agent', id: 'ses_agent' },
    );
    expect(
      await h.t.json<ChangeRequestDTO>('GET', `/api/changes/${fromAgent.changeId}`, {
        headers: h.builder.headers,
      }),
    ).toMatchObject({
      ownerId: h.builder.user.id,
      createdBy: 'ses_agent',
      sessionId: 'ses_agent',
    });
    await approveChange(
      h,
      await draftAndAffirm(h, {
        projectId: 'prj_app',
        scope: 'reversible_off_main',
        owner: h.builder,
        rollbackRef: repo.head(),
      }),
      h.builder,
    );
    expect(h.t.rt.store.list({ types: ['change.approved'] })).toHaveLength(1);
  });
});
