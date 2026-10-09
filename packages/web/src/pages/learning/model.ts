/**
 * Pure view-model rules for the Learning page (§11). Everything here works on root-cause classes, process
 * types, model tiers and code areas — the learning API never returns people, and nothing here ranks them (R11).
 */
import type {
  ErrorOccurrenceDTO,
  ErrorSource,
  ModelTier,
  ModelVerdict,
  OffenceDTO,
  OffenceState,
  RecurrenceTrendDTO,
  RootCauseClassDTO,
  RootCauseDimension,
} from '@aoc/contracts';
import type { FunnelStage, RecurrenceClass, RecurrenceStage } from '../../charts';
import type { IconName, Tone } from '../../components';
import { formatShortDate, formatUsd } from '../../lib/format';

/** Dimensions in the order the picker offers them. Mirrors ROOT_CAUSE_DIMENSIONS in @aoc/contracts. */
export const DIMENSIONS: readonly RootCauseDimension[] = [
  'spec',
  'context',
  'tooling',
  'codebase',
  'guardrail',
  'model_capability',
  'environment',
  'unknown',
];

/**
 * `outward` = the cause sits outside the agent (spec, codebase, guardrail …). §11: root cause often should
 * point outward — the agent is frequently the symptom.
 */
export const DIMENSION_META: Record<RootCauseDimension, { label: string; hint: string; outward: boolean }> = {
  spec: { label: 'Spec', hint: 'Ambiguous or missing acceptance criteria', outward: true },
  context: { label: 'Context', hint: 'The session lacked context it needed', outward: true },
  tooling: { label: 'Tooling', hint: 'A tool, script or helper misbehaves', outward: true },
  codebase: { label: 'Codebase', hint: 'Confusing or fragile code', outward: true },
  guardrail: { label: 'Guardrail', hint: 'A missing check, test or policy', outward: true },
  model_capability: {
    label: 'Model capability',
    hint: 'Only when it recurs on the cheaper model but not the stronger one (see the model test)',
    outward: false,
  },
  environment: { label: 'Environment', hint: 'Infrastructure or a service outside the repo', outward: true },
  unknown: { label: 'Not yet known', hint: 'Root cause still to be determined', outward: false },
};

export const STATE_META: Record<OffenceState, { label: string; tone: Tone; icon: IconName }> = {
  detected: { label: 'Detected', tone: 'warn', icon: 'warn' },
  root_caused: { label: 'Root-caused', tone: 'neutral', icon: 'search' },
  fix_applied: { label: 'Fix applied', tone: 'info', icon: 'clock' },
  verified_closed: { label: 'Verified closed', tone: 'ok', icon: 'ok' },
  reopened: { label: 'Reopened', tone: 'danger', icon: 'retry' },
};

/** The four lifecycle steps of §11, in order. `reopened` is a return to the start, not a fifth step. */
export const LIFECYCLE: readonly RecurrenceStage[] = [
  'detected',
  'root_caused',
  'fix_applied',
  'verified_closed',
];

/** Position on the four-step lifecycle (0-based). A reopened offence is back at detection. */
export function stageIndex(state: OffenceState): number {
  return state === 'reopened' ? 0 : LIFECYCLE.indexOf(state);
}

export type HumanStep = 'root_caused' | 'fix_applied';

/**
 * Moves a person may make, mirroring mod-learning's rules: the system raises detected/reopened, and only the
 * daily job closes an offence (a full verification window without recurrence).
 */
export function nextSteps(state: OffenceState): HumanStep[] {
  switch (state) {
    case 'detected':
      return ['root_caused'];
    case 'root_caused':
      return ['fix_applied'];
    case 'reopened':
      return ['fix_applied', 'root_caused'];
    default:
      return [];
  }
}

export const STEP_ACTION: Record<HumanStep, string> = {
  root_caused: 'Mark root-caused',
  fix_applied: 'Record fix',
};

export function isOpen(state: OffenceState): boolean {
  return state !== 'verified_closed';
}

/** Open offences first (a human can still act), each group by cost of recurrence — never by count (§11). */
export function prioritise(offences: readonly OffenceDTO[]): OffenceDTO[] {
  return [...offences].sort(
    (a, b) =>
      Number(isOpen(b.state)) - Number(isOpen(a.state)) ||
      b.costOfRecurrenceUsd - a.costOfRecurrenceUsd ||
      b.costMs - a.costMs ||
      a.className.localeCompare(b.className),
  );
}

export interface LearningSummary {
  open: number;
  closed: number;
  byState: Record<OffenceState, number>;
  /** Σ over open offences: what keeps recurring costs. */
  openCostUsd: number;
  openCostMs: number;
  openCostTokens: number;
  openOccurrences: number;
  /** Open offences a person must move on (detected or reopened). */
  needsRootCause: number;
}

