import { describe, expect, it } from 'vitest';
import type { MeteringDailyDTO, MeteringSummaryDTO, PayloadOf, RateCardDTO } from '@aoc/contracts';
import { METERING_CLOSE_JOB } from '../src';
import {
  closeDays,
  HOUR,
  launch,
  meteringRuntime,
  myt,
  StubFx,
  throttleCleared,
  throttleHit,
  usage,
} from './helpers';

const live = (date: string, rate: number) => ({ rate, status: 'live' as const, sourceDate: date });

describe('daily close', () => {
  it('runs after the configured local time, closes every unclosed day before today once, and stamps FX live / inherited / missing', async () => {
    const fx = new StubFx({
      '2026-10-09': live('2026-10-09', 4.2),
      '2026-10-10': { rate: 4.2, status: 'inherited', sourceDate: '2026-10-09' },
    });
    const t = await meteringRuntime({ fx });
    const approver = t.user('approver');
    const alice = t.user('builder', 'Alice');
    launch(t, { sessionId: 'ses_a', ownerId: alice.user.id, projectId: 'prj_a', processType: 'feature' });
    launch(t, {
      sessionId: 'ses_b',
      ownerId: approver.user.id,
      projectId: 'prj_b',
      processType: 'bug-fix',
      model: 'claude-sonnet-5-5',
    });
    usage(t, 'ses_a', {
      input: 1_000_000,
      cacheRead: 2_000_000,
      cw5m: 1_000_000,
      cw1h: 500_000,
      messages: 3,
    }); // 4 + 0.4 + 5 + 4 = 13.4
    usage(t, 'ses_b', { model: 'claude-sonnet-5-5', output: 1_000_000 }); // 10
    usage(t, 'ses_b', { model: 'mystery-model', input: 700 }); // unpriced
    t.clock.set(myt('2026-10-09', '23:00'));
    throttleHit(t, 'ses_a');

    t.clock.set(myt('2026-10-10', '00:10'));
    expect(await t.rt.tickJobs()).toEqual([]); // before closeDayAfterLocalTime (00:15)
    t.clock.set(myt('2026-10-10', '00:20'));
    expect(await t.rt.tickJobs()).toEqual([METERING_CLOSE_JOB]);
    expect(await t.rt.tickJobs()).toEqual([]);
    await t.rt.runJob(METERING_CLOSE_JOB); // a manual re-run is a no-op
    const [rollup, ...more] = t.rt.store.list({ types: ['rollup.closed'] });
    expect(more).toHaveLength(0);
    expect(rollup!.meta).toMatchObject({
      date: '2026-10-09',
      usdNotional: 23.4,
      rmNotional: 98.28,
      fxRate: 4.2,
      fxStatus: 'live',
      fxSourceDate: '2026-10-09',
      rateCardVersion: 1,
      inputTokens: 1_000_700,
      outputTokens: 1_000_000,
      cacheReadTokens: 2_000_000,
      cacheWriteTokens: 1_500_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 500_000,
      messages: 5,
      unpricedTokens: 700,
      throttleIdleMs: HOUR, // 23:00 → midnight; the throttle is still open
      throttleHits: 1,
      subscriptionUsd: 32.258065, // 5 seats × $200 / 31 days
      closedAt: myt('2026-10-10', '00:20'),
    });
    const body = t.rt.store.readPayload(rollup!) as PayloadOf<'rollup.closed'>;
    expect(body.byProject.map((r) => [r.key, r.usd, r.rm])).toEqual([
      ['prj_a', 13.4, 56.28],
      ['prj_b', 10, 42],
    ]);
    expect(body.byModel.map((r) => r.key)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'mystery-model']);
    expect(body.byProcessType.map((r) => [r.key, r.usd])).toEqual([
      ['bug-fix', 10],
      ['feature', 13.4],
    ]);
    expect(body.byActor.find((r) => r.key === alice.user.id)).toMatchObject({
      usd: 13.4,
      throttleIdleMs: HOUR,
      throttleHits: 1,
    });
    expect(body.unpricedModels).toEqual(['mystery-model']);

    // the daemon was down for a while: the next run catches up every missing day; 10-11 has no FX at all
    t.clock.set(myt('2026-10-11', '09:00'));
    throttleCleared(t, 'ses_a', 10 * HOUR);
    usage(t, 'ses_a', { output: 100_000 }); // $2 on 10-11
    t.clock.set(myt('2026-10-12', '08:00'));
    await closeDays(t);
    const closed = t.rt.store.list({ types: ['rollup.closed'] }).map((e) => e.meta);
    expect(
      closed.map((m) => [m.date, m.fxStatus, m.fxSourceDate, m.usdNotional, m.rmNotional, m.throttleIdleMs]),
    ).toEqual([
      ['2026-10-09', 'live', '2026-10-09', 23.4, 98.28, HOUR],
      ['2026-10-10', 'inherited', '2026-10-09', 0, 0, 9 * HOUR], // the rest of the 10h throttle
      ['2026-10-11', 'missing', null, 2, 0, 0],
    ]);

    const daily = await t.json<MeteringDailyDTO>('GET', '/api/metering/daily?from=2026-10-08&to=2026-10-12', {
      headers: approver.headers,
    });
    expect(daily.days.map((d) => [d.date, d.status, d.fx.status, d.notionalRm])).toEqual([
      ['2026-10-08', 'unmetered', 'missing', 0],
      ['2026-10-09', 'closed', 'live', 98.28],
      ['2026-10-10', 'closed', 'inherited', 0],
      ['2026-10-11', 'closed', 'missing', null],
      ['2026-10-12', 'open', 'missing', 0],
    ]);
    expect(daily.days[1]).toMatchObject({
      closedAt: myt('2026-10-10', '00:20'),
      subscriptionUsd: 32.258065,
      unpriced: true,
      unpricedModels: ['mystery-model'],
    });
    expect(daily.totals).toMatchObject({
      notionalUsd: 25.4,
      notionalRm: 98.28,
      rmComplete: false,
      throttleIdleMs: 10 * HOUR,
    });
    expect(daily.lastClosedDay).toBe('2026-10-11');
    const summary = await t.json<MeteringSummaryDTO>(
      'GET',
      '/api/metering/summary?from=2026-10-09&to=2026-10-12&groupBy=project',
      { headers: approver.headers },
    );
    expect(summary.fxMissingDays).toEqual(['2026-10-11']);
    expect(summary.totals).toMatchObject({ notionalUsd: 25.4, rmComplete: false });
    await t.close();
  });

  it('serves closed days from the frozen rollup, and degrades to its chained meta when the breakdown body is erased', async () => {
    const t = await meteringRuntime({ fx: new StubFx({ '2026-10-09': live('2026-10-09', 4) }) });
    const approver = t.user('approver');
    launch(t, { sessionId: 'ses_1', ownerId: approver.user.id, projectId: 'prj_a' });
    usage(t, 'ses_1', { input: 1_000_000 }); // $4
    t.clock.set(myt('2026-10-10', '00:20'));
    await closeDays(t);
    // drift in the live projection must never leak into a closed day
    t.rt.ctx.db.prepare('UPDATE mtr_usage SET cost_usd = cost_usd * 10').run();
    const range = 'from=2026-10-09&to=2026-10-09';
    for (const groupBy of ['actor', 'project', 'model', 'processType']) {
      const s = await t.json<MeteringSummaryDTO>('GET', `/api/metering/summary?${range}&groupBy=${groupBy}`, {
        headers: approver.headers,
      });
      expect(s.totals).toMatchObject({ notionalUsd: 4, notionalRm: 16 });
      expect(s.closedDays).toBe(1);
    }
    expect(
      (await t.json<MeteringDailyDTO>('GET', `/api/metering/daily?${range}`, { headers: approver.headers }))
        .totals.notionalUsd,
    ).toBe(4);

    t.rt.store.eraseScope('metering', { actor: { kind: 'human', id: approver.user.id }, reason: 'other' });
    t.rt.store.rebuildProjections(['metering']);
    const erased = await t.json<MeteringSummaryDTO>('GET', `/api/metering/summary?${range}&groupBy=project`, {
      headers: approver.headers,
    });
    expect(erased.rows).toMatchObject([
      { key: '[erased]', label: '[erased]', notionalUsd: 4, notionalRm: 16 },
    ]);
    expect(
      (await t.json<MeteringDailyDTO>('GET', `/api/metering/daily?${range}`, { headers: approver.headers }))
        .days[0],
    ).toMatchObject({ status: 'closed', notionalUsd: 4 });
    const rc = await t.json<RateCardDTO>('GET', '/api/ratecard', { headers: approver.headers });
    expect(rc.active).toMatchObject({ version: 1, erased: true, rates: [] });
    await t.close();
  });
});
