/**
 * Read models / DTOs for mod-learning (§11). Root-cause classes only: no learning API returns actor or user
 * ids, names, session ids or per-person counts (R11) — blame data makes error reporting go dark.
 */
import { z } from 'zod';
import {
  OFFENCE_STATES,
  ROOT_CAUSE_DIMENSIONS,
  type ModelTier,
  type OffenceState,
  type RootCauseDimension,
} from '../domain';
import {
  LESSON_SCOPE_TYPES,
  type ErrorPriority,
  type ErrorSource,
  type LessonScopeType,
  type RootCauseAssigner,
} from '../events/learning';

/** metering = rate card via MeteringService; estimate = built-in per-tier list prices; none = no linked session usage. */
export type CostBasis = 'metering' | 'estimate' | 'none';

/** Cost of one occurrence: the linked session's usage in the window after the error (default 30 min). */
export interface OccurrenceCostDTO {
  usd: number;
  ms: number;
  tokens: number;
  basis: CostBasis;
  /** usd × the UAT/high-priority multiplier — what offence ranking sums. */
  weightedUsd: number;
  /** The cost window is still open, so the number can still grow. */
  provisional: boolean;
}

export interface ErrorOccurrenceDTO {
  errorId: string;
  observedAt: string;
  source: ErrorSource;
  priority: ErrorPriority;
  signature: string;
  /** Normalised message the signature hashes; null when the body was erased. */
  template: string | null;
  /** "[erased]" when the body was crypto-shredded. Untrusted text — escape when rendering. */
  message: string;
  fix: string | null;
  /** Reporter's own unverified root-cause label. */
  rootCauseHint: string | null;
  codeArea: string | null;
  processType: string | null;
  modelTier: ModelTier | 'unknown' | null;
  projectId: string | null;
  classId: string | null;
  className: string | null;
  assignedBy: RootCauseAssigner | null;
  confidence: number | null;
  cost: OccurrenceCostDTO;
}

export interface RootCauseClassDTO {
  classId: string;
  name: string;
  description: string | null;
  dimension: RootCauseDimension;
  origin: 'human' | 'ai';
  createdAt: string;
  occurrences: number;
  highPriorityOccurrences: number;
  costOfRecurrenceUsd: number;
  lastSeenAt: string | null;
  offence: { offenceId: string; state: OffenceState } | null;
}

export interface OffenceHistoryEntryDTO {
  from: OffenceState | null;
  to: OffenceState;
  at: string;
  occurrences: number;
  costOfRecurrenceUsd: number;
  note: string | null;
}

export interface OffenceDTO {
  offenceId: string;
  classId: string;
  className: string;
  dimension: RootCauseDimension;
  state: OffenceState;
  occurrences: number;
  occurrencesSinceFix: number;
  highPriorityOccurrences: number;
  /** Ranking key: Σ occurrence cost × priority multiplier (never the raw count). */
  costOfRecurrenceUsd: number;
  costMs: number;
  costTokens: number;
  detectedAt: string;
  lastTransitionAt: string;
  fixAppliedAt: string | null;
  /** fixAppliedAt + verifyWindowDays: verified_closed after this if nothing recurs. */
  verifyDueAt: string | null;
  verifiedClosedAt: string | null;
  reopenCount: number;
  fix: string | null;
  history: OffenceHistoryEntryDTO[];
}

/** Recurrence trend chart: weekly occurrence counts per root-cause class (repeats only, ≥2 occurrences). */
export interface RecurrenceTrendDTO {
  /** Week start dates (Monday, local timezone), oldest → newest. */
  weeks: string[];
  classes: {
    classId: string;
    name: string;
    dimension: RootCauseDimension;
    counts: number[];
    total: number;
    offenceState: OffenceState | null;
  }[];
  /** Occurrences not (yet) in any class — transient noise, shown for context only. */
  unclassified: number[];
}

export type ModelVerdict = 'model_capability' | 'spec_context_tooling' | 'inconclusive';

export interface TierStatDTO {
  tier: ModelTier;
  runs: number;
  occurrences: number;
}

