/**
 * Migration recommender (§14): current plan vs Claude Enterprise as a RANGE with every assumption exposed
 * and a ±20% sensitivity table. It deliberately never computes a single crossover / break-even number.
 */
import type {
  MigrationAssumptionDTO,
  MigrationDriversDTO,
  MigrationRecommendationDTO,
  MigrationRunRateDTO,
  MigrationScenarioDTO,
  MigrationScenarioName,
  MigrationSensitivityRowDTO,
} from '@aoc/contracts';
import { round2 } from './stats';

/** Documented defaults. Enterprise prices are PLACEHOLDER assumptions, not quotes — override them with the vendor quote. */
export const MIGRATION_DEFAULTS = {
  seatPriceLow: 50,
  seatPriceHigh: 150,
  includedUsagePerSeatUsd: 0,
  overagePriceMultiplier: 1,
  loadedHourlyCostUsd: 30,
  idleToLostHoursFactor: 0.5,
  throttleRecoveryLowPct: 50,
  throttleRecoveryBasePct: 75,
  throttleRecoveryHighPct: 100,
} as const;

export type MigrationAssumptionKey = keyof typeof MIGRATION_DEFAULTS | 'seats';
export type MigrationAssumptionInput = Partial<Record<MigrationAssumptionKey, number>>;
type Resolved = Record<MigrationAssumptionKey, number>;

const DOCS: Record<MigrationAssumptionKey, { label: string; unit: string; description: string }> = {
  seatPriceLow: {
    label: 'Enterprise seat price (low)',
    unit: 'USD/seat/month',
    description: 'Placeholder assumption, not a quote: lower bound of the Enterprise per-seat price.',
  },
  seatPriceHigh: {
    label: 'Enterprise seat price (high)',
    unit: 'USD/seat/month',
    description: 'Placeholder assumption, not a quote: upper bound of the Enterprise per-seat price.',
  },
  seats: {
    label: 'Enterprise seats',
    unit: 'seats',
    description: 'Seats bought on Enterprise; defaults to the seats on the current subscription.',
  },
  includedUsagePerSeatUsd: {
    label: 'Usage included per seat',
    unit: 'USD notional/seat/month',
    description:
      'Notional API-equivalent usage covered by each seat before usage-based overage applies (0 = all usage is billed).',
  },
  overagePriceMultiplier: {
    label: 'Overage price multiplier',
    unit: '× rate-card list price',
    description:
      'Usage beyond the included allowance is billed at this multiple of the rate-card list price (1 = list, 0.8 = 20% discount).',
  },
  loadedHourlyCostUsd: {
    label: 'Loaded hourly cost',
    unit: 'USD/hour',
    description: 'Fully loaded cost of one developer hour, used to value productivity lost to throttling.',
  },
  idleToLostHoursFactor: {
    label: 'Idle-to-lost-hours factor',
    unit: 'ratio',
    description:
      'Share of throttle-idle session hours that become lost developer hours (people switch to other work while an agent waits).',
  },
  throttleRecoveryLowPct: {
    label: 'Throttle loss recovered on Enterprise (low)',
    unit: '%',
    description: 'Share of current throttle loss that Enterprise limits would remove — pessimistic case.',
  },
  throttleRecoveryBasePct: {
    label: 'Throttle loss recovered on Enterprise (base)',
    unit: '%',
    description: 'Share of current throttle loss that Enterprise limits would remove — base case.',
  },
  throttleRecoveryHighPct: {
    label: 'Throttle loss recovered on Enterprise (high)',
    unit: '%',
    description: 'Share of current throttle loss that Enterprise limits would remove — optimistic case.',
  },
};

const DRIVER_DOCS: Record<keyof MigrationDriversDTO, { label: string; unit: string }> = {
  seatPriceUsd: { label: 'Enterprise seat price', unit: 'USD/seat/month' },
  seats: { label: 'Enterprise seats', unit: 'seats' },
  notionalMonthlyUsd: { label: 'Notional API-equivalent spend', unit: 'USD/month' },
  throttleIdleHoursMonthly: { label: 'Throttle idle hours', unit: 'hours/month' },
  throttleRecoveryPct: { label: 'Throttle loss recovered on Enterprise', unit: '%' },
  loadedHourlyCostUsd: { label: 'Loaded hourly cost', unit: 'USD/hour' },
  idleToLostHoursFactor: { label: 'Idle-to-lost-hours factor', unit: 'ratio' },
  includedUsagePerSeatUsd: { label: 'Usage included per seat', unit: 'USD notional/seat/month' },
  overagePriceMultiplier: { label: 'Overage price multiplier', unit: '× list price' },
  subscriptionMonthlyUsd: { label: 'Current subscription', unit: 'USD/month' },
};

export interface MigrationData {
  notionalUsd30d: MigrationRunRateDTO;
  notionalUsd90d: MigrationRunRateDTO;
  throttleIdleHours30d: MigrationRunRateDTO;
  throttleIdleHours90d: MigrationRunRateDTO;
  subscriptionMonthlyUsd: number;
  subscriptionSeats: number;
}

