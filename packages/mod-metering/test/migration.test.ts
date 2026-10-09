import { describe, expect, it } from 'vitest';
import type { MigrationRecommendationDTO } from '@aoc/contracts';
import { MIGRATION_DEFAULTS, recommendMigration } from '../src';
import type { MigrationData } from '../src/migration';
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

const rr = (windowDays: number, monthly: number) => ({
  windowDays,
  coveredDays: windowDays,
  total: monthly,
  monthly,
});
const DATA: MigrationData = {
  notionalUsd30d: rr(30, 3043.75),
  notionalUsd90d: rr(90, 2029.17),
  throttleIdleHours30d: rr(30, 40.58),
  throttleIdleHours90d: rr(90, 60),
  subscriptionMonthlyUsd: 1000,
  subscriptionSeats: 5,
};
const DRIVERS = [
  'seatPriceUsd',
  'seats',
  'notionalMonthlyUsd',
  'throttleIdleHoursMonthly',
  'throttleRecoveryPct',
  'loadedHourlyCostUsd',
  'idleToLostHoursFactor',
  'includedUsagePerSeatUsd',
  'overagePriceMultiplier',
  'subscriptionMonthlyUsd',
];

function keysOf(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) (out.add(k), keysOf(x, out));
  return out;
}

describe('migration recommender (pure)', () => {
  it('returns a low/base/high range with every assumption exposed, never a crossover number', () => {
    const r = recommendMigration(DATA, {}, 4.2);
    const { low, base, high } = r.range;
    expect(low.netMonthlyBenefitUsd).toBeLessThanOrEqual(base.netMonthlyBenefitUsd);
    expect(base.netMonthlyBenefitUsd).toBeLessThanOrEqual(high.netMonthlyBenefitUsd);
    // base: current = 1000 + 40.58h × 0.5 × $30; enterprise = 5 × $100 + $3043.75 + 25% of the throttle loss
    expect(base.drivers).toMatchObject({
      seatPriceUsd: 100,
      seats: 5,
      notionalMonthlyUsd: 3043.75,
      throttleIdleHoursMonthly: 40.58,
      throttleRecoveryPct: 75,
    });
    expect(base.current).toEqual({ subscriptionUsd: 1000, throttleLossUsd: 608.7, totalUsd: 1608.7 });
    expect(base.enterprise.seatsUsd).toBe(500);
    expect(base.enterprise.usageOverageUsd).toBe(3043.75);
    expect(base.enterprise.residualThrottleLossUsd).toBeCloseTo(152.18, 1);
    expect(base.netMonthlyBenefitUsd).toBeCloseTo(-2087.22, 1);
    expect(base.netAnnualBenefitUsd).toBeCloseTo(-25046.7, 0);
    expect(base.netMonthlyBenefitRm).toBeCloseTo(-8766.35, 0);
    expect(low.drivers).toMatchObject({
      seatPriceUsd: 150,
      notionalMonthlyUsd: 3043.75,
      throttleIdleHoursMonthly: 40.58,
      throttleRecoveryPct: 50,
    });
    expect(high.drivers).toMatchObject({
      seatPriceUsd: 50,
      notionalMonthlyUsd: 2029.17,
      throttleIdleHoursMonthly: 60,
      throttleRecoveryPct: 100,
    });
    expect(r.verdict).toBe('current_plan_favoured_across_range');

    expect(r.assumptions.map((a) => a.key).sort()).toEqual(
      [...Object.keys(MIGRATION_DEFAULTS), 'seats'].sort(),
    );
    for (const a of r.assumptions) expect(a.description.length).toBeGreaterThan(10);
    expect(r.assumptions.find((a) => a.key === 'seats')).toMatchObject({ value: 5, source: 'data' });
    expect(r.assumptions.find((a) => a.key === 'seatPriceLow')).toMatchObject({
      value: 50,
      source: 'default',
      unit: 'USD/seat/month',
    });

    expect(r.sensitivity.map((s) => s.driver).sort()).toEqual([...DRIVERS].sort());
    const [first, second] = r.sensitivity;
    expect([first!.driver, second!.driver]).toEqual(['notionalMonthlyUsd', 'overagePriceMultiplier']);
    expect(first).toMatchObject({
      baseValue: 3043.75,
      minus20Value: 2435,
      plus20Value: 3652.5,
      swingUsd: 1217.5,
    });
    for (let i = 1; i < r.sensitivity.length; i++)
      expect(r.sensitivity[i - 1]!.swingUsd).toBeGreaterThanOrEqual(r.sensitivity[i]!.swingUsd);
    const recovery = r.sensitivity.find((s) => s.driver === 'throttleRecoveryPct')!;
    expect([recovery.minus20Value, recovery.plus20Value]).toEqual([60, 90]);
    expect([...keysOf(r)].filter((k) => /crossover|break.?even/i.test(k))).toEqual([]);
  });

  it('reports a verdict only when the whole range agrees, and clamps recovery at 100%', () => {
    expect(recommendMigration(DATA, { includedUsagePerSeatUsd: 500 }, null).verdict).toBe(
      'enterprise_favoured_across_range',
    );
    const mixed = recommendMigration(DATA, { includedUsagePerSeatUsd: 400 }, null);
    expect(mixed.verdict).toBe('depends_on_assumptions');
    expect(mixed.range.low.netMonthlyBenefitUsd).toBeLessThan(0);
    expect(mixed.range.high.netMonthlyBenefitUsd).toBeGreaterThan(0);
    expect(mixed.range.base.netMonthlyBenefitRm).toBeNull();
    const full = recommendMigration(
      DATA,
      { throttleRecoveryBasePct: 100, throttleRecoveryHighPct: 100 },
      null,
    );
    expect(full.sensitivity.find((s) => s.driver === 'throttleRecoveryPct')!.plus20Value).toBe(100);
    expect(full.assumptions.find((a) => a.key === 'throttleRecoveryBasePct')!.source).toBe('query');
  });
});

