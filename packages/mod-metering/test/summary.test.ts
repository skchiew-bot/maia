import { describe, expect, it } from 'vitest';
import type { MeteringDailyDTO, MeteringSummaryDTO } from '@aoc/contracts';
import { launch, meteringRuntime, StubFx, taskDone, usage } from './helpers';

const DAY = 'from=2026-10-09&to=2026-10-09';

async function seeded() {
  const t = await meteringRuntime({
    fx: new StubFx({ '2026-10-09': { rate: 4, status: 'live', sourceDate: '2026-10-09' } }),
  });
  const approver = t.user('approver');
  const alice = t.user('builder', 'Alice');
  const bob = t.user('builder', 'Bob');
  launch(t, { sessionId: 'ses_1', ownerId: alice.user.id, projectId: 'prj_a', processType: 'feature' });
  usage(t, 'ses_1', { input: 1_000_000, cacheRead: 1_000_000 }); // 4.2
  taskDone(t, { sessionId: 'ses_1', taskId: 't1' });
  launch(t, {
    sessionId: 'ses_2',
    ownerId: bob.user.id,
    projectId: 'prj_b',
    processType: 'bug-fix',
    model: 'claude-sonnet-5-5',
  });
  usage(t, 'ses_2', { model: 'claude-sonnet-5-5', output: 1_000_000, cw1h: 1_000_000 }); // 10 + 4
  launch(t, { sessionId: 'ses_3', ownerId: alice.user.id, projectId: 'prj_b', processType: 'bug-triage' });
  usage(t, 'ses_3', { model: 'mystery-model', input: 5_000 }); // unpriced
  usage(t, 'ses_3', { model: 'claude-haiku-9', output: 1_000_000 }); // tier fallback → claude-haiku-5-5: 0.5
  return { t, approver, alice, bob };
}

const rowsOf = (s: MeteringSummaryDTO) => s.rows.map((r) => [r.key, r.notionalUsd]);

