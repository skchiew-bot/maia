import { afterEach, describe, expect, it } from 'vitest';
import type { DecisionCard, DecisionCardView, DecisionListResponse, DecisionSummary } from '@aoc/contracts';
import { decisionInput, harness, human, type Harness } from './helpers';

let h: Harness | undefined;
afterEach(async () => {
  await h?.t.close();
  h = undefined;
});

/**
 * d1 go_live (builderA, Approver, passkey) · d2 triage_reconciliation (builderA, Builder) ·
 * d3 change_request reversible_off_main (builderB, Builder) · d4 fix_plan (builderB, resolved) ·
 * d5 uat_signoff (end user) — one minute apart.
 */
async function seeded() {
  const hx = (h = await harness());
  const { engine, approver, builderA, builderB, requester, t } = hx;
  const step = () => t.clock.advance(60_000);
  const d1 = engine.request(
    decisionInput({ kind: 'go_live', requesterId: builderA.user.id }),
    human(builderA),
  );
  step();
  const d2 = engine.request(
    decisionInput({
      kind: 'triage_reconciliation',
      requesterId: builderA.user.id,
      sessionId: 'ses_2',
      subjectId: 'ses_2',
    }),
    human(builderA),
  );
  step();
  const d3 = engine.request(
    decisionInput({
      kind: 'change_request',
      changeScope: 'reversible_off_main',
      requesterId: builderB.user.id,
      sessionId: null,
      projectId: 'prj_2',
      subjectType: 'change',
      subjectId: 'chg_1',
    }),
    human(builderB),
  );
  step();
  const d4 = engine.request(
    decisionInput({ kind: 'fix_plan', requesterId: builderB.user.id }),
    human(builderB),
  );
  step();
  const d5 = engine.request(
    decisionInput({
      kind: 'uat_signoff',
      requesterId: requester.user.id,
      subjectType: 'ticket',
      subjectId: 'tkt_1',
      sessionId: null,
    }),
    human(builderB),
  );
  step();
  await engine.resolve(d4.id, { optionId: 'approve' }, approver.user);
  step();
  return { ...hx, d1, d2, d3, d4, d5 };
}

const ids = (r: DecisionListResponse) => r.decisions.map((d) => d.id);

describe('access', () => {
  it('needs a signed-in Builder or Approver; requesters never see internal decisions', async () => {
    const { t, requester, d1 } = await seeded();
    for (const [method, path] of [
      ['GET', '/api/decisions'],
      ['GET', '/api/decisions/summary'],
      ['GET', `/api/decisions/${d1.id}`],
      ['POST', `/api/decisions/${d1.id}/resolve`],
      ['POST', `/api/decisions/${d1.id}/withdraw`],
      ['POST', `/api/decisions/${d1.id}/escalate`],
    ] as const) {
      const body = method === 'POST' ? { optionId: 'approve' } : undefined;
      expect((await t.request(method, path, { body })).status).toBe(401);
      expect((await t.request(method, path, { headers: requester.headers, body })).status).toBe(403);
    }
  });
});

