/** Pure domain rules for error learning (§11): offence lifecycle, model-as-a-dimension verdicts, lesson payoff and retirement. */
import { MODEL_TIERS, type ModelTier, type ModelVerdict, type OffenceState } from '@aoc/contracts';

// ── repeat-offence lifecycle ────────────────────────────────────────────────
/**
 * Transitions a human may make. detected/reopened are raised by the system when a class repeats;
 * verified_closed only comes from the daily job after a full window without recurrence.
 */
const HUMAN_TRANSITIONS: Record<OffenceState, readonly OffenceState[]> = {
  detected: ['root_caused'],
  reopened: ['root_caused', 'fix_applied'],
  root_caused: ['fix_applied'],
  fix_applied: [],
  verified_closed: [],
};

export function humanTransitionAllowed(from: OffenceState, to: OffenceState): boolean {
  return HUMAN_TRANSITIONS[from].includes(to);
}

/** A recurrence after a fix reopens the offence (during the verification window or after it closed). */
export function reopensOn(state: OffenceState): boolean {
  return state === 'fix_applied' || state === 'verified_closed';
}

/** Class occurrences needed before it is a repeat offence; below this an error is transient noise. */
export const REPEAT_THRESHOLD = 2;

// ── model as a tested root-cause dimension ─────────────────────────────────
/** Cheap → strong, ordered by list price (config/rate-card.json). */
export const TIER_STRENGTH: Record<ModelTier, number> = { haiku: 1, sonnet: 2, opus: 3, fable: 4 };

export interface TierCell {
  runs: number;
  occurrences: number;
}

export interface ProcessVerdict {
  verdict: ModelVerdict;
  cheaperTier: ModelTier | null;
  strongerTier: ModelTier | null;
  recommendation: string | null;
}

export const VERDICT_SUMMARY: Record<ModelVerdict, string> = {
  model_capability: 'model capability: recurs on the cheaper tier only',
  spec_context_tooling: 'spec/context/tooling, not the model',
  inconclusive: 'inconclusive: not enough runs on both tiers to test the model',
};

export function upgradeRecommendation(processType: string, from: ModelTier, to: ModelTier): string {
  return `targeted per-process-type upgrade for ${processType} (${from} → ${to})`;
}

/**
 * Verdict for one process type. It is only "model capability" when the class recurs on a cheaper tier but
 * never on a stronger one, with at least `minRuns` runs on both; if it shows up on both tiers the cause is
 * spec, context or tooling. Anything else is inconclusive.
 */
export function processVerdict(
  processType: string,
  cells: Partial<Record<ModelTier, TierCell>>,
  minRuns: number,
): ProcessVerdict {
  const tiers = MODEL_TIERS.filter((t) => cells[t]).sort((a, b) => TIER_STRENGTH[a] - TIER_STRENGTH[b]);
  const cell = (t: ModelTier) => cells[t] ?? { runs: 0, occurrences: 0 };
  for (let i = 0; i < tiers.length; i++) {
    for (let j = i + 1; j < tiers.length; j++) {
      if (cell(tiers[i]!).occurrences > 0 && cell(tiers[j]!).occurrences > 0) {
        return {
          verdict: 'spec_context_tooling',
          cheaperTier: tiers[i]!,
          strongerTier: tiers[j]!,
          recommendation: null,
        };
      }
    }
  }
  for (let i = 0; i < tiers.length; i++) {
    const cheap = cell(tiers[i]!);
    if (cheap.occurrences < REPEAT_THRESHOLD || cheap.runs < minRuns) continue;
    for (let j = i + 1; j < tiers.length; j++) {
      const strong = cell(tiers[j]!);
      if (strong.occurrences === 0 && strong.runs >= minRuns) {
        return {
          verdict: 'model_capability',
          cheaperTier: tiers[i]!,
          strongerTier: tiers[j]!,
          recommendation: upgradeRecommendation(processType, tiers[i]!, tiers[j]!),
        };
      }
    }
  }
  return { verdict: 'inconclusive', cheaperTier: null, strongerTier: null, recommendation: null };
}

/** Class-level verdict: any evidence that a stronger tier also hits the cause rules the model out. */
export function classVerdict(perProcess: ProcessVerdict[]): ModelVerdict {
  if (perProcess.some((p) => p.verdict === 'spec_context_tooling')) return 'spec_context_tooling';
  if (perProcess.some((p) => p.verdict === 'model_capability')) return 'model_capability';
  return 'inconclusive';
}

// ── lessons ────────────────────────────────────────────────────────────────
export interface PayoffInput {
  exposuresBefore: number;
  occurrencesBefore: number;
  exposuresAfter: number;
  recurrencesAfter: number;
  avgCostUsd: number;
  avgCostMs: number;
  avgTokens: number;
}

export interface PayoffResult {
  baselineRatePerExposure: number;
  expectedRecurrences: number;
  repeatsPrevented: number;
  usdSaved: number;
  msSaved: number;
  tokensSaved: number;
}

/** repeats prevented = baseline rate per exposure before binding × exposures after − actual recurrences after (may be negative). */
export function lessonPayoff(i: PayoffInput): PayoffResult {
  const rate = i.exposuresBefore > 0 ? i.occurrencesBefore / i.exposuresBefore : 0;
  const expected = rate * i.exposuresAfter;
  const prevented = expected - i.recurrencesAfter;
  return {
    baselineRatePerExposure: rate,
    expectedRecurrences: expected,
    repeatsPrevented: prevented,
    usdSaved: prevented * i.avgCostUsd,
    msSaved: prevented * i.avgCostMs,
    tokensSaved: prevented * i.avgTokens,
  };
}

export type RunUse = 'used' | 'unused' | 'pending';

/** Consecutive applied-but-unused runs counting back from the most recent settled run (pending runs are skipped). */
export function unusedStreak(runsOldestFirst: RunUse[]): number {
  let streak = 0;
  for (let i = runsOldestFirst.length - 1; i >= 0; i--) {
    const r = runsOldestFirst[i];
    if (r === 'pending') continue;
    if (r === 'used') break;
    streak++;
  }
  return streak;
}