describe('GET /api/metering/migration', () => {
  it('derives trailing run-rates from metered history and exposes overrides, range and sensitivity', async () => {
    const t = await meteringRuntime({
      fx: new StubFx({ '2026-10-12': { rate: 4, status: 'inherited', sourceDate: '2026-10-10' } }),
    });
    const approver = t.user('approver');
    launch(t, { sessionId: 'ses_1', ownerId: approver.user.id });
    usage(t, 'ses_1', { output: 1_000_000 }); // 10-09: $20
    t.clock.set(myt('2026-10-10', '09:00'));
    usage(t, 'ses_1', { output: 500_000 }); // 10-10: $10
    throttleHit(t, 'ses_1');
    t.clock.set(myt('2026-10-10', '12:00'));
    throttleCleared(t, 'ses_1', 3 * HOUR);
    t.clock.set(myt('2026-10-12', '08:00'));
    await closeDays(t);
    usage(t, 'ses_1', { output: 5_000_000 }); // today's usage is outside the complete-day window

    const dto = await t.json<MigrationRecommendationDTO>(
      'GET',
      '/api/metering/migration?seatPriceLow=20&loadedHourlyCostUsd=45',
      { headers: approver.headers },
    );
    expect(dto).toMatchObject({
      costBasis: 'notional_api_equivalent',
      asOf: '2026-10-12',
      fx: { rate: 4, status: 'inherited' },
    });
    // 10-09 .. 10-11 are metered: $30 over 3 days → 30.4375-day month
    expect(dto.inputs.notionalUsd30d).toEqual({ windowDays: 30, coveredDays: 3, total: 30, monthly: 304.38 });
    expect(dto.inputs.notionalUsd90d).toMatchObject({ windowDays: 90, coveredDays: 3, total: 30 });
    expect(dto.inputs.throttleIdleHours30d).toMatchObject({ coveredDays: 3, total: 3, monthly: 30.44 });
    expect(dto.inputs).toMatchObject({ subscriptionMonthlyUsd: 1000, subscriptionSeats: 5 });
    expect(dto.assumptions.find((a) => a.key === 'seatPriceLow')).toMatchObject({
      value: 20,
      source: 'query',
    });
    expect(dto.assumptions.find((a) => a.key === 'loadedHourlyCostUsd')).toMatchObject({
      value: 45,
      source: 'query',
    });
    expect(dto.assumptions.find((a) => a.key === 'seatPriceHigh')).toMatchObject({
      value: 150,
      source: 'default',
    });
    expect(dto.range.high.drivers.seatPriceUsd).toBe(20);
    expect(dto.range.base.drivers.seatPriceUsd).toBe(85);
    expect(dto.range.low.netMonthlyBenefitUsd).toBeLessThanOrEqual(dto.range.high.netMonthlyBenefitUsd);
    expect(dto.sensitivity).toHaveLength(DRIVERS.length);
    expect(dto.caveats.some((c) => /Only 3 of 30 days/.test(c))).toBe(true);
    expect([...keysOf(dto)].filter((k) => /crossover|break.?even/i.test(k))).toEqual([]);

    const bad = (q: string) =>
      t.request('GET', `/api/metering/migration?${q}`, { headers: approver.headers }).then((r) => r.status);
    expect(await bad('seatPriceLow=500')).toBe(422); // above the default high
    expect(await bad('throttleRecoveryBasePct=120')).toBe(422);
    expect(await bad('seatPriceHigh=-1')).toBe(422);
    expect(await bad('seatPricelow=10')).toBe(422); // a misspelt assumption is rejected, never silently defaulted
    expect(
      (await t.request('GET', '/api/metering/migration', { headers: t.user('requester').headers })).status,
    ).toBe(403);
    await t.close();
  });
});
