import { afterEach, describe, expect, it } from 'vitest';
import type { ChangeService, PromotionDTO, ProvenanceDTO } from '@aoc/contracts';
import {
  PASSKEY,
  addGuardedRemote,
  approveChange,
  draftAndAffirm,
  harness,
  makeRepo,
  remoteHead,
  setPromotionRemote,
  type Harness,
  type TestRepo,
} from './helpers';

const PROJECT = 'prj_web';
const SYSTEM = { kind: 'system' as const, id: 'intake' };

describe('provenance guarantee and promotion (§14)', () => {
  let h: Harness;
  let repo: TestRepo;
  let base: string;
  let changeId: string;
  afterEach(async () => h?.close());

  /** main at `base`; one approved change record linked to session ses_change. */
  async function setup() {
    h = await harness();
    repo = makeRepo({ 'app.ts': 'export const v = 1;\n' });
    base = repo.head();
    h.addProject(PROJECT, repo.dir);
    h.t.sessions!.add({ sessionId: 'ses_change', projectId: PROJECT });
    changeId = await draftAndAffirm(h, {
      projectId: PROJECT,
      scope: 'reversible_off_main',
      owner: h.builder,
      rollbackRef: base,
    });
    await approveChange(h, changeId, h.builder);
    await h.t.json('POST', `/api/changes/${changeId}/start`, {
      headers: h.builder.headers,
      body: { sessionId: 'ses_change' },
    });
  }

  /** A ticket whose fix plan was approved (decision kind fix_plan on the ticket) and a build session launched for it. */
  async function approvedTicket(
    ticketId: string,
    sessionId: string,
    verdict: 'approve' | 'reject' = 'approve',
  ) {
    h.t.rt.store.append({
      type: 'session.launch_requested',
      actor: { kind: 'system', id: 'supervisor' },
      scope: { sessionId, projectId: PROJECT },
      meta: {
        sessionId,
        projectId: PROJECT,
        threadId: 'thr_t',
        processType: 'bug-fix',
        model: 'opus',
        readOnly: false,
        credentialProfile: 'uat-deploy',
        ticketId,
        parentSessionId: null,
        phaseId: null,
      },
      payload: { prompt: 'implement the fix plan', cwd: repo.dir },
      source: 'supervisor',
    });
    const card = h.t.decisions!.request(
      {
        kind: 'fix_plan',
        title: 'Fix plan',
        question: 'Approve the fix plan?',
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
        subjectType: 'ticket',
        subjectId: ticketId,
        requesterId: 'intake',
      },
      SYSTEM,
    );
    await h.t.decisions!.resolve(card.id, { optionId: verdict }, h.approver.user);
    await h.settle();
  }

  function uat(ticketId: string, verdict: 'pass' | 'fail') {
    h.t.rt.store.append({
      type: 'ticket.uat_result',
      actor: { kind: 'human', id: 'usr_requester' },
      scope: { ticketId },
      meta: { ticketId, requesterId: 'usr_requester', verdict },
      payload: {},
      source: 'intake',
    });
  }

  function branch(name: string, commits: [string, Record<string, string>][]): string[] {
    repo.git('checkout', '-q', '-b', name);
    const shas = commits.map(([message, files]) => repo.commit(message, files));
    repo.git('checkout', '-q', 'main');
    return shas;
  }

  /** What mod-ledger appends when a session closes a task: the HEAD it read from the session's repo. */
  let closes = 0;
  function recordHead(sessionId: string, sha: string) {
    const taskId = `tsk_${++closes}`;
    h.t.rt.store.append({
      type: 'task.done',
      actor: { kind: 'agent', id: sessionId },
      scope: { sessionId, projectId: PROJECT, taskId },
      meta: {
        sessionId,
        projectId: PROJECT,
        taskId,
        phaseId: 'ph_1',
        weight: 1,
        evidenceKind: 'commit',
        evidenceVerified: true,
        flag: null,
        fileChangesSinceLast: 1,
        headSha: sha,
      },
      payload: { evidence: { kind: 'commit', ref: sha } },
      source: 'mcp',
    });
  }

  /** What the supervisor appends when a build session's turn ends: the HEAD it read from the project repository (G-25). */
  let turns = 0;
  function turnEnd(sessionId: string, sha: string) {
    h.t.rt.store.append({
      type: 'session.head_recorded',
      actor: { kind: 'system', id: 'supervisor' },
      scope: { sessionId, projectId: PROJECT },
      meta: { sessionId, projectId: PROJECT, sha, turn: ++turns },
      source: 'supervisor',
    });
  }

  /** A second approved change record, worked by session ses_other. */
  async function otherChange(): Promise<string> {
    h.t.sessions!.add({ sessionId: 'ses_other', projectId: PROJECT });
    const id = await draftAndAffirm(h, {
      projectId: PROJECT,
      scope: 'reversible_off_main',
      owner: h.builder,
      rollbackRef: base,
      title: 'Unrelated work',
    });
    await approveChange(h, id, h.builder);
    await h.t.json('POST', `/api/changes/${id}/start`, {
      headers: h.builder.headers,
      body: { sessionId: 'ses_other' },
    });
    return id;
  }

  it('traces every commit in <main>..<sha> through a gate and names the orphans', async () => {
    await setup();
    await approvedTicket('tkt_ok', 'ses_ticket');
    await approvedTicket('tkt_no', 'ses_rejected_plan', 'reject');
    h.t.rt.store.append({
      type: 'session.rollover_completed',
      actor: { kind: 'system', id: 'supervisor' },
      scope: { sessionId: 'ses_successor' },
      meta: { threadId: 'thr_1', fromSessionId: 'ses_change', toSessionId: 'ses_successor' },
      source: 'supervisor',
    });
    const [viaSession, viaChange, orphan, unlinked, viaTicket, viaRollover, rejectedPlan] = branch(
      'feature/mixed',
      [
        ['feat: a\n\nAOC-Session: ses_change', { 'a.ts': '1' }],
        [`feat: b\n\nAOC-Session: ses_change\nAOC-Change: ${changeId}`, { 'b.ts': '1' }],
        ['chore: sneaky manual edit', { 'c.ts': '1' }],
        ['feat: d\n\nAOC-Session: ses_unknown', { 'd.ts': '1' }],
        ['fix: ticket\n\nAOC-Session: ses_ticket', { 'e.ts': '1' }],
        ['feat: f\n\nAOC-Session: ses_successor', { 'f.ts': '1' }],
        ['fix: g\n\nAOC-Session: ses_rejected_plan', { 'g.ts': '1' }],
      ],
    );
    for (const s of ['ses_change', 'ses_unknown', 'ses_ticket', 'ses_successor', 'ses_rejected_plan'])
      recordHead(s, rejectedPlan!);
    const p = await h.t.json<ProvenanceDTO>('GET', `/api/provenance?projectId=${PROJECT}&sha=feature/mixed`, {
      headers: h.builder.headers,
    });
    expect(p).toMatchObject({ ok: false, baseRef: 'refs/heads/main', sha: rejectedPlan });
    const via = Object.fromEntries(p.commits.map((c) => [c.sha, c.via]));
    expect(via).toEqual({
      [viaSession!]: 'session_change',
      [viaChange!]: 'change',
      [orphan!]: null,
      [unlinked!]: null,
      [viaTicket!]: 'session_ticket',
      [viaRollover!]: 'session_change',
      [rejectedPlan!]: null,
    });
    expect(p.orphanShas).toEqual([rejectedPlan, unlinked, orphan]);
    expect(p.reasons.find((r) => r.startsWith(orphan!.slice(0, 12)))).toContain(
      'no AOC-Session / AOC-Change trailer',
    );

    const svc = h.t.rt.services.get('change') as ChangeService;
    expect(svc.provenance(PROJECT, rejectedPlan!)).toEqual({
      ok: false,
      orphanShas: p.orphanShas,
      reasons: p.reasons,
    });
    expect(svc.provenance(PROJECT, viaRollover!)).toMatchObject({
      ok: false,
      orphanShas: [unlinked, orphan],
    });
    expect(svc.provenance(PROJECT, viaChange!)).toEqual({ ok: true, orphanShas: [], reasons: [] });
    expect(svc.provenance(PROJECT, 'no-such-ref')).toMatchObject({
      ok: false,
      reasons: [expect.stringContaining('does not resolve')],
    });
  });

  it('a valid trailer for an unrelated approved change is an orphan: trailers are corroborated, never trusted (G-25)', async () => {
    await setup();
    await otherChange();
    const [selfAsserted, borrowed, unrecorded] = branch('feature/forged', [
      [`feat: claims the change\n\nAOC-Change: ${changeId}`, { 'a.ts': '1' }],
      [`feat: borrows the change\n\nAOC-Session: ses_other\nAOC-Change: ${changeId}`, { 'b.ts': '1' }],
      ['feat: names the right session\n\nAOC-Session: ses_change', { 'c.ts': '1' }],
    ]);
    // ses_other really worked on this branch (its HEAD contains every commit); ses_change never recorded one.
    recordHead('ses_other', unrecorded!);
    const svc = h.t.rt.services.get('change') as ChangeService;
    const first = svc.provenance(PROJECT, 'feature/forged');
    expect(first.orphanShas).toEqual([unrecorded, borrowed, selfAsserted]);
    const reason = (sha: string) => first.reasons.find((r) => r.startsWith(sha.slice(0, 12)));
    expect(reason(selfAsserted!)).toContain('an AOC-Change trailer alone is self-asserted');
    expect(reason(borrowed!)).toContain(`session ses_other is not linked to approved change ${changeId}`);
    expect(reason(unrecorded!)).toContain('session ses_change never recorded a HEAD containing this commit');

    const refused = await h.t.request('POST', '/api/promotions', {
      headers: h.builder.headers,
      body: { projectId: PROJECT, fromRef: 'feature/forged', changeId },
    });
    expect(refused.status).toBe(422);
    expect(h.t.rt.store.list({ types: ['promotion.refused'] })[0]!.meta).toMatchObject({
      reason: 'provenance_gap',
      orphanShas: [unrecorded, borrowed, selfAsserted],
    });
    expect(h.t.decisions!.list({ kind: ['go_live'] })).toHaveLength(0);

    // Once the ledger records a ses_change HEAD containing it, the honest commit traces; the forged ones never do.
    recordHead('ses_change', unrecorded!);
    expect(svc.provenance(PROJECT, 'feature/forged')).toMatchObject({
      ok: false,
      orphanShas: [borrowed, selfAsserted],
    });
    expect(repo.head('main')).toBe(base);
  });

  it('a HEAD recorded in a clone the project repo never saw proves nothing', async () => {
    await setup();
    const [tip] = branch('feature/elsewhere', [['feat: x\n\nAOC-Session: ses_change', { 'x.ts': '1' }]]);
    recordHead('ses_change', 'f'.repeat(40));
    const svc = h.t.rt.services.get('change') as ChangeService;
    expect(svc.provenance(PROJECT, tip!)).toMatchObject({ ok: false, orphanShas: [tip] });
    recordHead('ses_change', tip!);
    expect(svc.provenance(PROJECT, tip!)).toEqual({ ok: true, orphanShas: [], reasons: [] });
  });

  it('traces a commit made after the last task close through the HEAD recorded at the turn end; a foreign commit stays an orphan (G-25)', async () => {
    await setup();
    // ses_change closed a task at `closed`, then kept working: `tail` came after its last task_done.
    const [closed, tail] = branch('feature/tail', [
      ['feat: first task\n\nAOC-Session: ses_change', { 'a.ts': '1' }],
      ['feat: after the last task_done\n\nAOC-Session: ses_change', { 'b.ts': '1' }],
    ]);
    recordHead('ses_change', closed!);
    const svc = h.t.rt.services.get('change') as ChangeService;
    const reasons = svc.provenance(PROJECT, tail!).reasons.join('\n');
    expect(svc.provenance(PROJECT, tail!)).toMatchObject({ ok: false, orphanShas: [tail] });
    expect(reasons).toContain('session ses_change never recorded a HEAD containing this commit');

    turnEnd('ses_change', tail!);
    expect(svc.provenance(PROJECT, tail!)).toEqual({ ok: true, orphanShas: [], reasons: [] });

    // A commit that only carries the trailer was in no HEAD the platform read from the session, whoever else's turn
    // ended on it, and a HEAD this repository never saw proves nothing.
    const [foreign] = branch('feature/foreign', [['feat: laptop work\n\nAOC-Session: ses_change', { 'c.ts': '1' }]]);
    turnEnd('ses_other', foreign!);
    turnEnd('ses_change', 'f'.repeat(40));
    expect(svc.provenance(PROJECT, foreign!)).toMatchObject({ ok: false, orphanShas: [foreign] });
    expect(svc.provenance(PROJECT, tail!)).toEqual({ ok: true, orphanShas: [], reasons: [] });

    // The heads are a projection of the log: a rebuild reproduces them.
    h.t.rt.store.rebuildProjections(['change']);
    expect(svc.provenance(PROJECT, tail!)).toEqual({ ok: true, orphanShas: [], reasons: [] });
    expect(svc.provenance(PROJECT, foreign!)).toMatchObject({ ok: false, orphanShas: [foreign] });
  });

  it('refuses to promote orphan commits; no gate is raised and main is untouched', async () => {
    await setup();
    const [traced, orphan] = branch('feature/x', [
      [`feat: ok\n\nAOC-Session: ses_change\nAOC-Change: ${changeId}`, { 'a.ts': '1' }],
      ['hotfix without a change record', { 'b.ts': '1' }],
    ]);
    recordHead('ses_change', traced!);
    const res = await h.t.request('POST', '/api/promotions', {
      headers: h.builder.headers,
      body: { projectId: PROJECT, fromRef: 'feature/x' },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; details: { promotion: PromotionDTO; reasons: string[] } };
    };
    expect(body.error.code).toBe('promotion_refused');
    expect(body.error.details.promotion).toMatchObject({
      status: 'refused',
      fromSha: orphan,
      refusal: { reason: 'provenance_gap', orphanShas: [orphan] },
    });
    expect(h.t.rt.store.list({ types: ['promotion.refused'] })[0]!.meta).toMatchObject({
      reason: 'provenance_gap',
      orphanShas: [orphan],
      projectId: PROJECT,
      fromSha: orphan,
    });
    expect(h.t.decisions!.list({ kind: ['go_live'] })).toHaveLength(0);
    expect(repo.head('main')).toBe(base);
  });

  it('promotes a fully traced SHA after the passkey go-live gate: fast-forward only, via the prod-promote profile', async () => {
    await setup();
    const remote = addGuardedRemote(repo);
    const clone = setPromotionRemote(h, PROJECT, remote);
    const [, tip] = branch('feature/y', [
      ['feat: one\n\nAOC-Session: ses_change', { 'a.ts': '1' }],
      [`feat: two\n\nAOC-Session: ses_change\nAOC-Change: ${changeId}`, { 'b.ts': '2' }],
    ]);
    recordHead('ses_change', tip!);
    const requested = await h.t.json<PromotionDTO>('POST', '/api/promotions', {
      headers: h.builder.headers,
      body: { projectId: PROJECT, fromRef: 'feature/y', changeId },
      expect: 202,
    });
    expect(requested).toMatchObject({
      status: 'requested',
      fromSha: tip,
      targetBranch: 'main',
      changeId,
      breakglass: false,
    });
    const card = h.t.decisions!.get(requested.decisionId!)!;
    expect(card).toMatchObject({
      kind: 'go_live',
      requiredRole: 'approver',
      requiresPasskey: true,
      subjectType: 'promotion',
      subjectId: requested.promotionId,
    });
    // The card's free text is kept with the change record the promotion is for (erasable with it).
    expect(h.requested.get(card.id)).toMatchObject({ bodyScope: changeId });
    expect(card.context).toContain('feat: two');
    await expect(h.t.decisions!.resolve(card.id, { optionId: 'approve' }, h.approver.user)).rejects.toThrow(
      /passkey/,
    );
    await h.t.decisions!.resolve(card.id, { optionId: 'approve', ...PASSKEY }, h.approver.user);
    await h.settle();
    const done = await h.t.json<PromotionDTO>('GET', `/api/promotions/${requested.promotionId}`, {
      headers: h.builder.headers,
    });
    expect(done).toMatchObject({
      status: 'completed',
      completion: { mainShaBefore: base, mainShaAfter: tip, approverId: h.approver.user.id },
    });
    expect(repo.head('main')).toBe(tip);
    expect(remoteHead(remote)).toBe(tip);
    expect(h.t.rt.store.list({ types: ['promotion.completed'] })[0]!.meta).toEqual({
      promotionId: requested.promotionId,
      mainShaBefore: base,
      mainShaAfter: tip,
      breakglass: false,
      decisionId: card.id,
      ticketId: null,
    });
    // One credentialed process: the push from the service clone, leased on the verified base.
    expect(h.sup.calls.filter((c) => c.credentialProfile !== null)).toHaveLength(1);
    expect(h.sup.gitCalls().filter((c) => c.args[0] === 'push')).toEqual([
      {
        profile: 'prod-promote',
        cwd: clone,
        sandboxed: false,
        args: [
          'push',
          '--porcelain',
          '--no-verify',
          `--force-with-lease=refs/heads/main:${base}`,
          '--',
          remote,
          `${tip}:refs/heads/main`,
        ],
      },
    ]);
  });

  it('ticket-driven promotions also require a passing UAT; the change service reports refusals', async () => {
    await setup();
    await approvedTicket('tkt_9', 'ses_fix');
    repo.git('checkout', '-q', '-b', 'fix/tkt-9');
    const tip = repo.commit('fix: tkt 9\n\nAOC-Session: ses_fix', { 'fix.ts': '1' }); // repo stays on the fix branch: main is moved by ref update
    recordHead('ses_fix', tip);
    const svc = h.t.rt.services.get('change') as ChangeService;
    const request = () =>
      svc.requestPromotion({ projectId: PROJECT, fromRef: 'fix/tkt-9', ticketId: 'tkt_9' }, SYSTEM);

    expect(await request()).toMatchObject({
      decisionId: null,
      refused: [expect.stringContaining('no passing UAT')],
    });
    uat('tkt_9', 'fail');
    expect((await request()).refused).not.toBeNull();
    expect(h.t.rt.store.list({ types: ['promotion.refused'] }).map((e) => e.meta.reason)).toEqual([
      'uat_missing',
      'uat_missing',
    ]);
    uat('tkt_9', 'pass');
    const ok = await request();
    expect(ok).toMatchObject({ refused: null, decisionId: expect.any(String) });
    expect(h.requested.get(ok.decisionId!)).toMatchObject({ bodyScope: PROJECT }); // no change record: the project
    await h.t.decisions!.resolve(ok.decisionId!, { optionId: 'approve', ...PASSKEY }, h.approver.user);
    await h.settle();
    expect(repo.head('main')).toBe(tip);
    expect(h.t.rt.store.list({ types: ['promotion.completed'] })[0]!.meta).toMatchObject({
      ticketId: 'tkt_9',
      mainShaAfter: tip,
    });
    expect(h.t.rt.store.list({ types: ['promotion.completed'] })[0]!.scope).toMatchObject({
      ticketId: 'tkt_9',
      projectId: PROJECT,
    });
  });

  it('refuses non-fast-forward promotions at request and at execution, gates change-driven promotions, records rejections', async () => {
    await setup();
    const trailers = `AOC-Session: ses_change\nAOC-Change: ${changeId}`;
    const [stale] = branch('feature/stale', [[`feat: stale\n\n${trailers}`, { 's.ts': '1' }]]);
    const [fresh] = branch('feature/fresh', [[`feat: fresh\n\n${trailers}`, { 'f.ts': '1' }]]);
    const [other] = branch('feature/other', [[`feat: other\n\n${trailers}`, { 'o.ts': '1' }]]);
    for (const sha of [stale!, fresh!, other!]) recordHead('ses_change', sha);
    const promote = (fromRef: string, extra: Record<string, unknown> = {}) =>
      h.t.request('POST', '/api/promotions', {
        headers: h.builder.headers,
        body: { projectId: PROJECT, fromRef, ...extra },
      });

    // A draft change record is not a gate.
    const draftId = (
      await h.t.json<{ changeId: string }>('POST', '/api/changes', {
        headers: h.builder.headers,
        body: { projectId: PROJECT, scope: 'main', title: 'Unapproved' },
        expect: 201,
      })
    ).changeId;
    expect(
      (
        (await (await promote('feature/fresh', { changeId: draftId })).json()) as {
          error: { details: { promotion: PromotionDTO } };
        }
      ).error.details.promotion.refusal?.reason,
    ).toBe('gate_missing');

    const pending = (await (await promote('feature/fresh')).json()) as PromotionDTO;
    const rejected = (await (await promote('feature/other')).json()) as PromotionDTO;
    expect(pending.status).toBe('requested');

    // main moves on (an approved promotion of `stale`); `fresh` is no longer a fast-forward of main.
    const s = (await (await promote('feature/stale')).json()) as PromotionDTO;
    await h.t.decisions!.resolve(s.decisionId!, { optionId: 'approve', ...PASSKEY }, h.approver.user);
    await h.settle();
    expect(repo.head('main')).toBe(stale);
    await h.t.decisions!.resolve(pending.decisionId!, { optionId: 'approve', ...PASSKEY }, h.approver.user);
    await h.t.decisions!.resolve(
      rejected.decisionId!,
      { optionId: 'reject', comment: 'Not this sprint', ...PASSKEY },
      h.approver.user,
    );
    await h.settle();
    const get = (id: string) =>
      h.t.json<PromotionDTO>('GET', `/api/promotions/${id}`, { headers: h.builder.headers });
    expect(await get(pending.promotionId)).toMatchObject({
      status: 'refused',
      refusal: { reason: 'not_fast_forward' },
    });
    expect(await get(rejected.promotionId)).toMatchObject({
      status: 'rejected',
      rejection: { approverId: h.approver.user.id, comment: 'Not this sprint' },
    });
    expect(repo.head('main')).toBe(stale);
    expect([fresh, other]).not.toContain(repo.head('main'));

    // Requested after main moved: refused up front, before any gate is raised.
    const late = await promote('feature/fresh');
    expect(late.status).toBe(422);
    expect(
      ((await late.json()) as { error: { details: { reasons: string[] } } }).error.details.reasons[0],
    ).toContain('rebase');
    expect((await promote('feature/stale')).status).toBe(422); // already on main: nothing to promote

    const list = await h.t.json<{ items: PromotionDTO[] }>('GET', `/api/promotions?projectId=${PROJECT}`, {
      headers: h.approver.headers,
    });
    expect(list.items.map((p) => p.status).sort()).toEqual([
      'completed',
      'refused',
      'refused',
      'refused',
      'refused',
      'rejected',
    ]);
    expect(h.t.rt.store.verifyChain().ok).toBe(true);
  });
});
