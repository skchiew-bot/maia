/**
 * Pure view-model rules for the Registry (§12 hero, §10 routing, §11 model dimension). Everything here maps
 * daemon DTOs to what the page draws; nothing reads the clock or the network.
 */
import type {
  ModelDimensionReportDTO,
  ProcessTypeView,
  RegistryEntry,
  RegistryRunDTO,
  RegistryTrendPoint,
} from '@aoc/contracts';

const MODEL_LABEL: Record<string, string> = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' };

/** "opus" → "Opus"; model ids ("claude-sonnet-5-5") resolve to their tier. */
export function modelLabel(model: string | null | undefined): string {
  if (!model) return '—';
  const m = model.toLowerCase();
  for (const [tier, label] of Object.entries(MODEL_LABEL)) if (m === tier || m.includes(tier)) return label;
  return model;
}

/** ISO-8601 week number of a calendar day (`YYYY-MM-DD`). */
export function isoWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

export const weekLabel = (weekStart: string): string => `W${isoWeek(weekStart)}`;

/** Calendar day `YYYY-MM-DD` shifted by `days`. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export interface TrendPointView {
  weekStart: string;
  label: string;
  value: number | null;
  runs: number;
  discoveryRuns: number;
  executionRuns: number;
  /** Runs counted at US$0 because no rate card priced them: the week's average is understated. */
  unpricedRuns: number;
}

export interface TrendView {
  points: TrendPointView[];
  /** First fully priced week with a non-zero cost — the baseline for `change`. */
  first: { index: number; value: number } | null;
  /** Latest week with runs. */
  last: { index: number; value: number } | null;
  /** last ÷ first − 1, when a later week than the baseline has runs. */
  change: number | null;
  weeksWithRuns: number;
  /** Weeks whose average includes unpriced runs. */
  partlyUnpricedWeeks: number;
}

/**
 * Weekly blended cost per run; weeks without finished runs stay gaps (never drawn as zero). The change is
 * measured from the first fully priced week: a week holding unpriced (US$0) runs is not a baseline.
 */
export function trendView(trend: readonly RegistryTrendPoint[]): TrendView {
  const points = trend.map((p) => ({
    weekStart: p.weekStart,
    label: weekLabel(p.weekStart),
    value: p.runs > 0 ? p.avgCostUsd : null,
    runs: p.runs,
    discoveryRuns: p.discoveryRuns,
    executionRuns: p.executionRuns,
    unpricedRuns: p.unpricedRuns ?? 0,
  }));
  const withRuns = points.flatMap((p, index) =>
    p.value === null ? [] : [{ index, value: p.value, priced: p.unpricedRuns === 0 }],
  );
  const base = withRuns.find((p) => p.priced && p.value > 0);
  const tail = withRuns[withRuns.length - 1];
  const first = base ? { index: base.index, value: base.value } : null;
  const last = tail ? { index: tail.index, value: tail.value } : null;
  const change = first && last && last.index > first.index ? last.value / first.value - 1 : null;
  return {
    points,
    first,
    last,
    change,
    weeksWithRuns: withRuns.length,
    partlyUnpricedWeeks: points.filter((p) => p.unpricedRuns > 0).length,
  };
}

/** What a distilled execution run costs: measured once execution runs exist, else projected from rates. */
export interface ExecutionCost {
  usd: number | null;
  basis: 'measured' | 'projected' | 'none';
  model: string | null;
}

export function executionCost(e: RegistryEntry): ExecutionCost {
  if (e.execution.avgCostUsd !== null)
    return { usd: e.execution.avgCostUsd, basis: 'measured', model: e.executionModel };
  if (e.opportunity.basis === 'projected')
    return { usd: e.opportunity.executionCostUsd, basis: 'projected', model: e.executionModel };
  return { usd: null, basis: 'none', model: null };
}

/** (discovery − execution) ÷ discovery per run; negative when execution costs more. */
export function savingRatio(e: RegistryEntry): number | null {
  const d = e.discovery.avgCostUsd;
  const x = executionCost(e).usd;
  if (d === null || x === null || d <= 0) return null;
  return (d - x) / d;
}

/**
 * `distillable`: has (or projects) a cheaper execution path. `discovery_only`: runs but no execution path by
 * design (discovery-class, or no execution model). `idle`: no finished run yet.
 */
export type HeroRowKind = 'distillable' | 'discovery_only' | 'idle';

export function heroRowKind(e: RegistryEntry): HeroRowKind {
  if (e.discovery.runs + e.execution.runs === 0) return 'idle';
  return executionCost(e).basis === 'none' ? 'discovery_only' : 'distillable';
}

export interface HeroSummary {
  realizedUsd: number;
  /** null when any contributing type could not be converted (a day without a BNM rate). */
  realizedRm: number | null;
  executionRuns: number;
  opportunityUsd: number;
  opportunityRm: number | null;
  opportunityRuns: number;
  opportunityTypes: number;
  /** Runs-weighted (discovery − execution) ÷ discovery across types with an execution path. */
  weightedSaving: number | null;
  savingBasis: 'measured' | 'projected' | 'mixed' | null;
  tokensSaved: number | null;
  timeSavedMs: number | null;
}

