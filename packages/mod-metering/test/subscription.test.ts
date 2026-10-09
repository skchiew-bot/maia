import { describe, expect, it } from 'vitest';
import type { MeteringDailyDTO, MeteringSubscriptionDTO } from '@aoc/contracts';
import { closeDays, launch, meteringRuntime, myt, StubFx, usage } from './helpers';

describe('subscription (actual spend, separate from notional cost)', () => {
  it('is edited forward-only, prorated per day, and never restates a closed day', async () => {
    const t = await meteringRuntime();
    const approver = t.user('approver');
    const builder = t.user('builder');
    const put = (body: unknown, headers = approver.headers) =>
      t.request('PUT', '/api/metering/subscription', { headers, body });

    t.clock.set(myt('2026-10-10', '00:20'));
    await closeDays(t); // freezes 10-09 at 5 seats
    expect((await put({ plan: 'max', seats: 7, monthlyUsdPerSeat: 200 }, builder.headers)).status).toBe(403);
    expect(
      (await t.request('GET', '/api/metering/subscription', { headers: t.user('requester').headers })).status,
    ).toBe(403);
    const past = await put({ plan: 'max', seats: 7, monthlyUsdPerSeat: 200, effectiveFrom: '2026-10-09' });
    expect(await past.json()).toMatchObject({
      error: { code: 'forward_only', details: { earliestEffectiveFrom: '2026-10-10' } },
    });
    expect((await put({ plan: 'max', seats: -1, monthlyUsdPerSeat: 200 })).status).toBe(422);
    expect((await put({ plan: 'max plan', seats: 1, monthlyUsdPerSeat: 200 })).status).toBe(422); // plan is a machine label

    const now = await t.json<MeteringSubscriptionDTO>('PUT', '/api/metering/subscription', {
      headers: approver.headers,
      body: { plan: 'max', seats: 7, monthlyUsdPerSeat: 200 },
      expect: 201,
    });
    expect(now.active).toMatchObject({
      seats: 7,
      monthlyUsd: 1400,
      effectiveFrom: '2026-10-10',
      status: 'active',
      updatedBy: approver.user.id,
    });
    expect(now.dailyUsdToday).toBeCloseTo(1400 / 31, 5);
    const later = await t.json<MeteringSubscriptionDTO>('PUT', '/api/metering/subscription', {
      headers: approver.headers,
      body: { plan: 'enterprise', seats: 7, monthlyUsdPerSeat: 90, effectiveFrom: '2026-11-01' },
      expect: 201,
    });
    expect(later.scheduled).toMatchObject([
      { plan: 'enterprise', effectiveFrom: '2026-11-01', monthlyUsd: 630 },
    ]);
    expect(later.history.map((h) => [h.seats, h.status])).toEqual([
      [7, 'scheduled'],
      [7, 'active'],
      [5, 'superseded'],
    ]);

    const daily = await t.json<MeteringDailyDTO>('GET', '/api/metering/daily?from=2026-10-09&to=2026-10-10', {
      headers: approver.headers,
    });
    expect(daily.days.map((d) => [d.date, d.status, d.subscriptionUsd])).toEqual([
      ['2026-10-09', 'closed', 32.258065], // frozen at 5 seats
      ['2026-10-10', 'open', 45.16129], // 7 × $200 / 31
    ]);
    // subscription is never folded into the notional figure
    expect(daily.totals).toMatchObject({ notionalUsd: 0, subscriptionUsd: 77.419355 });
    await t.close();
  });
});

describe('MeteringService', () => {
  it('prices notional cost by date, delegates FX to the fx service and totals sessions', async () => {
    const t = await meteringRuntime({
      fx: new StubFx({ '2026-10-09': { rate: 4.2, status: 'live', sourceDate: '2026-10-09' } }),
    });
    const svc = t.rt.services.get('metering');
    const usageTotals = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 1_000_000,
    };
    expect(svc.notionalCostUsd('claude-opus-5-5', usageTotals, '2026-10-09')).toBeCloseTo(12, 9);
    expect(svc.notionalCostUsd('claude-opus-5-5', usageTotals, '2026-09-30')).toBe(0); // before any card
    expect(svc.notionalCostUsd('who-knows', usageTotals, '2026-10-09')).toBe(0);
    expect(svc.fxRate('2026-10-09')).toEqual({ rate: 4.2, status: 'live', sourceDate: '2026-10-09' });
    expect(svc.fxRate('2026-10-10')).toBeNull();
    launch(t, { sessionId: 'ses_1', ownerId: null });
    usage(t, 'ses_1', { input: 250_000 });
    usage(t, 'ses_1', { output: 250_000 });
    expect(svc.sessionCostUsd('ses_1')).toBeCloseTo(6, 9);
    expect(svc.sessionCostUsd('ses_none')).toBe(0);
    expect(svc.activeRateCardVersion('2026-09-30')).toBe(0);
    await t.close();
  });
});