function resolve(data: MigrationData, input: MigrationAssumptionInput): Resolved {
  return { ...MIGRATION_DEFAULTS, seats: data.subscriptionSeats, ...input } as Resolved;
}

/** Cross-field checks after defaults are merged (single-field bounds are validated by the route schema). */
export function migrationProblems(data: MigrationData, input: MigrationAssumptionInput): string[] {
  const a = resolve(data, input);
  const problems: string[] = [];
  if (a.seatPriceLow > a.seatPriceHigh)
    problems.push(`seatPriceLow (${a.seatPriceLow}) must not exceed seatPriceHigh (${a.seatPriceHigh})`);
  if (!(
    a.throttleRecoveryLowPct <= a.throttleRecoveryBasePct &&
    a.throttleRecoveryBasePct <= a.throttleRecoveryHighPct
  )) {
    problems.push('throttle recovery must satisfy low ≤ base ≤ high');
  }
  for (const k of ['throttleRecoveryLowPct', 'throttleRecoveryBasePct', 'throttleRecoveryHighPct'] as const) {
    if (a[k] < 0 || a[k] > 100) problems.push(`${k} must be within 0..100`);
  }
  return problems;
}

const clampPct = (p: number): number => Math.min(100, Math.max(0, p));

export function scenarioDrivers(
  scenario: MigrationScenarioName,
  data: MigrationData,
  a: Resolved,
): MigrationDriversDTO {
  const notional = [data.notionalUsd30d.monthly, data.notionalUsd90d.monthly];
  const idle = [data.throttleIdleHours30d.monthly, data.throttleIdleHours90d.monthly];
  // low = least favourable to migrating: dear seats, the heavier usage run-rate, the lighter throttling, little recovery.
  const pick = <T>(low: T, base: T, high: T): T =>
    scenario === 'low' ? low : scenario === 'high' ? high : base;
  return {
    seatPriceUsd: pick(a.seatPriceHigh, (a.seatPriceLow + a.seatPriceHigh) / 2, a.seatPriceLow),
    seats: a.seats,
    notionalMonthlyUsd: pick(Math.max(...notional), data.notionalUsd30d.monthly, Math.min(...notional)),
    throttleIdleHoursMonthly: pick(Math.min(...idle), data.throttleIdleHours30d.monthly, Math.max(...idle)),
    throttleRecoveryPct: pick(a.throttleRecoveryLowPct, a.throttleRecoveryBasePct, a.throttleRecoveryHighPct),
    loadedHourlyCostUsd: a.loadedHourlyCostUsd,
    idleToLostHoursFactor: a.idleToLostHoursFactor,
    includedUsagePerSeatUsd: a.includedUsagePerSeatUsd,
    overagePriceMultiplier: a.overagePriceMultiplier,
    subscriptionMonthlyUsd: data.subscriptionMonthlyUsd,
  };
}

/** Monthly comparison for one set of drivers. Positive net favours migrating. */
export function evaluateDrivers(
  d: MigrationDriversDTO,
): Pick<MigrationScenarioDTO, 'current' | 'enterprise'> & { netMonthlyUsd: number } {
  const throttleLossUsd = d.throttleIdleHoursMonthly * d.idleToLostHoursFactor * d.loadedHourlyCostUsd;
  const seatsUsd = d.seats * d.seatPriceUsd;
  const usageOverageUsd =
    Math.max(0, d.notionalMonthlyUsd - d.seats * d.includedUsagePerSeatUsd) * d.overagePriceMultiplier;
  const residualThrottleLossUsd = throttleLossUsd * (1 - clampPct(d.throttleRecoveryPct) / 100);
  const currentTotal = d.subscriptionMonthlyUsd + throttleLossUsd;
  const enterpriseTotal = seatsUsd + usageOverageUsd + residualThrottleLossUsd;
  return {
    current: { subscriptionUsd: d.subscriptionMonthlyUsd, throttleLossUsd, totalUsd: currentTotal },
    enterprise: { seatsUsd, usageOverageUsd, residualThrottleLossUsd, totalUsd: enterpriseTotal },
    netMonthlyUsd: currentTotal - enterpriseTotal,
  };
}

const roundDrivers = (d: MigrationDriversDTO): MigrationDriversDTO =>
  Object.fromEntries(Object.entries(d).map(([k, v]) => [k, round2(v)])) as unknown as MigrationDriversDTO;

const SCENARIO_TEXT: Record<MigrationScenarioName, string> = {
  low: 'Least favourable to migrating: high seat price, the heavier of the 30/90-day usage run-rates, the lighter throttling run-rate, low throttle recovery.',
  base: 'Mid seat price, 30-day run-rates, base throttle recovery.',
  high: 'Most favourable to migrating: low seat price, the lighter usage run-rate, the heavier throttling run-rate, high throttle recovery.',
};

