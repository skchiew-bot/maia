import { describe, expect, it } from 'vitest';
import type { ModelDimensionReportDTO } from '@aoc/contracts';
import {
  distillCandidates,
  executionCost,
  formatRunCost,
  heroRowKind,
  heroSummary,
  isoWeek,
  modelLabel,
  modelSignal,
  niceScale,
  routingReason,
  savingRatio,
  trendView,
  unpricedRuns,
  weekLabel,
} from '../../src/pages/registry/registryModel';
import { ENTRIES, RUNS, TYPES, entry, processType, trend } from './fixtures';

const [featureBuild, bugFix, discoveryType, migration] = ENTRIES as [
  (typeof ENTRIES)[number],
  (typeof ENTRIES)[number],
  (typeof ENTRIES)[number],
  (typeof ENTRIES)[number],
];

describe('labels', () => {
  it('resolves model ids to their tier and leaves unknown ids as they are', () => {
    expect(modelLabel('claude-sonnet-5-5')).toBe('Sonnet');
    expect(modelLabel('opus')).toBe('Opus');
    expect(modelLabel(null)).toBe('—');
    expect(modelLabel('local-model')).toBe('local-model');
  });

  it('numbers weeks the ISO way, across the year boundary', () => {
    expect(isoWeek('2026-08-17')).toBe(34);
    expect(weekLabel('2026-10-05')).toBe('W41');
    expect(isoWeek('2025-12-29')).toBe(1);
    expect(isoWeek('2027-01-01')).toBe(53);
  });

  it('prints sub-cent run costs with enough precision', () => {
    expect(formatRunCost(1.3885)).toBe('US$1.39');
    expect(formatRunCost(0.069)).toBe('US$0.069');
    expect(formatRunCost(0.0042)).toBe('US$0.0042');
    expect(formatRunCost(0)).toBe('US$0.00');
    expect(formatRunCost(-0.5)).toBe('−US$0.50');
  });
});

describe('trendView', () => {
  it('keeps weeks without runs as gaps and never takes a partly unpriced week as the baseline', () => {
    const view = trendView(featureBuild.trend);
    expect(view.points.map((p) => p.value)).toEqual([null, null, null, null, null, 0, 2.9702, 3.3645]);
    expect(view.weeksWithRuns).toBe(3);
    expect(view.partlyUnpricedWeeks).toBe(2);
    // Only the last week is fully priced: there is no earlier baseline, so no misleading "+N%".
    expect(view.first).toEqual({ index: 7, value: 3.3645 });
    expect(view.change).toBeNull();
  });

  it('measures the change from the first fully priced week to the latest', () => {
    const view = trendView(trend([null, 2, null, 3]));
    expect(view.first).toEqual({ index: 1, value: 2 });
    expect(view.last).toEqual({ index: 3, value: 3 });
    expect(view.change).toBeCloseTo(0.5);
  });
});

describe('execution cost and saving', () => {
  it('projects from the rate ratio until execution runs exist, then measures', () => {
    expect(executionCost(featureBuild)).toEqual({ usd: 1.3241, basis: 'projected', model: 'sonnet' });
    expect(executionCost(discoveryType)).toEqual({ usd: null, basis: 'none', model: null });
    const measured = entry({
      processType: 'feature-build',
      name: 'Feature build',
      discovery: { runs: 4, completedRuns: 4, avgCostUsd: 3, totalCostUsd: 12 },
      execution: { runs: 2, completedRuns: 2, avgCostUsd: 0.9, totalCostUsd: 1.8 },
    });
    expect(executionCost(measured)).toEqual({ usd: 0.9, basis: 'measured', model: 'sonnet' });
    expect(savingRatio(measured)).toBeCloseTo(0.7);
    expect(savingRatio(featureBuild)).toBeCloseTo(0.5);
    expect(savingRatio(discoveryType)).toBeNull();
  });

  it('sorts hero rows into distillable, discovery-only and idle', () => {
    expect(heroRowKind(featureBuild)).toBe('distillable');
    expect(heroRowKind(bugFix)).toBe('distillable');
    expect(heroRowKind(discoveryType)).toBe('discovery_only');
    expect(heroRowKind(migration)).toBe('idle');
  });
});