export function heroSummary(entries: readonly RegistryEntry[]): HeroSummary {
  let realizedUsd = 0;
  let realizedRm: number | null = 0;
  let executionRuns = 0;
  let opportunityUsd = 0;
  let opportunityRm: number | null = 0;
  let opportunityRuns = 0;
  let opportunityTypes = 0;
  let weightedNum = 0;
  let weightedDen = 0;
  let tokensSaved: number | null = null;
  let timeSavedMs: number | null = null;
  const bases = new Set<'measured' | 'projected'>();
  for (const e of entries) {
    executionRuns += e.execution.runs;
    if (e.realizedSavingsUsd !== null) {
      realizedUsd += e.realizedSavingsUsd;
      realizedRm = realizedRm === null || e.savings.realizedRm === null ? null : realizedRm + e.savings.realizedRm;
    }
    if (e.savings.tokensSaved !== null) tokensSaved = (tokensSaved ?? 0) + e.savings.tokensSaved;
    if (e.savings.timeSavedMs !== null) timeSavedMs = (timeSavedMs ?? 0) + e.savings.timeSavedMs;
    const exec = executionCost(e);
    if (exec.basis === 'none' || exec.usd === null || e.discovery.avgCostUsd === null) continue;
    opportunityTypes += 1;
    bases.add(exec.basis);
    opportunityUsd += e.opportunity.usd;
    opportunityRuns += e.opportunity.windowRuns;
    if (e.opportunity.usd > 0)
      opportunityRm =
        opportunityRm === null || e.savings.opportunityRm === null ? null : opportunityRm + e.savings.opportunityRm;
    const w = e.opportunity.windowRuns;
    weightedNum += (e.discovery.avgCostUsd - exec.usd) * w;
    weightedDen += e.discovery.avgCostUsd * w;
  }
  return {
    realizedUsd,
    realizedRm,
    executionRuns,
    opportunityUsd,
    opportunityRm,
    opportunityRuns,
    opportunityTypes,
    weightedSaving: weightedDen > 0 ? weightedNum / weightedDen : null,
    savingBasis: bases.size === 0 ? null : bases.size > 1 ? 'mixed' : [...bases][0]!,
    tokensSaved,
    timeSavedMs,
  };
}

/** A round axis maximum (1, 2, 2.5 or 5 × 10ⁿ) at or above `max`, with 3–6 ticks. */
export function niceScale(max: number): { max: number; ticks: number[] } {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] };
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  const step = [0.2, 0.25, 0.5, 1, 2, 2.5, 5].map((s) => s * base).find((s) => max / s <= 5) ?? 10 * base;
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { max: top, ticks };
}

/** Cost-per-run money with enough precision for sub-cent execution runs. */
export function formatRunCost(usd: number): string {
  const a = Math.abs(usd);
  const dp = a === 0 || a >= 0.1 ? 2 : a >= 0.01 ? 3 : 4;
  return `${usd < 0 ? '−' : ''}US$${a.toFixed(dp)}`;
}

/** §11 model dimension, summarised for one process type. */
export interface ModelSignal {
  /** Root-cause classes that recurred in this process type. */
  recurring: number;
  /** Classes tested as model capability (recurs on the cheap tier only), with their targeted recommendation. */
  modelCapability: { className: string; recommendation: string | null; cheaperTier: string | null }[];
  /** Classes that recur on both tiers: spec, context or tooling, not the model. */
  specContextTooling: number;
  /** Not enough runs on both tiers to test the model. */
  inconclusive: number;
}

export function modelSignal(report: ModelDimensionReportDTO | undefined, processType: string): ModelSignal {
  const out: ModelSignal = { recurring: 0, modelCapability: [], specContextTooling: 0, inconclusive: 0 };
  for (const c of report?.classes ?? []) {
    const p = c.byProcessType.find((x) => x.processType === processType);
    if (!p || !p.tiers.some((t) => t.occurrences > 0)) continue;
    out.recurring += 1;
    if (p.verdict === 'model_capability')
      out.modelCapability.push({ className: c.name, recommendation: p.recommendation, cheaperTier: p.cheaperTier });
    else if (p.verdict === 'spec_context_tooling') out.specContextTooling += 1;
    else out.inconclusive += 1;
  }
  return out;
}

/** Plain-language routing for one type: what it launches on now and why (budget never enters into it). */
export function routingReason(t: ProcessTypeView, activeVersion: number | null): string {
  if (t.class === 'discovery') return 'discovery-class: always the discovery model';
  if (!t.executionModel || t.executionModel === t.model) return 'single model for this type';
  return t.activePlaybookId
    ? `playbook${activeVersion !== null ? ` v${activeVersion}` : ''} approved`
    : 'no approved playbook yet';
}

/** Runs counted at US$0 although tokens were used: no rate card priced them (see Metering). */
export function unpricedRuns(runs: readonly RegistryRunDTO[]): RegistryRunDTO[] {
  return runs.filter((r) => r.finished && r.costUsd === 0 && r.tokens > 0);
}

/** Completed runs a playbook could be distilled from (not already the source of a live proposal). */
export function distillCandidates(runs: readonly RegistryRunDTO[]): RegistryRunDTO[] {
  return runs.filter((r) => r.finished && r.outcome === 'completed' && r.playbookId === null);
}
