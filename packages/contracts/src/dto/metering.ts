/**
 * Metering read models (owner: mod-metering, §10, §14). Every cost is a NOTIONAL API-EQUIVALENT figure —
 * internal decision support on a Max plan with no per-token bill, never billing. Subscription spend is
 * actual money and is always reported separately.
 */
import type { ModelTier } from '../domain';
import type { RateCardRate } from '../events/metering';
import type { FxSession } from './fx';

export const NOTIONAL_COST_BASIS = 'notional_api_equivalent' as const;
export const NOTIONAL_COST_LABEL = 'Notional API-equivalent cost (decision support, not a bill)';

export const METERING_GROUP_BYS = ['actor', 'project', 'model', 'processType', 'task', 'session'] as const;
export type MeteringGroupBy = (typeof METERING_GROUP_BYS)[number];
/** org = whole team (audit.view / credit.view_all); mine = the caller's own sessions (?mine=1). */
export type MeteringScope = 'org' | 'mine';
export type MeteringDayStatus = 'closed' | 'open' | 'unmetered';

export interface MeteringFxStamp {
  /** USD→MYR; null when missing. */
  rate: number | null;
  status: 'live' | 'inherited' | 'missing';
  sourceDate: string | null;
  /** BNM session of the rate (null when missing, or for rates and rollups made before sessions were stamped). */
  session: FxSession | null;
}

export interface MeteringTokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  /** cacheWrite5mTokens + cacheWrite1hTokens */
  cacheWriteTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  totalTokens: number;
}

export interface MeteringCostRow extends MeteringTokenTotals {
  messages: number;
  notionalUsd: number;
  /** Σ per-day USD × that day's FX. null when usage exists but no contributing day has an FX rate. */
  notionalRm: number | null;
  /** false when some day with usage had no FX rate (notionalRm then excludes those days). */
  rmComplete: boolean;
  /** Some usage matched no rate (exact or tier fallback) and is counted at zero cost. */
  unpriced: boolean;
  unpricedTokens: number;
  unpricedModels: string[];
  /** Models priced through the tier fallback (approximate). */
  tierPricedModels: string[];
}

export interface MeteringSummaryRow extends MeteringCostRow {
  /** Group key (user id / project id / model / process type / "projectId/taskId" / session id); null = unknown or unattributed. */
  key: string | null;
  label: string | null;
}

export interface MeteringSummaryDTO {
  costBasis: typeof NOTIONAL_COST_BASIS;
  costLabel: string;
  scope: MeteringScope;
  groupBy: MeteringGroupBy;
  from: string;
  to: string;
  rows: MeteringSummaryRow[];
  totals: MeteringCostRow;
  closedDays: number;
  openDays: number;
  fxMissingDays: string[];
  /** Actual subscription spend for the range, prorated per day — never mixed into the notional figure. null for mine. */
  subscription: { usd: number; rm: number | null } | null;
  generatedAt: string;
}

export interface MeteringDayDTO extends MeteringCostRow {
  date: string;
  /** closed = frozen rollup (never restated); open = live; unmetered = before metering began. */
  status: MeteringDayStatus;
  fx: MeteringFxStamp;
  rateCardVersion: number;
  throttleIdleMs: number;
  throttleHits: number;
  /** null for mine. */
  subscriptionUsd: number | null;
  closedAt: string | null;
}

export interface MeteringDailyDTO {
  costBasis: typeof NOTIONAL_COST_BASIS;
  costLabel: string;
  scope: MeteringScope;
  from: string;
  to: string;
  days: MeteringDayDTO[];
  totals: MeteringCostRow & { throttleIdleMs: number; throttleHits: number; subscriptionUsd: number | null };
  lastClosedDay: string | null;
  generatedAt: string;
}

