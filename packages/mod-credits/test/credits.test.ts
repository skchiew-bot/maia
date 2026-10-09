import { describe, expect, it } from 'vitest';
import type { CreditAccount, CreditTopupRequest, SupervisorService } from '@aoc/contracts';
import { CAP_TEXT_OCT, agent, creditTypes, eventsOf, setup, spend } from './helpers';

const capOct = { continue: false, reason: 'credit_cap', instruction: CAP_TEXT_OCT };

describe('credit accounts', () => {
  it('balance = allocation + grants − notional cost of usage in sessions the user owns, per local period', async () => {
    const { t, credits, metering } = await setup();
    const dev = t.user('builder', 'Dev');
    const other = t.user('builder', 'Other');
    const approver = t.user('approver', 'CEO');
    t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id });
    t.sessions!.add({ sessionId: 'ses_b', ownerId: dev.user.id, model: 'claude-haiku-5-5' });
    t.sessions!.add({ sessionId: 'ses_c', ownerId: other.user.id });
    t.sessions!.add({ sessionId: 'ses_d', ownerId: null, mode: 'observed' });

    spend(t, 'ses_a', 10, { at: '2026-10-05T03:00:00.000Z' });
    spend(t, 'ses_b', 5, { at: '2026-10-08T03:00:00.000Z', model: 'claude-haiku-5-5' });
    spend(t, 'ses_c', 50);
    spend(t, 'ses_d', 7);
    spend(t, 'ses_a', 20, { at: '2026-09-20T03:00:00.000Z' });
    // 30 Sep 17:30 UTC is already 1 Oct 01:30 in Kuala Lumpur: local period and local rate-card day.
    spend(t, 'ses_a', 3, { at: '2026-09-30T17:30:00.000Z' });

    expect(credits.balance(dev.user.id)).toEqual({
      userId: dev.user.id,
      period: '2026-10',
      allocationUsd: 100,
      grantedUsd: 0,
      usedUsd: 18,
      balanceUsd: 82,
      autoGrantUsed: false,
      pendingTopupRequestId: null,
      exempt: false,
    });
    expect(credits.balance(dev.user.id, '2026-09')).toMatchObject({ usedUsd: 20, balanceUsd: 80 });
    expect(credits.balance(other.user.id).usedUsd).toBe(50);
    expect(metering.calls).toContainEqual(
      expect.objectContaining({ model: 'claude-opus-5-5', date: '2026-10-01' }),
    );
    expect(metering.calls).toContainEqual(
      expect.objectContaining({ model: 'claude-haiku-5-5', date: '2026-10-08' }),
    );

    const acct = await t.json<CreditAccount>('POST', '/api/credits/allocations', {
      headers: approver.headers,
      body: { userId: dev.user.id, period: '2026-10', amountUsd: 250 },
      expect: 201,
    });
    expect(acct).toMatchObject({
      allocationUsd: 250,
      allocationSource: 'allocated',
      usedUsd: 18,
      grantedUsd: 0,
      balanceUsd: 232,
      capped: false,
    });

    // A new period starts from the default allocation and only its own usage (nothing carries over).
    t.clock.set('2026-11-02T02:00:00.000Z');
    expect(credits.balance(dev.user.id)).toMatchObject({
      period: '2026-11',
      allocationUsd: 100,
      usedUsd: 0,
      balanceUsd: 100,
    });
    await t.close();
  });

  it('continues while the balance is positive and records nothing', async () => {
    const { t, credits } = await setup();
    const dev = t.user('builder');
    t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id });
    spend(t, 'ses_a', 99.99);
    expect(credits.checkBoundary('ses_a', 't1', agent('ses_a'))).toEqual({ continue: true });
    expect(credits.checkBoundary('ses_a', null, { kind: 'system', id: 'supervisor' })).toEqual({
      continue: true,
    });
    expect(creditTypes(t)).toEqual([]);
    await t.close();
  });
});

