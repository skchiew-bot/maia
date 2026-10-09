import { describe, expect, it } from 'vitest';
import type {
  CreditAccount,
  CreditAccountsResponse,
  CreditTopupRequest,
  CreditTopupRequestList,
} from '@aoc/contracts';
import { agent, eventsOf, setup, spend } from './helpers';

const REASON = 'Finish the schema migration for ticket 42';

describe('credit routes', () => {
  it('GET /api/credits/me returns the caller account; requesters and anonymous callers are refused', async () => {
    const { t } = await setup();
    const dev = t.user('builder', 'Dev');
    const requester = t.user('requester');
    t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id });
    spend(t, 'ses_a', 40);
    const me = await t.json<CreditAccount>('GET', '/api/credits/me', { headers: dev.headers });
    expect(me).toEqual({
      userId: dev.user.id,
      userName: 'Dev',
      period: '2026-10',
      allocationUsd: 100,
      allocationSource: 'default',
      usedUsd: 40,
      grantedUsd: 0,
      balanceUsd: 60,
      autoGrantUsed: false,
      autoGrantAvailableUsd: 25,
      capped: false,
      exempt: false,
      pendingTopup: null,
      grants: [],
    });
    expect(
      (await t.json<CreditAccount>('GET', '/api/credits/me?period=2026-09', { headers: dev.headers }))
        .usedUsd,
    ).toBe(0);
    expect((await t.request('GET', '/api/credits/me?period=2026-13', { headers: dev.headers })).status).toBe(
      422,
    );
    expect((await t.request('GET', '/api/credits/me', { headers: requester.headers })).status).toBe(403);
    expect((await t.request('GET', '/api/credits/me')).status).toBe(401);
    await t.close();
  });

  it('GET /api/credits/accounts needs credit.view_all and lists every builder/approver account for the period', async () => {
    const { t } = await setup({ credits: { exemptUserIds: ['usr_ceo'] } });
    const dev = t.user('builder', 'Dev');
    const idle = t.user('builder', 'Idle');
    t.user('requester', 'End user');
    const ceo = t.identity!.createUser({ role: 'approver', name: 'CEO', id: 'usr_ceo' });
    const ceoHeaders = { authorization: `Bearer ${ceo.token}` };
    t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id });
    spend(t, 'ses_a', 30);

    expect((await t.request('GET', '/api/credits/accounts', { headers: dev.headers })).status).toBe(403);
    const res = await t.json<CreditAccountsResponse>('GET', '/api/credits/accounts', { headers: ceoHeaders });
    expect(res.period).toBe('2026-10');
    expect(res.accounts.map((a) => [a.userName, a.balanceUsd, a.exempt])).toEqual([
      ['CEO', 100, true],
      ['Dev', 70, false],
      ['Idle', 100, false],
    ]);
    expect(res.accounts.find((a) => a.userId === idle.user.id)!.usedUsd).toBe(0);
    expect(
      (
        await t.json<CreditAccountsResponse>('GET', '/api/credits/accounts?period=2026-09', {
          headers: ceoHeaders,
        })
      ).period,
    ).toBe('2026-09');
    await t.close();
  });

  it('POST /api/credits/allocations needs credit.allocate, a known user and an open period', async () => {
    const { t } = await setup();
    const dev = t.user('builder');
    const approver = t.user('approver');
    const body = { userId: dev.user.id, period: '2026-10', amountUsd: 400 };
    expect((await t.request('POST', '/api/credits/allocations', { headers: dev.headers, body })).status).toBe(
      403,
    );
    const acct = await t.json<CreditAccount>('POST', '/api/credits/allocations', {
      headers: approver.headers,
      body,
      expect: 201,
    });
    expect(acct).toMatchObject({
      allocationUsd: 400,
      allocationSource: 'allocated',
      autoGrantAvailableUsd: 100,
    });
    expect(eventsOf(t, 'credit.allocated')[0]!.meta).toEqual({
      userId: dev.user.id,
      period: '2026-10',
      amountUsd: 400,
      allocatedBy: approver.user.id,
    });
    await t.json('POST', '/api/credits/allocations', {
      headers: approver.headers,
      body: { ...body, period: '2026-12', amountUsd: 50 },
      expect: 201,
    });
    expect(
      (await t.json<CreditAccount>('GET', '/api/credits/me?period=2026-12', { headers: dev.headers }))
        .allocationUsd,
    ).toBe(50);

    const closed = await t.request('POST', '/api/credits/allocations', {
      headers: approver.headers,
      body: { ...body, period: '2026-09' },
    });
    expect(closed.status).toBe(422);
    expect(await closed.json()).toMatchObject({ error: { code: 'period_closed' } });
    expect(
      (
        await t.request('POST', '/api/credits/allocations', {
          headers: approver.headers,
          body: { ...body, userId: 'usr_nobody' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await t.request('POST', '/api/credits/allocations', {
          headers: approver.headers,
          body: { ...body, amountUsd: -1 },
        })
      ).status,
    ).toBe(422);

    // An approver cannot fund themselves (that would sidestep the top-up separation of duties).
    const self = await t.request('POST', '/api/credits/allocations', {
      headers: approver.headers,
      body: { ...body, userId: approver.user.id },
    });
    expect(self.status).toBe(403);
    expect(await self.json()).toMatchObject({ error: { code: 'separation_of_duties' } });
    const other = t.user('approver');
    await t.json('POST', '/api/credits/allocations', {
      headers: other.headers,
      body: { ...body, userId: approver.user.id },
      expect: 201,
    });
    await t.close();
  });
});

describe('top-up requests', () => {
  it('raise a credit_topup decision for an approver (never the requester), age while waiting, and grant on approval', async () => {
    const { t, credits } = await setup();
    const dev = t.user('builder', 'Dev');
    const approver = t.user('approver', 'CEO');
    t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id, projectId: 'prj_1' });

    const req = await t.json<CreditTopupRequest>('POST', '/api/credits/topup-requests', {
      headers: dev.headers,
      body: { amountUsd: 50, reason: REASON, sessionId: 'ses_a' },
      expect: 201,
    });
    expect(req).toMatchObject({
      userId: dev.user.id,
      period: '2026-10',
      amountUsd: 50,
      reason: REASON,
      sessionId: 'ses_a',
      status: 'pending',
      ageMs: 0,
      resolvedAt: null,
    });
    expect(req.requestId).toMatch(/^tpu_/);

    const [requested] = eventsOf(t, 'credit.topup_requested');
    expect(requested!.meta).toEqual({
      requestId: req.requestId,
      userId: dev.user.id,
      period: '2026-10',
      amountUsd: 50,
      sessionId: 'ses_a',
      taskId: null,
      decisionId: req.decisionId,
    });
    expect(JSON.stringify(requested!.meta)).not.toContain('migration');
    expect(t.rt.store.readPayload(requested!)).toEqual({ reason: REASON });

    const card = t.decisions!.get(req.decisionId)!;
    expect(card).toMatchObject({
      kind: 'credit_topup',
      status: 'open',
      requiredRole: 'approver',
      requesterId: dev.user.id,
      subjectType: 'credit_topup',
      subjectId: req.requestId,
      sessionId: 'ses_a',
      projectId: 'prj_1',
    });
    expect(card.excludedApproverIds).toContain(dev.user.id);
    expect(card.options.map((o) => o.id)).toEqual(['approve', 'deny']);
    expect(t.decisions!.list({ resolvableBy: dev.user }).map((c) => c.id)).not.toContain(card.id);
    expect(t.decisions!.list({ resolvableBy: approver.user }).map((c) => c.id)).toContain(card.id);

    // One pending request per user.
    const dup = await t.request('POST', '/api/credits/topup-requests', {
      headers: dev.headers,
      body: { amountUsd: 10, reason: 'again please' },
    });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({
      error: { code: 'topup_pending', details: { requestId: req.requestId } },
    });

    // Waiting is its own aging state, not a stall.
    t.clock.advance(10 * 60_000);
    const me = await t.json<CreditAccount>('GET', '/api/credits/me', { headers: dev.headers });
    expect(me.pendingTopup).toEqual({
      requestId: req.requestId,
      decisionId: req.decisionId,
      amountUsd: 50,
      createdAt: req.createdAt,
      ageMs: 600_000,
    });
    expect(credits.balance(dev.user.id).pendingTopupRequestId).toBe(req.requestId);

    // Separation of duties: the requester cannot resolve their own top-up.
    await expect(t.decisions!.resolve(req.decisionId, { optionId: 'approve' }, dev.user)).rejects.toThrow(
      /separation_of_duties/,
    );
    await t.drain();
    expect(eventsOf(t, 'credit.topup_granted')).toHaveLength(0);

    await t.decisions!.resolve(req.decisionId, { optionId: 'approve', comment: 'ok' }, approver.user);
    await t.drain();
    const [granted] = eventsOf(t, 'credit.topup_granted');
    expect(granted!.meta).toEqual({
      requestId: req.requestId,
      userId: dev.user.id,
      amountUsd: 50,
      approverId: approver.user.id,
      balanceBefore: 100,
      balanceAfter: 150,
      decisionId: req.decisionId,
      period: '2026-10',
      sessionId: 'ses_a',
      taskId: null,
    });
    expect(granted!.causationId).toBe(eventsOf(t, 'decision.resolved')[0]!.id);
    expect(credits.balance(dev.user.id)).toMatchObject({
      grantedUsd: 50,
      balanceUsd: 150,
      pendingTopupRequestId: null,
      autoGrantUsed: false,
    });

    const list = await t.json<CreditTopupRequestList>('GET', '/api/credits/topup-requests', {
      headers: dev.headers,
    });
    expect(list.requests[0]).toMatchObject({
      status: 'granted',
      resolvedBy: approver.user.id,
      balanceBefore: 100,
      balanceAfter: 150,
      ageMs: 600_000,
    });
    // A new request is possible once nothing is pending.
    await t.json('POST', '/api/credits/topup-requests', {
      headers: dev.headers,
      body: { amountUsd: 10, reason: 'small extra' },
      expect: 201,
    });
    await t.close();
  });

  it('separation of duties: an approver cannot approve their own request; another approver can', async () => {
    const { t, credits } = await setup();
    const lead = t.user('approver', 'Lead');
    const ceo = t.user('approver', 'CEO');
    const req = await t.json<CreditTopupRequest>('POST', '/api/credits/topup-requests', {
      headers: lead.headers,
      body: { amountUsd: 30, reason: REASON },
      expect: 201,
    });
    expect(t.decisions!.list({ resolvableBy: lead.user }).map((c) => c.id)).not.toContain(req.decisionId);
    await expect(t.decisions!.resolve(req.decisionId, { optionId: 'approve' }, lead.user)).rejects.toThrow(
      /separation_of_duties/,
    );
    await t.decisions!.resolve(req.decisionId, { optionId: 'approve' }, ceo.user);
    await t.drain();
    expect(eventsOf(t, 'credit.topup_granted')[0]!.meta).toMatchObject({
      userId: lead.user.id,
      approverId: ceo.user.id,
    });
    expect(credits.balance(lead.user.id).grantedUsd).toBe(30);
    await t.close();
  });

  it('denial is recorded, grants nothing and frees the user to ask again', async () => {
    const { t, credits } = await setup();
    const dev = t.user('builder');
    const approver = t.user('approver');
    const req = await t.json<CreditTopupRequest>('POST', '/api/credits/topup-requests', {
      headers: dev.headers,
      body: { amountUsd: 500, reason: REASON },
      expect: 201,
    });
    await t.decisions!.resolve(req.decisionId, { optionId: 'deny' }, approver.user);
    await t.drain();
    expect(eventsOf(t, 'credit.topup_denied')[0]!.meta).toEqual({
      requestId: req.requestId,
      userId: dev.user.id,
      approverId: approver.user.id,
      decisionId: req.decisionId,
    });
    expect(eventsOf(t, 'credit.topup_granted')).toHaveLength(0);
    expect(credits.balance(dev.user.id)).toMatchObject({
      grantedUsd: 0,
      balanceUsd: 100,
      pendingTopupRequestId: null,
    });
    const list = await t.json<CreditTopupRequestList>('GET', '/api/credits/topup-requests?status=denied', {
      headers: dev.headers,
    });
    expect(list.requests.map((r) => [r.requestId, r.status, r.resolvedBy])).toEqual([
      [req.requestId, 'denied', approver.user.id],
    ]);
    await t.json('POST', '/api/credits/topup-requests', {
      headers: dev.headers,
      body: { amountUsd: 100, reason: REASON },
      expect: 201,
    });
    await t.close();
  });

  it('a capped session: the request carries the capped task, the grant lifts the next boundary, and a renewed cap is recorded again', async () => {
    const { t, credits } = await setup();
    const dev = t.user('builder');
    const approver = t.user('approver');
    t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id });
    spend(t, 'ses_a', 100);
    expect(credits.checkBoundary('ses_a', 't1', agent('ses_a'))).toEqual({ continue: true }); // auto grant
    spend(t, 'ses_a', 30);
    expect(credits.checkBoundary('ses_a', 't2', agent('ses_a')).continue).toBe(false);
    expect((await t.json<CreditAccount>('GET', '/api/credits/me', { headers: dev.headers })).capped).toBe(
      true,
    );

    const req = await t.json<CreditTopupRequest>('POST', '/api/credits/topup-requests', {
      headers: dev.headers,
      body: { amountUsd: 50, reason: REASON, sessionId: 'ses_a' },
      expect: 201,
    });
    expect(req.taskId).toBe('t2');
    expect(t.decisions!.get(req.decisionId)!.context).toContain('-$5.00');
    await t.decisions!.resolve(req.decisionId, { optionId: 'approve' }, approver.user);
    await t.drain();
    expect(eventsOf(t, 'credit.topup_granted')[0]!.meta).toMatchObject({
      balanceBefore: -5,
      balanceAfter: 45,
      sessionId: 'ses_a',
      taskId: 't2',
    });

    const me = await t.json<CreditAccount>('GET', '/api/credits/me', { headers: dev.headers });
    expect(me).toMatchObject({ grantedUsd: 75, balanceUsd: 45, capped: false, autoGrantUsed: true });
    expect(
      me.grants.map((g) => [g.kind, g.amountUsd, g.approverId, g.balanceBefore, g.balanceAfter]),
    ).toEqual([
      ['auto', 25, null, 0, 25],
      ['topup', 50, approver.user.id, -5, 45],
    ]);

    expect(credits.checkBoundary('ses_a', 't2', agent('ses_a'))).toEqual({ continue: true });
    spend(t, 'ses_a', 50);
    expect(credits.checkBoundary('ses_a', 't2', agent('ses_a')).continue).toBe(false);
    expect(eventsOf(t, 'credit.cap_reached').map((e) => [e.meta.taskId, e.meta.balanceUsd])).toEqual([
      ['t1', 0],
      ['t2', -5],
      ['t2', -5],
    ]);
    await t.close();
  });

  it('a top-up approved after the period rolled over lands in the new period', async () => {
    const { t, credits } = await setup({ now: '2026-10-31T15:00:00.000Z' }); // 31 Oct 23:00 in Kuala Lumpur
    const dev = t.user('builder');
    const approver = t.user('approver');
    const req = await t.json<CreditTopupRequest>('POST', '/api/credits/topup-requests', {
      headers: dev.headers,
      body: { amountUsd: 40, reason: REASON },
      expect: 201,
    });
    expect(req.period).toBe('2026-10');
    t.clock.set('2026-11-01T01:00:00.000Z');
    await t.decisions!.resolve(req.decisionId, { optionId: 'approve' }, approver.user);
    await t.drain();
    expect(eventsOf(t, 'credit.topup_granted')[0]!.meta).toMatchObject({
      period: '2026-11',
      balanceBefore: 100,
      balanceAfter: 140,
    });
    expect(credits.balance(dev.user.id)).toMatchObject({ period: '2026-11', grantedUsd: 40 });
    expect(credits.balance(dev.user.id, '2026-10').grantedUsd).toBe(0);
    await t.close();
  });

  it('builders list their own requests, approvers list all; status filters', async () => {
    const { t } = await setup();
    const a = t.user('builder', 'A');
    const b = t.user('builder', 'B');
    const approver = t.user('approver');
    const ra = await t.json<CreditTopupRequest>('POST', '/api/credits/topup-requests', {
      headers: a.headers,
      body: { amountUsd: 10, reason: REASON },
      expect: 201,
    });
    t.clock.advance(1000);
    const rb = await t.json<CreditTopupRequest>('POST', '/api/credits/topup-requests', {
      headers: b.headers,
      body: { amountUsd: 20, reason: REASON },
      expect: 201,
    });
    await t.decisions!.resolve(ra.decisionId, { optionId: 'approve' }, approver.user);
    await t.drain();

    const ids = async (headers: Record<string, string>, q = '') =>
      (
        await t.json<CreditTopupRequestList>('GET', `/api/credits/topup-requests${q}`, { headers })
      ).requests.map((r) => r.requestId);
    expect(await ids(a.headers)).toEqual([ra.requestId]);
    expect(await ids(b.headers)).toEqual([rb.requestId]);
    expect(await ids(approver.headers)).toEqual([rb.requestId, ra.requestId]);
    expect(await ids(approver.headers, '?status=pending')).toEqual([rb.requestId]);
    expect(await ids(approver.headers, '?status=granted')).toEqual([ra.requestId]);
    expect(
      (await t.request('GET', '/api/credits/topup-requests?status=bogus', { headers: approver.headers }))
        .status,
    ).toBe(422);
    expect(
      (await t.request('GET', '/api/credits/topup-requests', { headers: t.user('requester').headers }))
        .status,
    ).toBe(403);
    await t.close();
  });

  it('validates the body and the session; exempt users have nothing to top up', async () => {
    const { t } = await setup({ credits: { exemptUserIds: ['usr_ceo'] } });
    const dev = t.user('builder');
    const other = t.user('builder');
    t.sessions!.add({ sessionId: 'ses_other', ownerId: other.user.id });
    const post = (headers: Record<string, string>, body: unknown) =>
      t.request('POST', '/api/credits/topup-requests', { headers, body });
    expect((await post(dev.headers, { amountUsd: 0, reason: REASON })).status).toBe(422);
    expect((await post(dev.headers, { amountUsd: 10, reason: ' ' })).status).toBe(422);
    expect((await post(dev.headers, { amountUsd: 10, reason: REASON, sessionId: 'ses_other' })).status).toBe(
      403,
    );
    expect(
      (await post(dev.headers, { amountUsd: 10, reason: REASON, sessionId: 'ses_missing' })).status,
    ).toBe(404);
    expect((await post(t.user('requester').headers, { amountUsd: 10, reason: REASON })).status).toBe(403);
    const ceo = t.identity!.createUser({ role: 'approver', id: 'usr_ceo' });
    const exempt = await post({ authorization: `Bearer ${ceo.token}` }, { amountUsd: 10, reason: REASON });
    expect(exempt.status).toBe(409);
    expect(await exempt.json()).toMatchObject({ error: { code: 'exempt' } });
    expect(eventsOf(t, 'credit.topup_requested')).toHaveLength(0);
    expect(t.decisions!.list()).toHaveLength(0);
    await t.close();
  });

  it('the resolution reactor is idempotent and ignores policy (auto-grant) resolutions', async () => {
    const { t, mod, credits } = await setup();
    const dev = t.user('builder');
    const other = t.user('builder');
    const approver = t.user('approver');
    t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id });
    spend(t, 'ses_a', 100);
    credits.checkBoundary('ses_a', 't1', agent('ses_a')); // policy-resolved decision
    const granted = await t.json<CreditTopupRequest>('POST', '/api/credits/topup-requests', {
      headers: dev.headers,
      body: { amountUsd: 20, reason: REASON },
      expect: 201,
    });
    const denied = await t.json<CreditTopupRequest>('POST', '/api/credits/topup-requests', {
      headers: other.headers,
      body: { amountUsd: 20, reason: REASON },
      expect: 201,
    });
    await t.decisions!.resolve(granted.decisionId, { optionId: 'approve' }, approver.user);
    await t.decisions!.resolve(denied.decisionId, { optionId: 'deny' }, approver.user);
    await t.drain();
    const snapshot = () => t.rt.store.list({ typePrefix: 'credit.' }).map((e) => e.id);
    const before = snapshot();

    const reactor = mod.reactors!.find((r) => r.name === 'credits.topup_resolution')!;
    const resolved = eventsOf(t, 'decision.resolved');
    expect(resolved.map((e) => e.meta.method)).toEqual(['policy', 'button', 'button']);
    for (let i = 0; i < 2; i++)
      for (const e of resolved) await reactor.react(e, t.rt.store.readPayload(e), t.rt.ctx);
    await t.drain();

    expect(snapshot()).toEqual(before);
    expect(eventsOf(t, 'credit.topup_granted')).toHaveLength(1);
    expect(eventsOf(t, 'credit.topup_denied')).toHaveLength(1);
    expect(credits.balance(dev.user.id)).toMatchObject({ grantedUsd: 45, balanceUsd: 45 });
    await t.close();
  });

  it('a withdrawn decision closes the pending request', async () => {
    const { t } = await setup();
    const dev = t.user('builder');
    t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id });
    const req = await t.json<CreditTopupRequest>('POST', '/api/credits/topup-requests', {
      headers: dev.headers,
      body: { amountUsd: 20, reason: REASON, sessionId: 'ses_a' },
      expect: 201,
    });
    t.decisions!.withdraw(req.decisionId, 'session_ended', { kind: 'system', id: 'supervisor' });
    await t.drain();
    expect(eventsOf(t, 'credit.topup_withdrawn')[0]!.meta).toEqual({
      requestId: req.requestId,
      userId: dev.user.id,
      decisionId: req.decisionId,
      reason: 'session_ended',
    });
    const [row] = (
      await t.json<CreditTopupRequestList>('GET', '/api/credits/topup-requests', { headers: dev.headers })
    ).requests;
    expect(row).toMatchObject({ status: 'withdrawn', resolvedBy: null });
    await t.json('POST', '/api/credits/topup-requests', {
      headers: dev.headers,
      body: { amountUsd: 20, reason: REASON },
      expect: 201,
    });
    await t.close();
  });

  it('an erased request reason degrades to null, also after a rebuild', async () => {
    const { t } = await setup();
    const dev = t.user('builder');
    const approver = t.user('approver');
    t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id });
    await t.json('POST', '/api/credits/topup-requests', {
      headers: dev.headers,
      body: { amountUsd: 20, reason: REASON, sessionId: 'ses_a' },
      expect: 201,
    });
    t.rt.store.eraseScope('ses_a', {
      actor: { kind: 'human', id: approver.user.id },
      reason: 'pdpa_request',
    });
    const reasons = async () =>
      (
        await t.json<CreditTopupRequestList>('GET', '/api/credits/topup-requests', {
          headers: approver.headers,
        })
      ).requests.map((r) => r.reason);
    expect(await reasons()).toEqual([null]);
    t.rt.store.rebuildProjections(['credits']);
    expect(await reasons()).toEqual([null]);
    await t.close();
  });
});