describe('GET /api/decisions', () => {
  it('lists open cards oldest first with age and viewer flags', async () => {
    const { t, approver, builderA, builderB, d1, d2, d3, d5 } = await seeded();
    const res = await t.json<DecisionListResponse>('GET', '/api/decisions?status=open', {
      headers: approver.headers,
    });
    expect(ids(res)).toEqual([d1.id, d2.id, d3.id, d5.id]);
    expect(res.generatedAt).toBe(t.clock.iso());
    expect(res.decisions[0]).toMatchObject({
      ageMs: 6 * 60_000,
      overdue: false,
      erased: false,
      closedAt: null,
    });
    expect(res.decisions.map((d) => d.viewer)).toEqual([
      { canResolve: true, reason: null, canWithdraw: true, canEscalate: false },
      { canResolve: true, reason: null, canWithdraw: true, canEscalate: true },
      { canResolve: true, reason: null, canWithdraw: true, canEscalate: true },
      { canResolve: false, reason: 'not_eligible', canWithdraw: true, canEscalate: false },
    ]);

    const asA = await t.json<DecisionListResponse>('GET', '/api/decisions?status=open', {
      headers: builderA.headers,
    });
    expect(asA.decisions.map((d) => [d.viewer.canResolve, d.viewer.reason, d.viewer.canWithdraw])).toEqual([
      [false, 'separation_of_duties', true],
      [false, 'separation_of_duties', true],
      [true, null, false],
      [false, 'not_eligible', false],
    ]);
    const asB = await t.json<DecisionListResponse>('GET', '/api/decisions?status=open', {
      headers: builderB.headers,
    });
    expect(asB.decisions.map((d) => d.viewer.reason)).toEqual([
      'role',
      null,
      'separation_of_duties',
      'not_eligible',
    ]);
  });

  it('filters by status, kind, session, project, subject and mine; empty values are ignored', async () => {
    const { t, approver, builderA, builderB, d1, d2, d3, d4, d5 } = await seeded();
    const list = async (q: string, who = approver) =>
      ids(await t.json<DecisionListResponse>('GET', `/api/decisions${q}`, { headers: who.headers }));
    expect(await list('')).toEqual([d1.id, d2.id, d3.id, d5.id, d4.id]);
    expect(await list('?status=open&kind=&sessionId=&projectId=&mine=')).toEqual([
      d1.id,
      d2.id,
      d3.id,
      d5.id,
    ]);
    expect(await list('?status=resolved')).toEqual([d4.id]);
    expect(await list('?status=open,resolved&kind=go_live,fix_plan')).toEqual([d1.id, d4.id]);
    expect(await list('?sessionId=ses_2')).toEqual([d2.id]);
    expect(await list('?projectId=prj_2')).toEqual([d3.id]);
    expect(await list('?subjectId=tkt_1')).toEqual([d5.id]);
    expect(await list('?status=open&mine=1')).toEqual([d1.id, d2.id, d3.id]);
    expect(await list('?mine=1', builderA)).toEqual([d3.id]);
    expect(await list('?mine=true', builderB)).toEqual([d2.id]);
    expect(await list('?limit=2')).toEqual([d1.id, d2.id]);
    for (const bad of ['?status=pending', '?kind=coffee', '?limit=0', '?mine=yes']) {
      expect((await t.request('GET', `/api/decisions${bad}`, { headers: approver.headers })).status).toBe(
        422,
      );
    }
  });
});

describe('GET /api/decisions/:id and /summary', () => {
  it('serves one card with its viewer flags, or 404', async () => {
    const { t, approver, builderB, d4 } = await seeded();
    const card = await t.json<DecisionCardView>('GET', `/api/decisions/${d4.id}`, {
      headers: builderB.headers,
    });
    expect(card).toMatchObject({ id: d4.id, kind: 'fix_plan', status: 'resolved', ageMs: 2 * 60_000 });
    expect(card.closedAt).toBe(new Date(t.clock.now() - 60_000).toISOString());
    expect(card.resolution).toMatchObject({
      optionId: 'approve',
      resolvedBy: approver.user.id,
      method: 'button',
    });
    expect(card.viewer).toEqual({
      canResolve: false,
      reason: 'not_open',
      canWithdraw: false,
      canEscalate: false,
    });
    expect((await t.request('GET', '/api/decisions/dec_nope', { headers: approver.headers })).status).toBe(
      404,
    );
  });

  it('summarises open work for the tab badge', async () => {
    const { t, approver, builderA, builderB, d1, d2, d3 } = await seeded();
    const forApprover = await t.json<DecisionSummary>('GET', '/api/decisions/summary', {
      headers: approver.headers,
    });
    expect(forApprover).toEqual({
      generatedAt: t.clock.iso(),
      open: 4,
      resolvableByMe: 3,
      oldestOpenAt: d1.createdAt,
      oldestResolvableByMeAt: d1.createdAt,
      byKind: { go_live: 1, triage_reconciliation: 1, change_request: 1, uat_signoff: 1 },
    });
    const forA = await t.json<DecisionSummary>('GET', '/api/decisions/summary', {
      headers: builderA.headers,
    });
    expect(forA).toMatchObject({ open: 4, resolvableByMe: 1, oldestResolvableByMeAt: d3.createdAt });
    const forB = await t.json<DecisionSummary>('GET', '/api/decisions/summary', {
      headers: builderB.headers,
    });
    expect(forB).toMatchObject({ open: 4, resolvableByMe: 1, oldestResolvableByMeAt: d2.createdAt });
  });
});

