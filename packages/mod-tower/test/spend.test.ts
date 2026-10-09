import { afterEach, describe, expect, it } from 'vitest';
import {
  ProcessTypeSchema,
  type CreditBalance,
  type CreditService,
  type RegistryService,
} from '@aoc/contracts';
import { ago, DAY, hours, launch, meteringStub, project, setup, sys, usage, type Harness } from './helpers';

let h: Harness;
afterEach(async () => h?.close());

const at = (iso: string) => Date.parse(iso);

const registry = {
  getType: (id: string) =>
    ({
      'bug-fix': ProcessTypeSchema.parse({
        id: 'bug-fix',
        name: 'Bug fix',
        class: 'execution',
        model: 'opus',
        executionModel: 'haiku',
      }),
      'feature-discovery': ProcessTypeSchema.parse({
        id: 'feature-discovery',
        name: 'Discovery',
        class: 'discovery',
        model: 'opus',
      }),
      'bug-triage': ProcessTypeSchema.parse({
        id: 'bug-triage',
        name: 'Triage',
        class: 'triage',
        model: 'sonnet',
        readOnly: true,
      }),
    })[id] ?? null,
} as unknown as RegistryService;

describe('spend', () => {
  it('notional USD today by project and model tier, RM via FX, 7-day average with each day on its own rate card', async () => {
    const m = meteringStub(4.2);
    h = await setup({ services: { metering: m.stub } });
    project(h, 'prj_a', 'Claims Intake Bot');
    project(h, 'prj_b', 'CX Copilot');
    launch(h, 'ses_a', { at: at('2026-10-01T00:00:00.000Z'), model: 'claude-opus-5-5' });
    launch(h, 'ses_b', {
      at: at('2026-10-01T00:00:00.000Z'),
      projectId: 'prj_b',
      model: 'claude-sonnet-5-5',
    });
    launch(h, 'ses_c', { at: at('2026-10-01T00:00:00.000Z'), model: 'claude-haiku-5-5' });
    usage(h, 'ses_a', 10_000, { at: at('2026-10-09T05:00:00.000Z') }); // $10
    usage(h, 'ses_b', 5_000, { at: at('2026-10-09T04:00:00.000Z'), model: 'claude-sonnet-5-5' }); // $1
    usage(h, 'ses_c', 20_000, { at: at('2026-10-08T17:00:00.000Z'), model: 'claude-haiku-5-5' }); // 01:00 local today: $1
    usage(h, 'ses_a', 3_000, { at: at('2026-10-08T15:00:00.000Z') }); // 23:00 local yesterday: $3
    usage(h, 'ses_a', 4_000, { at: at('2026-10-02T05:00:00.000Z') }); // 7 days ago: $4
    usage(h, 'ses_a', 50_000, { at: at('2026-10-01T05:00:00.000Z') }); // 8 days ago: outside the average

    const { spend } = await h.snap();
    expect(spend).toMatchObject({
      notionalUsdToday: 12,
      notionalRmToday: 50.4,
      avg7dUsd: 1,
      byProject: [
        { projectId: 'prj_a', name: 'Claims Intake Bot', usdToday: 11 },
        { projectId: 'prj_b', name: 'CX Copilot', usdToday: 1 },
      ],
      modelMix: [
        { tier: 'opus', usdToday: 10, pct: 83.3 },
        { tier: 'haiku', usdToday: 1, pct: 8.3 },
        { tier: 'sonnet', usdToday: 1, pct: 8.3 },
      ],
      discoveryRuns7d: 0,
      executionRuns7d: 0,
      savingsPct: null,
      capForecast: [],
    });
    expect(m.calls).toContainEqual({ model: 'claude-opus-5-5', date: '2026-10-08' });
    expect(m.calls).toContainEqual({ model: 'claude-opus-5-5', date: '2026-10-02' });
    expect(m.calls.some((c) => c.date === '2026-10-01')).toBe(false);
  });

  it('degrades without metering: no cost, no RM', async () => {
    h = await setup();
    launch(h, 'ses_a');
    usage(h, 'ses_a', 10_000);
    const { spend } = await h.snap();
    expect(spend).toMatchObject({
      notionalUsdToday: 0,
      notionalRmToday: null,
      avg7dUsd: 0,
      savingsPct: null,
      capForecast: [],
    });
  });

  it('discovery vs execution runs in 7d: registry decides (execution = launched off the type’s discovery model); savings per run', async () => {
    const runs = () => {
      const run = (id: string, type: string, model: string, tokens: number, launchedAgo = DAY) => {
        launch(h, id, { at: ago(h, launchedAgo), processType: type, model });
        usage(h, id, tokens, { model, at: ago(h, launchedAgo - hours(1)) });
      };
      run('r1', 'bug-fix', 'claude-opus-5-5', 10_000); // $10
      run('r2', 'bug-fix', 'claude-opus-5-5', 20_000); // $20
      for (const id of ['r3', 'r4', 'r5']) run(id, 'bug-fix', 'claude-haiku-5-5', 20_000); // $1 each
      run('r6', 'feature-discovery', 'claude-opus-5-5', 30_000); // $30
      run('r7', 'bug-triage', 'claude-sonnet-5-5', 5_000); // $1
      run('r8', 'bug-fix', 'claude-opus-5-5', 10_000, 8 * DAY); // launched 8 days ago
    };
    h = await setup({ services: { metering: meteringStub().stub, registry } });
    runs();
    expect((await h.snap()).spend).toMatchObject({ discoveryRuns7d: 3, executionRuns7d: 3, savingsPct: 95 }); // $20 vs $1 per run; triage excluded
    await h.close();

    // Without the registry the type's discovery model is approximated by its strongest tier; triage cannot be told apart.
    h = await setup({ services: { metering: meteringStub().stub } });
    runs();
    expect((await h.snap()).spend).toMatchObject({
      discoveryRuns7d: 4,
      executionRuns7d: 3,
      savingsPct: 93.4,
    }); // $61/4 vs $1
  });

  it('cap forecast: burn/day = period spend ÷ elapsed days; runway order, null when the balance lasts the period', async () => {
    const balances = new Map<string, Partial<CreditBalance>>();
    const credits: CreditService = {
      checkBoundary: () => ({ continue: true }),
      balance: (userId) => ({
        userId,
        period: '2026-10',
        allocationUsd: 100,
        grantedUsd: 0,
        usedUsd: 0,
        balanceUsd: 100,
        autoGrantUsed: false,
        pendingTopupRequestId: null,
        exempt: false,
        ...balances.get(userId),
      }),
    };
    // 00:00 local on 9 Oct: exactly 8 days into the period.
    h = await setup({
      now: '2026-10-08T16:00:00.000Z',
      services: { metering: meteringStub().stub, credits },
    });
    const [a, b, c, d, e] = ['Aisyah', 'Wei Jie', 'Priya', 'Daniel', 'Ella'].map((n) =>
      h.t.user('builder', n),
    );
    balances.set(a!.user.id, { balanceUsd: 30 });
    balances.set(b!.user.id, { balanceUsd: 200 });
    balances.set(c!.user.id, { balanceUsd: 1, exempt: true });
    balances.set(d!.user.id, { balanceUsd: -5 });
    balances.set(e!.user.id, { balanceUsd: 20 });
    const spendAs = (sessionId: string, owner: string | null, usd: number) => {
      launch(h, sessionId, { at: at('2026-10-01T00:00:00.000Z'), owner });
      usage(h, sessionId, usd * 1000, { at: at('2026-10-03T05:00:00.000Z') });
    };
    spendAs('ses_a', a!.user.id, 80); // $10/day → $30 lasts 3 days
    spendAs('ses_b', b!.user.id, 16); // $2/day → $200 lasts past the period
    spendAs('ses_c', c!.user.id, 50); // exempt
    spendAs('ses_d', d!.user.id, 8); // already below zero
    spendAs('ses_x', null, 100); // nobody's account
    usage(h, 'ses_a', 500_000, { at: at('2026-09-25T05:00:00.000Z') }); // last period
    // An observed session the tower cannot attribute: the sessions directory knows its owner.
    h.emit({
      type: 'session.observed',
      actor: sys,
      scope: { sessionId: 'ses_e' },
      meta: { sessionId: 'ses_e', claudeSessionId: 'c-e', projectId: 'prj_a' },
      payload: { cwd: '/x', transcriptPath: '/x' },
      source: 'hook',
    });
    h.t.sessions!.add({ sessionId: 'ses_e', ownerId: e!.user.id, mode: 'observed' });
    usage(h, 'ses_e', 40_000, { at: at('2026-10-04T05:00:00.000Z') }); // $5/day → $20 lasts 4 days

    const { spend } = await h.snap();
    expect(spend.capForecast).toEqual([
      {
        userId: d!.user.id,
        name: 'Daniel',
        balanceUsd: -5,
        burnPerDayUsd: 1,
        projectedCapAt: '2026-10-08T16:00:00.000Z',
      },
      {
        userId: a!.user.id,
        name: 'Aisyah',
        balanceUsd: 30,
        burnPerDayUsd: 10,
        projectedCapAt: '2026-10-11T16:00:00.000Z',
      },
      {
        userId: e!.user.id,
        name: 'Ella',
        balanceUsd: 20,
        burnPerDayUsd: 5,
        projectedCapAt: '2026-10-12T16:00:00.000Z',
      },
      { userId: b!.user.id, name: 'Wei Jie', balanceUsd: 200, burnPerDayUsd: 2, projectedCapAt: null }, // lasts the period
    ]);
    // Person-level capacity planning is not narrowed by a project filter.
    expect((await h.snap('?projectId=prj_zzz')).spend.capForecast).toHaveLength(4);
  });

  it('cap forecast: a session belongs to the owner its launch recorded, not to the human who launched it; a recorded null is nobody; a rebuild agrees', async () => {
    const credits: CreditService = {
      checkBoundary: () => ({ continue: true }),
      balance: (userId) => ({
        userId,
        period: '2026-10',
        allocationUsd: 100,
        grantedUsd: 0,
        usedUsd: 0,
        balanceUsd: 100,
        autoGrantUsed: false,
        pendingTopupRequestId: null,
        exempt: false,
      }),
    };
    h = await setup({ now: '2026-10-08T16:00:00.000Z', services: { metering: meteringStub().stub, credits } });
    const [alice, bob, carol] = ['Alice', 'Bob', 'Carol'].map((n) => h.t.user('builder', n));
    const run = (sessionId: string, o: Parameters<typeof launch>[2]) => {
      launch(h, sessionId, { at: at('2026-10-01T00:00:00.000Z'), ...o });
      usage(h, sessionId, 80_000, { at: at('2026-10-03T05:00:00.000Z') }); // $80 → $10/day over 8 days
    };
    run('ses_1', { owner: alice!.user.id, ownerId: bob!.user.id }); // Alice started it on Bob's behalf
    run('ses_2', { owner: alice!.user.id, ownerId: null }); // recorded as nobody's
    run('ses_3', { owner: carol!.user.id }); // logged before ownerId existed: the launching human
    const forecast = async () => (await h.snap()).spend.capForecast.map((f) => [f.userId, f.burnPerDayUsd]);
    const expected = [
      [bob!.user.id, 10],
      [carol!.user.id, 10],
    ].sort((x, y) => String(x[0]).localeCompare(String(y[0])));
    expect((await forecast()).sort((x, y) => String(x[0]).localeCompare(String(y[0])))).toEqual(expected);

    h.t.rt.store.rebuildProjections(['tower']);
    expect((await forecast()).sort((x, y) => String(x[0]).localeCompare(String(y[0])))).toEqual(expected);
  });
});