function scenario(
  name: MigrationScenarioName,
  data: MigrationData,
  a: Resolved,
  fxRate: number | null,
): MigrationScenarioDTO {
  const drivers = scenarioDrivers(name, data, a);
  const r = evaluateDrivers(drivers);
  return {
    scenario: name,
    description: SCENARIO_TEXT[name],
    drivers: roundDrivers(drivers),
    current: {
      subscriptionUsd: round2(r.current.subscriptionUsd),
      throttleLossUsd: round2(r.current.throttleLossUsd),
      totalUsd: round2(r.current.totalUsd),
    },
    enterprise: {
      seatsUsd: round2(r.enterprise.seatsUsd),
      usageOverageUsd: round2(r.enterprise.usageOverageUsd),
      residualThrottleLossUsd: round2(r.enterprise.residualThrottleLossUsd),
      totalUsd: round2(r.enterprise.totalUsd),
    },
    netMonthlyBenefitUsd: round2(r.netMonthlyUsd),
    netAnnualBenefitUsd: round2(r.netMonthlyUsd * 12),
    netMonthlyBenefitRm: fxRate === null ? null : round2(r.netMonthlyUsd * fxRate),
  };
}

/** ±20% on each driver around the base drivers, largest swing first. */
export function sensitivityTable(base: MigrationDriversDTO): MigrationSensitivityRowDTO[] {
  const rows = (Object.keys(DRIVER_DOCS) as (keyof MigrationDriversDTO)[]).map((driver) => {
    const vary = (factor: number): number => {
      const v = base[driver] * factor;
      return driver === 'throttleRecoveryPct' ? clampPct(v) : v;
    };
    const minus = vary(0.8);
    const plus = vary(1.2);
    const netMinus = evaluateDrivers({ ...base, [driver]: minus }).netMonthlyUsd;
    const netPlus = evaluateDrivers({ ...base, [driver]: plus }).netMonthlyUsd;
    return {
      driver,
      label: DRIVER_DOCS[driver].label,
      unit: DRIVER_DOCS[driver].unit,
      baseValue: round2(base[driver]),
      minus20Value: round2(minus),
      plus20Value: round2(plus),
      netMonthlyAtMinus20Usd: round2(netMinus),
      netMonthlyAtPlus20Usd: round2(netPlus),
      swingUsd: round2(Math.abs(netPlus - netMinus)),
    };
  });
  return rows.sort((a, b) => b.swingUsd - a.swingUsd || (a.driver < b.driver ? -1 : 1));
}

export type MigrationModelResult = Pick<
  MigrationRecommendationDTO,
  'assumptions' | 'range' | 'verdict' | 'sensitivity' | 'caveats' | 'method' | 'question'
>;

export function recommendMigration(
  data: MigrationData,
  input: MigrationAssumptionInput,
  fxRate: number | null,
): MigrationModelResult {
  const a = resolve(data, input);
  const assumptions: MigrationAssumptionDTO[] = (Object.keys(DOCS) as MigrationAssumptionKey[]).map(
    (key) => ({
      key,
      ...DOCS[key],
      value: a[key],
      source: input[key] !== undefined ? 'query' : key === 'seats' ? 'data' : 'default',
    }),
  );
  const range = {
    low: scenario('low', data, a, fxRate),
    base: scenario('base', data, a, fxRate),
    high: scenario('high', data, a, fxRate),
  };
  const verdict: MigrationRecommendationDTO['verdict'] =
    range.low.netMonthlyBenefitUsd > 0
      ? 'enterprise_favoured_across_range'
      : range.high.netMonthlyBenefitUsd < 0
        ? 'current_plan_favoured_across_range'
        : 'depends_on_assumptions';
  const caveats = [
    'Notional API-equivalent spend prices metered tokens at rate-card list prices; the current plan has no per-token bill.',
    'Enterprise prices are assumptions, not quotes: override seatPriceLow, seatPriceHigh, includedUsagePerSeatUsd and overagePriceMultiplier with the vendor quote.',
    'Throttle loss values session idle hours at the loaded hourly cost scaled by idleToLostHoursFactor; an agent waiting on a limit does not always idle a person.',
    'No crossover or break-even figure is produced by design: read the low–high range and the sensitivity table together.',
  ];
  for (const r of [data.notionalUsd30d, data.notionalUsd90d]) {
    if (r.coveredDays < r.windowDays)
      caveats.push(
        `Only ${r.coveredDays} of ${r.windowDays} days are metered: the ${r.windowDays}-day run-rate is extrapolated from them.`,
      );
  }
  return {
    question:
      'Would Claude Enterprise cost less per month than staying on the current plan, once productivity lost to throttling is counted?',
    method:
      'current = subscription + throttle idle hours × idleToLostHoursFactor × loadedHourlyCost; ' +
      'enterprise = seats × seat price + max(0, notional spend − seats × included usage) × overage multiplier + current throttle loss × (1 − recovery%); ' +
      'net benefit = current − enterprise (positive favours migrating). Run-rates are trailing 30/90 complete local days scaled to 30.4375 days.',
    assumptions,
    range,
    verdict,
    sensitivity: sensitivityTable(scenarioDrivers('base', data, a)),
    caveats,
  };
}