describe('POST /api/decisions/:id/resolve', () => {
  it('enforces role, separation of duties and passkey; resolves once', async () => {
    const { t, approver, builderA, builderB, d1, d2, d3 } = await seeded();
    const resolve = (id: string, who: typeof approver, body: unknown) =>
      t.request('POST', `/api/decisions/${id}/resolve`, { headers: who.headers, body });
    const errorOf = async (res: Response) => ({
      status: res.status,
      code: ((await res.json()) as { error: { code: string } }).error.code,
    });

    expect(await errorOf(await resolve(d3.id, builderB, { optionId: 'approve' }))).toEqual({
      status: 403,
      code: 'separation_of_duties',
    });
    expect(await errorOf(await resolve(d1.id, builderB, { optionId: 'approve' }))).toEqual({
      status: 403,
      code: 'role',
    });
    expect(await errorOf(await resolve(d1.id, approver, { optionId: 'approve' }))).toEqual({
      status: 403,
      code: 'passkey_required',
    });
    expect(await errorOf(await resolve(d1.id, approver, { optionId: 'later' }))).toEqual({
      status: 422,
      code: 'unknown_option',
    });
    expect((await resolve(d1.id, approver, { comment: 'no option' })).status).toBe(422);
    expect((await resolve('dec_nope', approver, { optionId: 'approve' })).status).toBe(404);

    const signed = await t.json<DecisionCardView>('POST', `/api/decisions/${d1.id}/resolve`, {
      headers: approver.headers,
      body: { optionId: 'approve', passkeyAssertion: { id: 'cred-1' }, comment: 'Go' },
    });
    expect(signed.status).toBe('resolved');
    expect(signed.resolution).toMatchObject({
      resolvedBy: approver.user.id,
      method: 'passkey',
      passkeyVerified: true,
      comment: 'Go',
    });

    const byB = await t.json<DecisionCardView>('POST', `/api/decisions/${d2.id}/resolve`, {
      headers: builderB.headers,
      body: { optionId: 'reject' },
    });
    expect(byB.resolution).toMatchObject({
      optionId: 'reject',
      resolvedBy: builderB.user.id,
      method: 'button',
      selfApproved: false,
    });
    expect(await errorOf(await resolve(d2.id, approver, { optionId: 'approve' }))).toEqual({
      status: 409,
      code: 'already_resolved',
    });
    expect((await resolve(d3.id, builderA, { optionId: 'approve' })).status).toBe(200);
  });
});

describe('POST /api/decisions/:id/withdraw and /escalate', () => {
  it('lets the Approver or the person it was raised for withdraw an open card', async () => {
    const { t, approver, builderA, builderB, d2, d3 } = await seeded();
    expect(
      (await t.request('POST', `/api/decisions/${d2.id}/withdraw`, { headers: builderB.headers })).status,
    ).toBe(403);
    expect(
      (
        await t.request('POST', `/api/decisions/${d2.id}/withdraw`, {
          headers: builderA.headers,
          body: { reason: 'not a label!' },
        })
      ).status,
    ).toBe(422);
    const own = await t.json<DecisionCardView>('POST', `/api/decisions/${d2.id}/withdraw`, {
      headers: builderA.headers,
      body: { reason: 'superseded', note: 'Replaced by a narrower plan' },
    });
    expect(own).toMatchObject({
      status: 'withdrawn',
      withdrawal: { reason: 'superseded', by: builderA.user.id, note: 'Replaced by a narrower plan' },
    });
    const byApprover = await t.json<DecisionCardView>('POST', `/api/decisions/${d3.id}/withdraw`, {
      headers: approver.headers,
    });
    expect(byApprover).toMatchObject({
      status: 'withdrawn',
      withdrawal: { reason: 'manual', by: approver.user.id, note: null },
    });
    expect(
      (await t.request('POST', `/api/decisions/${d3.id}/withdraw`, { headers: approver.headers })).status,
    ).toBe(409);
  });

  it('escalates a Builder-level card to the Approver', async () => {
    const { t, approver, builderA, builderB, d1, d3 } = await seeded();
    const up = await t.json<DecisionCardView>('POST', `/api/decisions/${d3.id}/escalate`, {
      headers: builderA.headers,
      body: { reason: 'touches_billing' },
    });
    expect(up).toMatchObject({
      requiredRole: 'approver',
      escalation: { toRole: 'approver', reason: 'touches_billing' },
    });
    expect(up.viewer).toMatchObject({ canResolve: false, reason: 'role', canEscalate: false });
    const seen = await t.json<DecisionCardView>('GET', `/api/decisions/${d3.id}`, {
      headers: approver.headers,
    });
    expect(seen.viewer.canResolve).toBe(true);
    const asRequester = await t.json<DecisionCardView>('GET', `/api/decisions/${d3.id}`, {
      headers: builderB.headers,
    });
    expect(asRequester.viewer.reason).toBe('separation_of_duties');
    expect(
      (await t.request('POST', `/api/decisions/${d1.id}/escalate`, { headers: approver.headers })).status,
    ).toBe(409);
  });
});

describe('resolution read-back', () => {
  it('matches the service view', async () => {
    const { t, approver, engine, d3 } = await seeded();
    const viaApi = await t.json<DecisionCardView>('GET', `/api/decisions/${d3.id}`, {
      headers: approver.headers,
    });
    const fromService: DecisionCard | null = engine.get(d3.id);
    expect(viaApi).toMatchObject(fromService as object);
  });
});