describe('checkBoundary', () => {
  it('first cap in a period auto-grants 25% of the original allocation once, recorded as a policy-resolved credit_topup decision', async () => {
    const { t, credits } = await setup();
    const dev = t.user('builder');
    const approver = t.user('approver');
    t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id, projectId: 'prj_1' });
    await t.json('POST', '/api/credits/allocations', {
      headers: approver.headers,
      body: { userId: dev.user.id, period: '2026-10', amountUsd: 200 },
      expect: 201,
    });
    spend(t, 'ses_a', 200);

    expect(credits.checkBoundary('ses_a', 't1', agent('ses_a'))).toEqual({ continue: true });
    const trail = t.rt.store
      .list()
      .map((e) => e.type)
      .filter((type) => type.startsWith('credit.') || type.startsWith('decision.'));
    expect(trail).toEqual([
      'credit.allocated',
      'credit.cap_reached',
      'decision.requested',
      'decision.resolved',
      'credit.auto_granted',
    ]);

    const [grant] = eventsOf(t, 'credit.auto_granted');
    expect(grant!.meta).toEqual({
      userId: dev.user.id,
      period: '2026-10',
      amountUsd: 50,
      balanceBefore: 0,
      balanceAfter: 50,
      sessionId: 'ses_a',
      taskId: 't1',
      allocationUsd: 200,
      decisionId: expect.stringMatching(/^dec_/),
    });
    expect(grant!.scope).toMatchObject({
      userId: dev.user.id,
      sessionId: 'ses_a',
      taskId: 't1',
      projectId: 'prj_1',
    });
    const card = t.decisions!.get(grant!.meta.decisionId as string)!;
    expect(card).toMatchObject({
      kind: 'credit_topup',
      status: 'resolved',
      requesterId: dev.user.id,
      sessionId: 'ses_a',
      projectId: 'prj_1',
      subjectType: 'credit_account',
    });
    expect(card.resolution).toMatchObject({
      method: 'policy',
      optionId: 'approve',
      resolvedBy: 'credits:auto-grant',
      selfApproved: false,
    });
    expect(credits.balance(dev.user.id)).toMatchObject({
      grantedUsd: 50,
      balanceUsd: 50,
      autoGrantUsed: true,
    });

    // Spending the grant: the next boundary is capped — there is no AI repeat grant.
    spend(t, 'ses_a', 55);
    expect(credits.checkBoundary('ses_a', 't2', agent('ses_a'))).toEqual(capOct);
    expect(eventsOf(t, 'credit.auto_granted')).toHaveLength(1);
    expect(eventsOf(t, 'credit.cap_reached').map((e) => e.meta)).toEqual([
      { userId: dev.user.id, sessionId: 'ses_a', taskId: 't1', balanceUsd: 0, period: '2026-10' },
      { userId: dev.user.id, sessionId: 'ses_a', taskId: 't2', balanceUsd: -5, period: '2026-10' },
    ]);
    expect(t.decisions!.list({ kind: ['credit_topup'] })).toHaveLength(1);
    expect(t.rt.store.verifyChain().ok).toBe(true);
    await t.close();
  });

  it('uses config.credits.autoGrantPct; with 0% the first cap stops work directly', async () => {
    const ten = await setup({ credits: { autoGrantPct: 10 } });
    const dev = ten.t.user('builder');
    ten.t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id });
    spend(ten.t, 'ses_a', 100);
    expect(ten.credits.checkBoundary('ses_a', 't1', agent('ses_a'))).toEqual({ continue: true });
    expect(eventsOf(ten.t, 'credit.auto_granted')[0]!.meta).toMatchObject({
      amountUsd: 10,
      balanceAfter: 10,
    });
    await ten.t.close();

    const none = await setup({ credits: { autoGrantPct: 0 } });
    const dev2 = none.t.user('builder');
    none.t.sessions!.add({ sessionId: 'ses_a', ownerId: dev2.user.id });
    spend(none.t, 'ses_a', 100);
    expect(none.credits.checkBoundary('ses_a', 't1', agent('ses_a'))).toEqual(capOct);
    expect(creditTypes(none.t)).toEqual(['credit.cap_reached']);
    await none.t.close();
  });

  it('an auto grant that cannot lift the balance above zero is still spent, and the boundary stops work', async () => {
    const { t, credits } = await setup();
    const dev = t.user('builder');
    t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id });
    spend(t, 'ses_a', 150);
    expect(credits.checkBoundary('ses_a', 't1', agent('ses_a'))).toEqual(capOct);
    expect(eventsOf(t, 'credit.auto_granted')[0]!.meta).toMatchObject({
      amountUsd: 25,
      balanceBefore: -50,
      balanceAfter: -25,
    });
    expect(credits.checkBoundary('ses_a', 't2', agent('ses_a'))).toEqual(capOct);
    expect(eventsOf(t, 'credit.auto_granted')).toHaveLength(1);
    await t.close();
  });

  it('records credit.cap_reached once per session/task while the funding is unchanged', async () => {
    const { t, credits } = await setup();
    const dev = t.user('builder');
    t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id });
    t.sessions!.add({ sessionId: 'ses_b', ownerId: dev.user.id });
    spend(t, 'ses_a', 100);
    credits.checkBoundary('ses_a', 't1', agent('ses_a')); // auto grant
    spend(t, 'ses_a', 30);
    for (let i = 0; i < 3; i++) expect(credits.checkBoundary('ses_a', 't2', agent('ses_a'))).toEqual(capOct);
    expect(credits.checkBoundary('ses_b', 't2', agent('ses_b'))).toEqual(capOct);
    expect(credits.checkBoundary('ses_a', null, { kind: 'system', id: 'supervisor' })).toEqual(capOct);
    expect(credits.checkBoundary('ses_a', null, { kind: 'system', id: 'supervisor' })).toEqual(capOct);
    expect(eventsOf(t, 'credit.cap_reached').map((e) => [e.meta.sessionId, e.meta.taskId])).toEqual([
      ['ses_a', 't1'],
      ['ses_a', 't2'],
      ['ses_b', 't2'],
      ['ses_a', null],
    ]);
    await t.close();
  });

  it('no compounding: an earlier top-up never raises the auto-grant base', async () => {
    const { t, credits } = await setup();
    const dev = t.user('builder');
    const approver = t.user('approver');
    t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id });
    const req = await t.json<CreditTopupRequest>('POST', '/api/credits/topup-requests', {
      headers: dev.headers,
      body: { amountUsd: 200, reason: 'Large refactor ahead' },
      expect: 201,
    });
    await t.decisions!.resolve(req.decisionId, { optionId: 'approve' }, approver.user);
    await t.drain();
    expect(credits.balance(dev.user.id)).toMatchObject({
      allocationUsd: 100,
      grantedUsd: 200,
      balanceUsd: 300,
    });

    spend(t, 'ses_a', 300);
    expect(credits.checkBoundary('ses_a', 't1', agent('ses_a'))).toEqual({ continue: true });
    // 25% of the original $100 allocation — not of the $300 funded.
    expect(eventsOf(t, 'credit.auto_granted')[0]!.meta).toMatchObject({
      amountUsd: 25,
      allocationUsd: 100,
      balanceBefore: 0,
      balanceAfter: 25,
    });
    await t.close();
  });

  it('a new period resets allocation, usage and the once-per-period auto grant', async () => {
    const { t, credits } = await setup();
    const dev = t.user('builder');
    t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id });
    spend(t, 'ses_a', 100);
    expect(credits.checkBoundary('ses_a', 't1', agent('ses_a'))).toEqual({ continue: true });
    spend(t, 'ses_a', 30);
    expect(credits.checkBoundary('ses_a', 't2', agent('ses_a'))).toEqual(capOct);

    t.clock.set('2026-10-31T16:30:00.000Z'); // 1 Nov 00:30 in Kuala Lumpur
    expect(credits.checkBoundary('ses_a', 't2', agent('ses_a'))).toEqual({ continue: true });
    expect(credits.balance(dev.user.id)).toMatchObject({
      period: '2026-11',
      usedUsd: 0,
      grantedUsd: 0,
      balanceUsd: 100,
      autoGrantUsed: false,
    });

    spend(t, 'ses_a', 100);
    expect(credits.checkBoundary('ses_a', 't3', agent('ses_a'))).toEqual({ continue: true });
    expect(eventsOf(t, 'credit.auto_granted').map((e) => [e.meta.period, e.meta.amountUsd])).toEqual([
      ['2026-10', 25],
      ['2026-11', 25],
    ]);
    spend(t, 'ses_a', 30);
    expect(credits.checkBoundary('ses_a', 't4', agent('ses_a')).continue).toBe(false);
    expect(
      (credits.checkBoundary('ses_a', 't4', agent('ses_a')) as { instruction: string }).instruction,
    ).toMatch(/^Credit cap reached for 2026-11\./);
    expect(credits.balance(dev.user.id, '2026-10')).toMatchObject({ autoGrantUsed: true, balanceUsd: -5 });
    await t.close();
  });

  it('exempt users are never capped', async () => {
    const { t, credits } = await setup({ credits: { exemptUserIds: ['usr_ceo'] } });
    const { user } = t.identity!.createUser({ role: 'approver', name: 'CEO', id: 'usr_ceo' });
    t.sessions!.add({ sessionId: 'ses_x', ownerId: user.id });
    spend(t, 'ses_x', 1000);
    expect(credits.checkBoundary('ses_x', 't1', agent('ses_x'))).toEqual({ continue: true });
    expect(credits.checkBoundary('ses_x', null, { kind: 'system', id: 'supervisor' })).toEqual({
      continue: true,
    });
    expect(creditTypes(t)).toEqual([]);
    expect(credits.balance(user.id)).toMatchObject({ exempt: true, balanceUsd: -900, autoGrantUsed: false });
    await t.close();
  });

  it('sessions without an owning user are never capped', async () => {
    const { t, credits } = await setup();
    t.sessions!.add({ sessionId: 'ses_obs', ownerId: null, mode: 'observed' });
    spend(t, 'ses_obs', 500);
    expect(credits.checkBoundary('ses_obs', 't1', agent('ses_obs'))).toEqual({ continue: true });
    expect(credits.checkBoundary('ses_unknown', 't1', agent('ses_unknown'))).toEqual({ continue: true });
    expect(creditTypes(t)).toEqual([]);
    await t.close();
  });

  it('R7: usage past the cap mid-task appends nothing and stops nothing; only the next task boundary caps', async () => {
    const calls: string[] = [];
    const recorded = (name: string) => async () => void calls.push(name);
    const supervisor: SupervisorService = {
      launch: async () => (calls.push('launch'), { sessionId: 'ses_new' }),
      resume: recorded('resume'),
      nudge: recorded('nudge'),
      restart: recorded('restart'),
      stop: recorded('stop'),
      rollover: async () => (calls.push('rollover'), { refused: [] }),
      isRunning: () => true,
      stopRequested: () => false,
      runIsolated: async () => (calls.push('runIsolated'), { exitCode: 0, stdout: '', stderr: '' }),
    };
    const { t, mod, credits } = await setup({ services: { supervisor } });
    const dev = t.user('builder');
    t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id });
    for (let i = 0; i < 5; i++) spend(t, 'ses_a', 100);
    await t.drain();

    expect(mod.guards ?? []).toEqual([]);
    expect(t.rt.policy.list()).toEqual([]);
    expect(
      t.rt.store
        .list()
        .filter((e) => e.type !== 'user.created')
        .map((e) => e.type),
    ).toEqual(Array(5).fill('usage.recorded'));
    expect(calls).toEqual([]);

    expect(credits.checkBoundary('ses_a', 't1', agent('ses_a'))).toEqual(capOct);
    await t.drain();
    expect(calls).toEqual([]);
    await t.close();
  });

  it('R8: credits meter cost but never pick or change the model', async () => {
    const { t, credits } = await setup();
    const a = t.user('builder');
    const b = t.user('builder');
    t.sessions!.add({
      sessionId: 'ses_disc',
      ownerId: a.user.id,
      processType: 'discovery',
      model: 'claude-opus-5-5',
    });
    t.sessions!.add({
      sessionId: 'ses_docs',
      ownerId: b.user.id,
      processType: 'docs',
      model: 'claude-haiku-5-5',
    });
    const outcomes: Record<string, unknown[]> = { ses_disc: [], ses_docs: [] };
    for (const [usd, task] of [
      [50, 't1'],
      [50, 't2'],
      [30, 't3'],
      [0, 't3'],
    ] as const) {
      spend(t, 'ses_disc', usd, { model: 'claude-opus-5-5' });
      spend(t, 'ses_docs', usd, { model: 'claude-haiku-5-5' });
      outcomes.ses_disc!.push(credits.checkBoundary('ses_disc', task, agent('ses_disc')));
      outcomes.ses_docs!.push(credits.checkBoundary('ses_docs', task, agent('ses_docs')));
    }
    // Same spend, same outcome on Opus and on Haiku: the model is never an input to the decision...
    expect(outcomes.ses_disc).toEqual(outcomes.ses_docs);
    expect(outcomes.ses_disc).toEqual([{ continue: true }, { continue: true }, capOct, capOct]);
    // ...nor an output: a boundary result carries only continue / reason / instruction, never a model or tier.
    for (const r of [...outcomes.ses_disc!, ...outcomes.ses_docs!]) {
      expect(Object.keys(r as object).every((k) => ['continue', 'reason', 'instruction'].includes(k))).toBe(
        true,
      );
      expect(JSON.stringify(r)).not.toMatch(/model|opus|sonnet|haiku|fable|tier/i);
    }
    for (const e of t.rt.store.list({ typePrefix: 'credit.' }))
      expect(JSON.stringify(e.meta)).not.toMatch(/model|opus|sonnet|haiku|fable/i);
    // The discovery session stays on Opus whatever the budget (discovery-on-Opus overrides budget).
    expect(t.sessions!.get('ses_disc')).toMatchObject({ model: 'claude-opus-5-5', processType: 'discovery' });
    expect(t.rt.services.has('registry')).toBe(false);
    await t.close();
  });

  it('the credits projection rebuilds from the log to the same accounts', async () => {
    const { t, credits } = await setup();
    const dev = t.user('builder');
    const approver = t.user('approver');
    t.sessions!.add({ sessionId: 'ses_a', ownerId: dev.user.id });
    await t.json('POST', '/api/credits/allocations', {
      headers: approver.headers,
      body: { userId: dev.user.id, period: '2026-10', amountUsd: 120 },
      expect: 201,
    });
    spend(t, 'ses_a', 120);
    credits.checkBoundary('ses_a', 't1', agent('ses_a'));
    spend(t, 'ses_a', 40);
    credits.checkBoundary('ses_a', 't2', agent('ses_a'));
    const req = await t.json<CreditTopupRequest>('POST', '/api/credits/topup-requests', {
      headers: dev.headers,
      body: { amountUsd: 60, reason: 'Finish the migration', sessionId: 'ses_a' },
      expect: 201,
    });
    await t.decisions!.resolve(req.decisionId, { optionId: 'approve' }, approver.user);
    await t.drain();

    const before = await t.json('GET', '/api/credits/accounts', { headers: approver.headers });
    const requestsBefore = await t.json('GET', '/api/credits/topup-requests', { headers: approver.headers });
    t.rt.store.rebuildProjections(['credits']);
    expect(await t.json('GET', '/api/credits/accounts', { headers: approver.headers })).toEqual(before);
    expect(await t.json('GET', '/api/credits/topup-requests', { headers: approver.headers })).toEqual(
      requestsBefore,
    );
    await t.close();
  });
});