describe('heroSummary', () => {
  it('sums the projected opportunity in USD and in RM (each run at its own day rate, from the daemon)', () => {
    const s = heroSummary(ENTRIES);
    expect(s.realizedUsd).toBe(0);
    expect(s.executionRuns).toBe(0);
    expect(s.opportunityTypes).toBe(2);
    expect(s.opportunityRuns).toBe(12);
    expect(s.opportunityUsd).toBeCloseTo(13.144, 4);
    expect(s.opportunityRm).toBeCloseTo(55.6379, 4);
    expect(s.weightedSaving).toBeCloseTo(0.5);
    expect(s.savingBasis).toBe('projected');
    expect(s.tokensSaved).toBeNull();
  });

  it('reports a mixed basis, and no RM total when any realized saving could not be converted', () => {
    const measured = entry({
      processType: 'docs',
      name: 'Docs',
      discovery: { runs: 2, completedRuns: 2, avgCostUsd: 1, totalCostUsd: 2 },
      execution: { runs: 3, completedRuns: 3, avgCostUsd: 0.25, totalCostUsd: 0.75 },
      realizedSavingsUsd: 2.25,
      opportunity: { usd: 1.5, basis: 'measured', windowRuns: 2, executionCostUsd: 0.25 },
      savings: { realizedRm: null, opportunityRm: 6.3, tokensSaved: 1_200_000, timeSavedMs: 3_600_000 },
    });
    const s = heroSummary([featureBuild, measured]);
    expect(s.savingBasis).toBe('mixed');
    expect(s.realizedUsd).toBeCloseTo(2.25);
    expect(s.realizedRm).toBeNull();
    expect(s.executionRuns).toBe(3);
    expect(s.tokensSaved).toBe(1_200_000);
    expect(s.timeSavedMs).toBe(3_600_000);
  });
});

describe('niceScale', () => {
  it('rounds the axis up to 1, 2, 2.5 or 5 × 10ⁿ', () => {
    expect(niceScale(3.3645)).toEqual({ max: 4, ticks: [0, 1, 2, 3, 4] });
    expect(niceScale(12)).toEqual({ max: 12.5, ticks: [0, 2.5, 5, 7.5, 10, 12.5] });
    expect(niceScale(0)).toEqual({ max: 1, ticks: [0, 1] });
  });
});

describe('routing and runs', () => {
  it('explains routing in words, never by budget', () => {
    const [discovery, feature, triage] = TYPES.types as [
      (typeof TYPES.types)[number],
      (typeof TYPES.types)[number],
      (typeof TYPES.types)[number],
    ];
    expect(routingReason(discovery, null)).toBe('discovery-class: always the discovery model');
    expect(routingReason(feature, 1)).toBe('playbook v1 approved');
    expect(routingReason(triage, null)).toBe('single model for this type');
    expect(routingReason(processType({ id: 'bug-fix', name: 'Bug fix' }), null)).toBe('no approved playbook yet');
  });

  it('flags finished runs counted at US$0 and offers only completed runs not already distilled', () => {
    expect(unpricedRuns(RUNS).map((r) => r.runId)).toEqual(['ses_old']);
    expect(distillCandidates(RUNS).map((r) => r.runId)).toEqual(['ses_docs1', 'ses_old']);
  });

  it('summarises the model dimension for one process type', () => {
    const tiers = (cheap: number, strong: number) => [
      { tier: 'sonnet' as const, runs: 6, occurrences: cheap },
      { tier: 'opus' as const, runs: 6, occurrences: strong },
    ];
    const report: ModelDimensionReportDTO = {
      generatedAt: '2026-10-09T06:00:00.000Z',
      minRunsPerTier: 3,
      classes: [
        {
          classId: 'rc_1',
          name: 'Missed migration ordering',
          dimension: 'model_capability',
          occurrences: 4,
          verdict: 'model_capability',
          summary: 'model capability',
          recommendations: [],
          byTier: tiers(4, 0),
          byProcessType: [
            {
              processType: 'feature-build',
              verdict: 'model_capability',
              tiers: tiers(4, 0),
              cheaperTier: 'sonnet',
              strongerTier: 'opus',
              recommendation: 'targeted per-process-type upgrade for feature-build',
            },
          ],
        },
        {
          classId: 'rc_2',
          name: 'Stale fixture data',
          dimension: 'context',
          occurrences: 4,
          verdict: 'spec_context_tooling',
          summary: 'spec/context/tooling, not the model',
          recommendations: [],
          byTier: tiers(2, 2),
          byProcessType: [
            { processType: 'feature-build', verdict: 'spec_context_tooling', tiers: tiers(2, 2), cheaperTier: null, strongerTier: null, recommendation: null },
            { processType: 'bug-fix', verdict: 'inconclusive', tiers: tiers(0, 0), cheaperTier: null, strongerTier: null, recommendation: null },
          ],
        },
      ],
    };
    const signal = modelSignal(report, 'feature-build');
    expect(signal.recurring).toBe(2);
    expect(signal.modelCapability).toEqual([
      { className: 'Missed migration ordering', recommendation: 'targeted per-process-type upgrade for feature-build', cheaperTier: 'sonnet' },
    ]);
    expect(signal.specContextTooling).toBe(1);
    // A class with no occurrences in this type is not a recurring signal for it.
    expect(modelSignal(report, 'bug-fix').recurring).toBe(0);
    expect(modelSignal(undefined, 'feature-build').recurring).toBe(0);
  });
});