export interface ModelDimensionProcessDTO {
  processType: string;
  verdict: ModelVerdict;
  tiers: TierStatDTO[];
  cheaperTier: ModelTier | null;
  strongerTier: ModelTier | null;
  /** "targeted per-process-type upgrade for <processType> (…)" — never a blanket upgrade. */
  recommendation: string | null;
}

export interface ModelDimensionClassDTO {
  classId: string;
  name: string;
  dimension: RootCauseDimension;
  occurrences: number;
  verdict: ModelVerdict;
  /** "model capability …" | "spec/context/tooling, not the model" | "inconclusive …". */
  summary: string;
  recommendations: string[];
  byTier: TierStatDTO[];
  byProcessType: ModelDimensionProcessDTO[];
}

export interface ModelDimensionReportDTO {
  generatedAt: string;
  minRunsPerTier: number;
  classes: ModelDimensionClassDTO[];
}

export type LessonStatus = 'proposed' | 'bound' | 'rejected' | 'retired';

export interface LessonUsageDTO {
  appliedRuns: number;
  /** Runs that actually exercised the lesson's scope. */
  usedRuns: number;
  unusedRuns: number;
  /** Runs still in progress (not yet known whether the scope will be exercised). */
  pendingRuns: number;
  /** Consecutive applied-but-unused runs (most recent first); retired at retireAfterUnusedRuns. */
  unusedStreak: number;
  retireAfterUnusedRuns: number;
}

/** prevented = baseline recurrence rate per exposure before binding × exposures after − actual recurrences after. */
export interface LessonPayoffDTO {
  measurable: boolean;
  exposuresBefore: number;
  occurrencesBefore: number;
  baselineRatePerExposure: number;
  exposuresAfter: number;
  recurrencesAfter: number;
  expectedRecurrences: number;
  /** May be negative: the lesson is not working (prune it). */
  repeatsPrevented: number;
  avgOccurrenceCostUsd: number;
  avgOccurrenceMs: number;
  avgOccurrenceTokens: number;
  usdSaved: number;
  msSaved: number;
  tokensSaved: number;
}

export interface LessonDTO {
  lessonId: string;
  classId: string | null;
  className: string | null;
  scopeType: LessonScopeType;
  scopeValue: string;
  status: LessonStatus;
  origin: 'human' | 'ai';
  rule: string;
  fix: string;
  rationale: string | null;
  decisionId: string;
  proposedAt: string;
  boundAt: string | null;
  rejectedAt: string | null;
  retiredAt: string | null;
  retireReason: 'unused' | 'superseded' | 'manual' | null;
  usage: LessonUsageDTO;
  payoff: LessonPayoffDTO | null;
}

// ── requests ────────────────────────────────────────────────────────────────
const className = z.string().trim().min(2).max(120);
const classDescription = z.string().trim().max(2000);

export const CreateRootCauseClassRequest = z
  .object({
    name: className,
    dimension: z.enum(ROOT_CAUSE_DIMENSIONS),
    description: classDescription.optional(),
  })
  .strict();
export type CreateRootCauseClassRequest = z.infer<typeof CreateRootCauseClassRequest>;

export const AssignRootCauseRequest = z.union([
  z.object({ classId: z.string().min(1).max(64) }).strict(),
  z.object({ newClass: CreateRootCauseClassRequest }).strict(),
]);
export type AssignRootCauseRequest = z.infer<typeof AssignRootCauseRequest>;

export const TransitionOffenceRequest = z
  .object({
    to: z.enum(OFFENCE_STATES),
    note: z.string().trim().max(4000).optional(),
    fix: z.string().trim().max(4000).optional(),
  })
  .strict();
export type TransitionOffenceRequest = z.infer<typeof TransitionOffenceRequest>;

export const ProposeLessonRequest = z
  .object({
    classId: z.string().min(1).max(64).optional(),
    scopeType: z.enum(LESSON_SCOPE_TYPES),
    scopeValue: z.string().trim().min(1).max(200),
    rule: z.string().trim().min(3).max(2000),
    fix: z.string().trim().min(3).max(4000),
    rationale: z.string().trim().min(3).max(4000),
  })
  .strict();
export type ProposeLessonRequest = z.infer<typeof ProposeLessonRequest>;
