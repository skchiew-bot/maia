/** Read models / DTOs for mod-fx (§10 rate card & FX). Field enums derive from the fx event catalog. */
import type { DecisionStatus } from '../domain';
import type { FX_DISCREPANCY_OPTIONS } from '../events/fx';
import type { MetaOf } from '../events';

type RateMeta = MetaOf<'fx.rate_recorded'>;
export type FxRateStatus = RateMeta['status'];
export type FxExtractor = RateMeta['extractor'];
export type FxValidation = RateMeta['validation'];
export type FxReason = RateMeta['reason'];
export type FxDiscrepancyChoice = (typeof FX_DISCREPANCY_OPTIONS)[number];

/** Carried-forward reasons that need attention (shown flagged); weekend/holiday gaps are by design. */
export const FX_FLAGGED_REASONS: readonly FxReason[] = [
  'source_unreadable',
  'validation_failed',
  'discrepancy_pending',
];

/** One day's USD/MYR rate as recorded (latest record for the day; earlier records stay in the audit log). */
export interface FxRateDTO {
  date: string;
  pair: 'USD/MYR';
  rate: number;
  status: FxRateStatus;
  /** The publication date the rate comes from (= date when live). */
  sourceDate: string;
  extractor: FxExtractor;
  validation: FxValidation;
  reason: FxReason;
  flagged: boolean;
  recordedAt: string;
  recordedBy: string;
  /** Number of fx.rate_recorded events for this day (>1 after a same-day retry, resolution or override). */
  revisions: number;
  /** Day frozen by a metering rollup — never restated. */
  closed: boolean;
  /** From the encrypted body; null when absent or erased. */
  sourceUrl: string | null;
  rawExcerpt: string | null;
  evidence: string | null;
  notes: string | null;
  session: string | null;
  official: number | null;
  officialDate: string | null;
  problems: string[];
}

export interface FxDiscrepancyDTO {
  date: string;
  decisionId: string;
  /** The scraped figure that passed self-validation and was re-confirmed by one re-fetch. */
  scraped: number;
  /** The conflicting BNM Open API figure. */
  official: number;
  scrapedDate: string | null;
  officialDate: string | null;
  extractor: 'haiku' | 'sonnet' | null;
  status: 'open' | 'resolved';
  /** Live state of the decision card (null when the decision service does not know it). */
  decisionStatus: DecisionStatus | null;
  raisedAt: string;
  resolvedAt: string | null;
  chosenRate: number | null;
  choice: FxDiscrepancyChoice | null;
  applied: boolean | null;
}

export interface FxStatusDTO {
  today: string;
  enabled: boolean;
  runAtLocalTime: string;
  todayRecord: FxRateDTO | null;
  /** Rate in effect today (carried forward from the latest prior day when today has no record). */
  current: { rate: number; status: FxRateStatus; sourceDate: string } | null;
  lastLive: { date: string; rate: number } | null;
  /** Consecutive carried-forward weekdays ending today (weekends neither count nor break the streak). */
  carryForward: { days: number; since: string | null; alertAfterDays: number; alerted: boolean };
  /** Most recent open discrepancy (decision pending or awaiting a manual rate). */
  openDiscrepancy: FxDiscrepancyDTO | null;
  openDiscrepancyCount: number;
}

export type FxRunOutcome =
  | 'live'
  | 'inherited'
  | 'carried_forward'
  | 'discrepancy'
  | 'unchanged'
  | 'skipped_live'
  | 'skipped_manual'
  | 'skipped_closed'
  | 'skipped_discrepancy'
  | 'no_rate';

export interface FxRunResultDTO {
  date: string;
  outcome: FxRunOutcome;
  record: FxRateDTO | null;
  discrepancyDecisionId: string | null;
  /** Machine problem codes collected during the run. */
  problems: string[];
}

export interface FxOverrideRequest {
  rate: number;
  reason: string;
}