export interface MeteringThrottleDayDTO {
  date: string;
  status: MeteringDayStatus;
  hits: number;
  idleMs: number;
  idleHours: number;
}
export interface MeteringThrottleSessionDTO {
  sessionId: string;
  ownerId: string | null;
  projectId: string | null;
  hits: number;
  idleMs: number;
  idleHours: number;
  /** An open throttle (counted up to now). */
  throttledNow: boolean;
}
export interface MeteringThrottleOwnerDTO {
  ownerId: string | null;
  ownerName: string | null;
  hits: number;
  idleMs: number;
  idleHours: number;
}
export interface MeteringThrottleDTO {
  scope: MeteringScope;
  from: string;
  to: string;
  days: MeteringThrottleDayDTO[];
  bySession: MeteringThrottleSessionDTO[];
  byOwner: MeteringThrottleOwnerDTO[];
  totals: { hits: number; idleMs: number; idleHours: number; throttledNow: number };
  generatedAt: string;
}

export interface RateCardVersionDTO {
  version: number;
  effectiveFrom: string;
  status: 'active' | 'scheduled' | 'superseded';
  currency: 'USD';
  rates: RateCardRate[];
  tierFallback: Partial<Record<ModelTier, string>>;
  note: string | null;
  ratesHash: string;
  publishedAt: string;
  publishedBy: string;
  /** Body crypto-shredded: rates unknown. */
  erased: boolean;
}
export interface RateCardDTO {
  costBasis: typeof NOTIONAL_COST_BASIS;
  costLabel: string;
  today: string;
  active: RateCardVersionDTO | null;
  scheduled: RateCardVersionDTO[];
  lastClosedDay: string | null;
  /** Earliest effectiveFrom a new version may take: tomorrow and after the last closed day (forward-only, R12). */
  earliestEffectiveFrom: string;
}
export interface RateCardVersionsDTO {
  versions: RateCardVersionDTO[];
}
export interface RateCardUpdateInput {
  rates: RateCardRate[];
  /** Defaults to earliestEffectiveFrom; today, past and closed days are rejected. */
  effectiveFrom?: string;
  /** Defaults to the tier fallback of the latest version. */
  tierFallback?: Partial<Record<ModelTier, string>>;
  note?: string;
}

export interface MeteringSubscriptionVersionDTO {
  plan: string;
  seats: number;
  monthlyUsdPerSeat: number;
  monthlyUsd: number;
  effectiveFrom: string;
  status: 'active' | 'scheduled' | 'superseded';
  updatedAt: string;
  updatedBy: string;
}
export interface MeteringSubscriptionDTO {
  basis: 'actual_subscription';
  note: string;
  today: string;
  active: MeteringSubscriptionVersionDTO | null;
  /** Monthly cost prorated over the days of the current month. */
  dailyUsdToday: number;
  scheduled: MeteringSubscriptionVersionDTO[];
  history: MeteringSubscriptionVersionDTO[];
}
export interface MeteringSubscriptionInput {
  plan: string;
  seats: number;
  monthlyUsdPerSeat: number;
  /** Defaults to today; past and closed days are rejected. */
  effectiveFrom?: string;
}

export interface MeteringSessionDTO {
  costBasis: typeof NOTIONAL_COST_BASIS;
  costLabel: string;
  sessionId: string;
  ownerId: string | null;
  projectId: string | null;
  processType: string | null;
  ticketId: string | null;
  totals: MeteringCostRow;
  byModel: MeteringSummaryRow[];
  /** Per-task attribution: usage is assigned to the next task closed in the session (key "projectId/taskId"; null = not yet attributed). */
  byTask: MeteringSummaryRow[];
  byDay: (MeteringCostRow & { date: string })[];
  throttle: { hits: number; idleMs: number; idleHours: number; throttledNow: boolean };
  generatedAt: string;
}