describe('metering summary', () => {
  it('groups by model, process type, session, task and project with the token split, RM and unpriced flags', async () => {
    const { t, approver } = await seeded();
    const get = (groupBy: string) =>
      t.json<MeteringSummaryDTO>('GET', `/api/metering/summary?${DAY}&groupBy=${groupBy}`, {
        headers: approver.headers,
      });

    const byModel = await get('model');
    expect(byModel).toMatchObject({
      costBasis: 'notional_api_equivalent',
      scope: 'org',
      groupBy: 'model',
      closedDays: 0,
      openDays: 1,
      fxMissingDays: [],
    });
    expect(byModel.costLabel).toMatch(/notional API-equivalent/i);
    expect(rowsOf(byModel)).toEqual([
      ['claude-sonnet-5-5', 14],
      ['claude-opus-5-5', 4.2],
      ['claude-haiku-9', 0.5],
      ['mystery-model', 0],
    ]);
    expect(byModel.rows[3]).toMatchObject({
      unpriced: true,
      unpricedTokens: 5_000,
      unpricedModels: ['mystery-model'],
    });
    expect(byModel.rows[2]).toMatchObject({ unpriced: false, tierPricedModels: ['claude-haiku-9'] });
    expect(byModel.totals).toMatchObject({
      notionalUsd: 18.7,
      notionalRm: 74.8,
      rmComplete: true,
      inputTokens: 1_005_000,
      outputTokens: 2_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 1_000_000,
      totalTokens: 5_005_000,
      messages: 4,
      unpriced: true,
      unpricedTokens: 5_000,
      unpricedModels: ['mystery-model'],
      tierPricedModels: ['claude-haiku-9'],
    });
    expect(byModel.subscription).toEqual({ usd: 32.258065, rm: 129.032258 });

    expect(rowsOf(await get('processType'))).toEqual([
      ['bug-fix', 14],
      ['feature', 4.2],
      ['bug-triage', 0.5],
    ]);
    expect(rowsOf(await get('session'))).toEqual([
      ['ses_2', 14],
      ['ses_1', 4.2],
      ['ses_3', 0.5],
    ]);
    expect(rowsOf(await get('task'))).toEqual([
      [null, 14.5],
      ['prj_a/t1', 4.2],
    ]);
    expect(rowsOf(await get('project'))).toEqual([
      ['prj_b', 14.5],
      ['prj_a', 4.2],
    ]);
    await t.close();
  });

  it('lists actors by id with names, and ?mine=1 narrows every view to the caller’s own sessions', async () => {
    const { t, approver, alice, bob } = await seeded();
    const byActor = await t.json<MeteringSummaryDTO>('GET', `/api/metering/summary?${DAY}&groupBy=actor`, {
      headers: approver.headers,
    });
    const expected = [
      [alice.user.id, 'Alice', 4.7],
      [bob.user.id, 'Bob', 14],
    ].sort((a, b) => (a[0]! < b[0]! ? -1 : 1));
    expect(byActor.rows.map((r) => [r.key, r.label, r.notionalUsd])).toEqual(expected);

    const mine = await t.json<MeteringSummaryDTO>(
      'GET',
      `/api/metering/summary?${DAY}&groupBy=session&mine=1`,
      { headers: alice.headers },
    );
    expect(mine).toMatchObject({ scope: 'mine', subscription: null });
    expect(rowsOf(mine)).toEqual([
      ['ses_1', 4.2],
      ['ses_3', 0.5],
    ]);
    const daily = await t.json<MeteringDailyDTO>('GET', `/api/metering/daily?${DAY}&mine=1`, {
      headers: bob.headers,
    });
    expect(daily.days[0]).toMatchObject({ notionalUsd: 14, subscriptionUsd: null });
    expect(daily.totals.subscriptionUsd).toBeNull();
    await t.close();
  });

  it('attributes spend to the owner a launch recorded, not to the human who launched it; a recorded null is nobody; a rebuild agrees', async () => {
    const t = await meteringRuntime({
      fx: new StubFx({ '2026-10-09': { rate: 4, status: 'live', sourceDate: '2026-10-09' } }),
    });
    const approver = t.user('approver');
    const alice = t.user('builder', 'Alice');
    const bob = t.user('builder', 'Bob');
    const carol = t.user('builder', 'Carol');
    launch(t, { sessionId: 'ses_1', ownerId: alice.user.id, recordedOwnerId: bob.user.id }); // started for Bob
    usage(t, 'ses_1', { input: 1_000_000 }); // 4
    launch(t, { sessionId: 'ses_2', ownerId: alice.user.id, recordedOwnerId: null }); // nobody's
    t.sessions!.add({ sessionId: 'ses_2', ownerId: alice.user.id }); // a directory that disagrees does not decide it
    usage(t, 'ses_2', { input: 2_000_000 }); // 8
    launch(t, { sessionId: 'ses_3', ownerId: carol.user.id }); // logged before ownerId existed: the launching human
    usage(t, 'ses_3', { input: 3_000_000 }); // 12
    launch(t, { sessionId: 'ses_4', parentSessionId: 'ses_3' }); // … or, with no human, the parent's owner
    usage(t, 'ses_4', { input: 4_000_000 }); // 16

    const people = async () => {
      const r = await t.json<MeteringSummaryDTO>('GET', `/api/metering/summary?${DAY}&groupBy=actor`, {
        headers: approver.headers,
      });
      return Object.fromEntries(r.rows.map((x) => [x.key ?? 'nobody', x.notionalUsd]));
    };
    const expected = { [bob.user.id]: 4, [carol.user.id]: 28, nobody: 8 };
    expect(await people()).toEqual(expected);
    t.rt.store.rebuildProjections(['metering']);
    expect(await people()).toEqual(expected);
    await t.close();
  });

  it('enforces permissions and validates the range', async () => {
    const { t } = await seeded();
    const requester = t.user('requester');
    const builder = t.user('builder');
    expect((await t.request('GET', '/api/metering/summary')).status).toBe(401);
    expect((await t.request('GET', '/api/metering/summary', { headers: requester.headers })).status).toBe(
      403,
    );
    expect(
      (await t.request('GET', '/api/metering/summary?mine=1', { headers: requester.headers })).status,
    ).toBe(403);
    expect((await t.request('GET', '/api/metering/daily', { headers: requester.headers })).status).toBe(403);
    expect((await t.request('GET', '/api/metering/throttle', { headers: requester.headers })).status).toBe(
      403,
    );
    expect((await t.request('GET', '/api/metering/summary', { headers: builder.headers })).status).toBe(200);
    expect(
      (await t.request('GET', '/api/metering/summary?groupBy=person', { headers: builder.headers })).status,
    ).toBe(422);
    expect(
      (
        await t.request('GET', '/api/metering/summary?from=2026-10-09&to=2026-10-01', {
          headers: builder.headers,
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await t.request('GET', '/api/metering/daily?from=2025-01-01&to=2026-10-09', {
          headers: builder.headers,
        })
      ).status,
    ).toBe(422);
    const fallback = await t.json<MeteringSummaryDTO>('GET', '/api/metering/summary', {
      headers: builder.headers,
    });
    expect(fallback).toMatchObject({ from: '2026-09-10', to: '2026-10-09', groupBy: 'actor' });
    await t.close();
  });
});
