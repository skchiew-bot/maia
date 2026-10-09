/**
 * Registry economics — the distillation business case behind the Registry hero (§12). Pure.
 *
 * A run is a DISCOVERY run when its type is discovery-class or no approved playbook was active when it
 * was launched; otherwise it is an EXECUTION run. Only finished runs (rollover chains counted once)
 * enter the averages: a running session's cost is still growing.
 */
import type {
  ModelTier,
  ProcessType,
  RegistryEntry,
  RegistryPlaybookStatus,
  RegistryTrendPoint,
  RunCostSplit,
  RunKind,
} from '@aoc/contracts';
import { addDays, localDate, weekdayOf } from '@aoc/kernel';
import { priceRatio, type TokenRate } from './costs';
import type { ApprovalInterval } from './projections';

export interface CostedRun {
  rootSessionId: string;
  processType: string;
  launchedAtMs: number;
  launchSeq: number;
  finished: boolean;
  outcome: string | null;
  costUsd: number;
  costBasis: 'metered' | 'estimated';
}

export interface EconomicsInput {
  types: readonly ProcessType[];
  runs: readonly CostedRun[];
  approvals: readonly ApprovalInterval[];
  playbookStatus(processType: string): RegistryPlaybookStatus;
  currentModel(t: ProcessType): ModelTier;
  lessonsInScope(processType: string): number | null;
  rates: Record<ModelTier, TokenRate>;
  nowMs: number;
  timezone: string;
  weeks: number;
}

export function runKind(t: ProcessType, launchSeq: number, approvals: readonly ApprovalInterval[]): RunKind {
  if (t.class === 'discovery') return 'discovery';
  const active = approvals.some(
    (a) =>
      a.processType === t.id &&
      a.approvedSeq < launchSeq &&
      (a.retiredSeq === null || a.retiredSeq > launchSeq),
  );
  return active ? 'execution' : 'discovery';
}

/** Mondays (local timezone) of the last `weeks` weeks, oldest first; the current week last. */
export function weekStarts(nowMs: number, timezone: string, weeks: number): string[] {
  const current = mondayOf(localDate(nowMs, timezone));
  return Array.from({ length: weeks }, (_, i) => addDays(current, -7 * (weeks - 1 - i)));
}

function mondayOf(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

const round = (n: number, dp: number) => Math.round(n * 10 ** dp) / 10 ** dp;
const usd = (n: number) => round(n, 4);

function split(runs: CostedRun[]): RunCostSplit {
  const total = runs.reduce((a, r) => a + r.costUsd, 0);
  return {
    runs: runs.length,
    completedRuns: runs.filter((r) => r.outcome === 'completed').length,
    avgCostUsd: runs.length ? usd(total / runs.length) : null,
    totalCostUsd: usd(total),
  };
}

export function computeRegistryEntries(input: EconomicsInput): RegistryEntry[] {
  const weeks = weekStarts(input.nowMs, input.timezone, input.weeks);
  const entries = input.types.map<RegistryEntry>((t) => {
    const runs = input.runs.filter((r) => r.processType === t.id);
    const finished = runs.filter((r) => r.finished);
    const kinds = new Map(finished.map((r) => [r.rootSessionId, runKind(t, r.launchSeq, input.approvals)]));
    const discovery = split(finished.filter((r) => kinds.get(r.rootSessionId) === 'discovery'));
    const execution = split(finished.filter((r) => kinds.get(r.rootSessionId) === 'execution'));

    const both = discovery.avgCostUsd !== null && execution.avgCostUsd !== null;
    const savingsPct =
      both && discovery.avgCostUsd! > 0
        ? round(((discovery.avgCostUsd! - execution.avgCostUsd!) / discovery.avgCostUsd!) * 100, 1)
        : null;
    const realizedSavingsUsd = both
      ? usd(execution.runs * (discovery.avgCostUsd! - execution.avgCostUsd!))
      : null;

    // Trend: average cost per finished run, bucketed by the (local) week the run was launched.
    const buckets = weeks.map(() => ({ runs: 0, discovery: 0, execution: 0, cost: 0 }));
    let windowRuns = 0;
    for (const r of finished) {
      const i = weeks.indexOf(mondayOf(localDate(r.launchedAtMs, input.timezone)));
      if (i < 0) continue;
      windowRuns++;
      const b = buckets[i]!;
      b.runs++;
      b.cost += r.costUsd;
      if (kinds.get(r.rootSessionId) === 'execution') b.execution++;
      else b.discovery++;
    }
    const trend = weeks.map<RegistryTrendPoint>((weekStart, i) => {
      const b = buckets[i]!;
      return {
        weekStart,
        runs: b.runs,
        discoveryRuns: b.discovery,
        executionRuns: b.execution,
        avgCostUsd: b.runs ? usd(b.cost / b.runs) : null,
      };
    });

    // Opportunity: what a playbook is worth for this type at its recent volume.
    let basis: RegistryEntry['opportunity']['basis'] = 'none';
    let execRef: number | null = null;
    if (execution.avgCostUsd !== null) {
      basis = 'measured';
      execRef = execution.avgCostUsd;
    } else if (
      t.class !== 'discovery' &&
      t.executionModel &&
      t.executionModel !== t.model &&
      discovery.avgCostUsd !== null
    ) {
      const ratio = priceRatio(input.rates, t.model, t.executionModel);
      if (ratio !== null) {
        basis = 'projected';
        execRef = usd(discovery.avgCostUsd * ratio);
      }
    }
    const opportunityUsd =
      execRef !== null && discovery.avgCostUsd !== null
        ? usd(Math.max(0, discovery.avgCostUsd - execRef) * windowRuns)
        : 0;

    const bases = new Set(finished.map((r) => r.costBasis));
    return {
      processType: t.id,
      name: t.name,
      description: t.description,
      class: t.class,
      model: t.model,
      executionModel: t.executionModel,
      currentModel: input.currentModel(t),
      readOnly: t.readOnly,
      risky: t.risky,
      discovery,
      execution,
      activeRuns: runs.length - finished.length,
      savingsPct,
      realizedSavingsUsd,
      opportunity: { usd: opportunityUsd, basis, windowRuns, executionCostUsd: execRef },
      trend,
      playbook: input.playbookStatus(t.id),
      lessonsInScope: input.lessonsInScope(t.id),
      openRepeatOffences: null,
      costBasis: bases.size === 0 ? 'none' : bases.size > 1 ? 'mixed' : [...bases][0]!,
    };
  });
  const spend = (e: RegistryEntry) => e.discovery.totalCostUsd + e.execution.totalCostUsd;
  return entries.sort(
    (a, b) =>
      b.opportunity.usd - a.opportunity.usd ||
      spend(b) - spend(a) ||
      a.processType.localeCompare(b.processType),
  );
}