/** Cost-per-outcome is a PORTFOLIO lens only — it never carries per-person fields (§14, ranking corrupts behaviour). */
export interface OutcomeCostStatsDTO {
  count: number;
  totalUsd: number;
  meanUsd: number | null;
  medianUsd: number | null;
  p90Usd: number | null;
  minUsd: number | null;
  maxUsd: number | null;
}
export interface OutcomeCostItemDTO {
  /** ticket id / change id / "projectId/phaseId". */
  refId: string;
  projectId: string | null;
  completedAt: string;
  notionalUsd: number;
  sessions: number;
  unpriced: boolean;
}
export interface OutcomeCostClassDTO {
  kind: 'ticket_fixed' | 'change_shipped' | 'phase_completed';
  stats: OutcomeCostStatsDTO;
  /** Ordered by completion time — deliberately not a cost leaderboard. */
  items: OutcomeCostItemDTO[];
}
export interface CostPerOutcomeDTO {
  costBasis: typeof NOTIONAL_COST_BASIS;
  costLabel: string;
  lens: 'portfolio';
  notice: string;
  from: string;
  to: string;
  ticketsFixed: OutcomeCostClassDTO;
  changesShipped: OutcomeCostClassDTO;
  phasesCompleted: OutcomeCostClassDTO;
  method: { attribution: string; window: string; percentile: string };
  generatedAt: string;
}

export type MigrationScenarioName = 'low' | 'base' | 'high';
export interface MigrationAssumptionDTO {
  key: string;
  label: string;
  value: number;
  unit: string;
  /** default = documented placeholder, query = overridden by the caller, data = measured by metering. */
  source: 'default' | 'query' | 'data';
  description: string;
}
export interface MigrationRunRateDTO {
  windowDays: number;
  /** Days of the window inside the metered history (run-rate divides by these, not by windowDays). */
  coveredDays: number;
  total: number;
  monthly: number;
}
export interface MigrationDriversDTO {
  seatPriceUsd: number;
  seats: number;
  notionalMonthlyUsd: number;
  throttleIdleHoursMonthly: number;
  throttleRecoveryPct: number;
  loadedHourlyCostUsd: number;
  idleToLostHoursFactor: number;
  includedUsagePerSeatUsd: number;
  overagePriceMultiplier: number;
  subscriptionMonthlyUsd: number;
}
export interface MigrationScenarioDTO {
  scenario: MigrationScenarioName;
  description: string;
  drivers: MigrationDriversDTO;
  /** Stay on the current plan: actual subscription + productivity lost to throttling. */
  current: { subscriptionUsd: number; throttleLossUsd: number; totalUsd: number };
  /** Move to Enterprise (assumed pricing): seats + usage beyond the included allowance + residual throttle loss. */
  enterprise: {
    seatsUsd: number;
    usageOverageUsd: number;
    residualThrottleLossUsd: number;
    totalUsd: number;
  };
  /** current − enterprise; positive favours migrating. */
  netMonthlyBenefitUsd: number;
  netAnnualBenefitUsd: number;
  netMonthlyBenefitRm: number | null;
}
export interface MigrationSensitivityRowDTO {
  driver: keyof MigrationDriversDTO;
  label: string;
  unit: string;
  baseValue: number;
  minus20Value: number;
  plus20Value: number;
  netMonthlyAtMinus20Usd: number;
  netMonthlyAtPlus20Usd: number;
  swingUsd: number;
}
export interface MigrationRecommendationDTO {
  costBasis: typeof NOTIONAL_COST_BASIS;
  costLabel: string;
  asOf: string;
  question: string;
  method: string;
  inputs: {
    notionalUsd30d: MigrationRunRateDTO;
    notionalUsd90d: MigrationRunRateDTO;
    throttleIdleHours30d: MigrationRunRateDTO;
    throttleIdleHours90d: MigrationRunRateDTO;
    subscriptionMonthlyUsd: number;
    subscriptionSeats: number;
  };
  assumptions: MigrationAssumptionDTO[];
  /** low = least favourable to migrating, high = most favourable. A range, never a single crossover number. */
  range: Record<MigrationScenarioName, MigrationScenarioDTO>;
  verdict:
    'enterprise_favoured_across_range' | 'current_plan_favoured_across_range' | 'depends_on_assumptions';
  /** ±20% on each driver around the base scenario, largest swing first. */
  sensitivity: MigrationSensitivityRowDTO[];
  fx: MeteringFxStamp;
  caveats: string[];
  generatedAt: string;
}