export function summarise(offences: readonly OffenceDTO[]): LearningSummary {
  const byState: Record<OffenceState, number> = {
    detected: 0,
    root_caused: 0,
    fix_applied: 0,
    verified_closed: 0,
    reopened: 0,
  };
  const s: LearningSummary = {
    open: 0,
    closed: 0,
    byState,
    openCostUsd: 0,
    openCostMs: 0,
    openCostTokens: 0,
    openOccurrences: 0,
    needsRootCause: 0,
  };
  for (const o of offences) {
    byState[o.state] += 1;
    if (!isOpen(o.state)) {
      s.closed += 1;
      continue;
    }
    s.open += 1;
    s.openCostUsd += o.costOfRecurrenceUsd;
    s.openCostMs += o.costMs;
    s.openCostTokens += o.costTokens;
    s.openOccurrences += o.occurrences;
    if (o.state === 'detected' || o.state === 'reopened') s.needsRootCause += 1;
  }
  return s;
}

function median(sorted: readonly number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Offences per lifecycle step with how long they have waited in it (since their last transition), for the
 * pipeline view. Reopened offences wait at detection again. Verified closed is terminal: it only accumulates.
 */
export function lifecycleStages(offences: readonly OffenceDTO[], now: number): FunnelStage[] {
  const ages = new Map<RecurrenceStage, number[]>(LIFECYCLE.map((s) => [s, []]));
  for (const o of offences) {
    const stage = LIFECYCLE[stageIndex(o.state)]!;
    ages.get(stage)!.push(Math.max(0, now - Date.parse(o.lastTransitionAt)));
  }
  return LIFECYCLE.map((stage) => {
    const list = [...ages.get(stage)!].sort((a, b) => a - b);
    const terminal = stage === 'verified_closed';
    return {
      id: stage,
      label: STATE_META[stage].label,
      count: list.length,
      terminal,
      ...(terminal || list.length === 0
        ? {}
        : { oldestAgeMs: list[list.length - 1]!, medianAgeMs: median(list) }),
    };
  });
}

/** Average notional cost of one occurrence of an offence's class. */
export function perOccurrenceUsd(o: Pick<OffenceDTO, 'costOfRecurrenceUsd' | 'occurrences'>): number {
  return o.occurrences > 0 ? o.costOfRecurrenceUsd / o.occurrences : 0;
}

function trendStage(state: OffenceState | null | undefined): RecurrenceStage | undefined {
  return state && state !== 'reopened' ? state : undefined;
}

/**
 * Facets for the recurrence trend: one per tracked repeat class in priority order (cost of recurrence, not
 * count), including classes with no occurrence in the window (a verified-closed class shows a flat zero).
 * Classes the trend counts but that have no offence yet follow, by count.
 */
export function trendFacets(
  trend: RecurrenceTrendDTO,
  offences: readonly OffenceDTO[],
): RecurrenceClass[] {
  const weekLabels = trend.weeks.map((w) => formatShortDate(w));
  const zeros = trend.weeks.map(() => 0);
  const counted = new Map(trend.classes.map((c) => [c.classId, c]));
  const facet = (
    id: string,
    label: string,
    counts: readonly number[],
    state: OffenceState | null,
    note: string | undefined,
  ): RecurrenceClass => ({
    id,
    label,
    weeks: weekLabels.map((week, i) => ({ week, count: counts[i] ?? 0 })),
    stage: trendStage(state),
    note,
  });
  const out = prioritise(offences).map((o) => {
    const reopened = o.state === 'reopened' ? `Reopened ×${Math.max(1, o.reopenCount)} · ` : '';
    return facet(
      o.classId,
      o.className,
      counted.get(o.classId)?.counts ?? zeros,
      o.state,
      `${reopened}${formatUsd(o.costOfRecurrenceUsd)} notional`,
    );
  });
  const tracked = new Set(offences.map((o) => o.classId));
  const untracked = trend.classes
    .filter((c) => !tracked.has(c.classId))
    .sort((a, b) => b.total - a.total)
    .map((c) => facet(c.classId, c.name, c.counts, c.offenceState, undefined));
  return [...out, ...untracked];
}

export interface DimensionShare {
  dimension: RootCauseDimension;
  label: string;
  hint: string;
  outward: boolean;
  classes: number;
  occurrences: number;
  costUsd: number;
}

/** Cost of recurrence by root-cause dimension (classes with at least one occurrence), costliest first. */
export function dimensionShares(classes: readonly RootCauseClassDTO[]): DimensionShare[] {
  const by = new Map<RootCauseDimension, DimensionShare>();
  for (const c of classes) {
    if (c.occurrences === 0) continue;
    const meta = DIMENSION_META[c.dimension];
    const cur = by.get(c.dimension) ?? {
      dimension: c.dimension,
      label: meta.label,
      hint: meta.hint,
      outward: meta.outward,
      classes: 0,
      occurrences: 0,
      costUsd: 0,
    };
    cur.classes += 1;
    cur.occurrences += c.occurrences;
    cur.costUsd += c.costOfRecurrenceUsd;
    by.set(c.dimension, cur);
  }
  return [...by.values()].sort(
    (a, b) => b.costUsd - a.costUsd || b.occurrences - a.occurrences || a.label.localeCompare(b.label),
  );
}

/** How many classes with a known dimension point outward (not at the model). */
export function outwardCount(shares: readonly DimensionShare[]): { outward: number; known: number } {
  let outward = 0;
  let known = 0;
  for (const s of shares) {
    if (s.dimension === 'unknown') continue;
    known += s.classes;
    if (s.outward) outward += s.classes;
  }
  return { outward, known };
}

export interface SignatureGroup {
  signature: string;
  /** Normalised message (numbers, ids and paths stripped), or the newest raw message when erased. */
  text: string;
  count: number;
  highPriority: number;
  sources: ErrorSource[];
  processTypes: string[];
  tiers: (ModelTier | 'unknown')[];
  codeAreas: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  /** Newest occurrence: assigning it moves every same-signature occurrence (rule assignment). */
  latestErrorId: string;
  weightedUsd: number;
  ms: number;
}

const uniq = <T>(xs: Iterable<T>): T[] => [...new Set(xs)];

/**
 * Unassigned occurrences grouped by signature (same normalised message). Groups with two or more are
 * repeats waiting for a root cause; single ones are transient — logged, never lessons (§11).
 */
export function signatureGroups(errors: readonly ErrorOccurrenceDTO[]): SignatureGroup[] {
  const groups = new Map<string, ErrorOccurrenceDTO[]>();
  for (const e of errors) {
    if (e.classId !== null) continue;
    const list = groups.get(e.signature);
    if (list) list.push(e);
    else groups.set(e.signature, [e]);
  }
  return [...groups.entries()]
    .map(([signature, list]): SignatureGroup => {
      const newestFirst = [...list].sort((a, b) => b.observedAt.localeCompare(a.observedAt));
      const newest = newestFirst[0]!;
      const oldest = newestFirst[newestFirst.length - 1]!;
      return {
        signature,
        text: newestFirst.find((e) => e.template)?.template ?? newest.message,
        count: list.length,
        highPriority: list.filter((e) => e.priority === 'high').length,
        sources: uniq(list.map((e) => e.source)),
        processTypes: uniq(list.map((e) => e.processType).filter((p): p is string => p !== null)).sort(),
        tiers: uniq(list.map((e) => e.modelTier).filter((t): t is ModelTier | 'unknown' => t !== null)),
        codeAreas: uniq(list.map((e) => e.codeArea).filter((a): a is string => a !== null)).sort(),
        firstSeenAt: oldest.observedAt,
        lastSeenAt: newest.observedAt,
        latestErrorId: newest.errorId,
        weightedUsd: list.reduce((s, e) => s + e.cost.weightedUsd, 0),
        ms: list.reduce((s, e) => s + e.cost.ms, 0),
      };
    })
    .sort(
      (a, b) =>
        b.weightedUsd - a.weightedUsd || b.count - a.count || b.lastSeenAt.localeCompare(a.lastSeenAt),
    );
}

export function repeatingGroups(groups: readonly SignatureGroup[]): SignatureGroup[] {
  return groups.filter((g) => g.count >= 2);
}

export const SOURCE_LABEL: Record<ErrorSource, string> = {
  tool: 'Tool call',
  test: 'Test',
  uat: 'UAT',
  rollback: 'Rollback',
  hook: 'Hook',
  agent_report: 'Agent report',
  ci: 'CI',
};

export const TIER_LABEL: Record<ModelTier | 'unknown', string> = {
  haiku: 'Haiku',
  sonnet: 'Sonnet',
  opus: 'Opus',
  fable: 'Fable',
  unknown: 'Unknown model',
};

/**
 * Wording for the model dimension. Only `model_capability` names the model as the cause, and only when the
 * class recurs on the cheaper tier but not the stronger one (§11); anything seen on both tiers is spec,
 * context or tooling.
 */
export const VERDICT_META: Record<ModelVerdict, { label: string; tone: Tone; icon: IconName }> = {
  model_capability: { label: 'Model capability', tone: 'info', icon: 'info' },
  spec_context_tooling: { label: 'Not the model', tone: 'neutral', icon: 'check' },
  inconclusive: { label: 'Model untested', tone: 'neutral', icon: 'minus' },
};

export function verdictDetail(verdict: ModelVerdict, minRunsPerTier: number): string {
  switch (verdict) {
    case 'model_capability':
      return 'Recurs on the cheaper tier only, with enough runs on both.';
    case 'spec_context_tooling':
      return 'Also recurs on a stronger tier, so the cause is spec, context or tooling.';
    default:
      return `Needs at least ${minRunsPerTier} runs on a cheaper and a stronger tier to test the model.`;
  }
}

/** True for learning events that change what this page shows. */
export function isLearningEvent(type: string): boolean {
  return (
    type.startsWith('error.') ||
    type.startsWith('rootcause.') ||
    type.startsWith('offence.') ||
    type.startsWith('lesson.')
  );
}
