import { describe, expect, it } from 'vitest';
import type { LearningService, MeteringService, ProcessType, RegistryEntry } from '@aoc/contracts';
import type { TestRuntime } from '@aoc/kernel';
import { computeRegistryEntries, DEFAULT_RATES, runKind, weekStarts } from '../src';
import { ended, launch, rollover, seedPlaybook, start, usage } from './helpers';

const NOW = '2026-10-09T02:00:00.000Z'; // Friday 10:00 in Kuala Lumpur; week starts Monday 2026-10-05

function stubMetering(costs: Record<string, number>): MeteringService {
  return {
    notionalCostUsd: () => 0,
    fxRate: () => null,
    sessionCostUsd: (id) => costs[id] ?? 0,
    activeRateCardVersion: () => 1,
  };
}

const stubLearning: LearningService = {
  lessonsForScope: ({ processType }) =>
    processType === 'feature-build'
      ? [
          { lessonId: 'les_1', scopeType: 'process_type', scopeValue: 'feature-build', rule: 'r', fix: 'f' },
          { lessonId: 'les_2', scopeType: 'process_type', scopeValue: 'feature-build', rule: 'r', fix: 'f' },
        ]
      : [],
  recordLessonsApplied: () => {},
  recordError: () => {},
};

/** Launch (and optionally finish) a run at a given time. */
function run(
  t: TestRuntime,
  at: string,
  sessionId: string,
  processType: string,
  outcome: 'completed' | 'failed' | null = 'completed',
): void {
  t.clock.set(at);
  launch(t, { sessionId, processType });
  t.clock.advance(3_600_000);
  if (outcome) ended(t, sessionId, outcome);
}

const byType = (entries: RegistryEntry[], id: string) => entries.find((e) => e.processType === id)!;

describe('registry economics (Registry hero)', () => {
  it('splits discovery vs execution runs by playbook approval time and computes $/run, savings and the weekly trend', async () => {
    const costs: Record<string, number> = {
      d1: 10,
      d2: 12,
      d3: 8,
      e1: 3,
      e2: 5,
      e3: 99,
      x1: 20,
      x2: 22,
      b1: 6,
      b2: 6,
    };
    const t = await start({ services: { metering: stubMetering(costs), learning: stubLearning }, now: NOW });
    const builder = t.user('builder');

    // feature-build: three discovery runs (one failed), then a playbook is approved, then execution runs.
    run(t, '2026-09-08T02:00:00.000Z', 'd1', 'feature-build');
    run(t, '2026-09-09T02:00:00.000Z', 'd2', 'feature-build');
    run(t, '2026-09-15T02:00:00.000Z', 'd3', 'feature-build', 'failed');
    t.clock.set('2026-09-16T02:00:00.000Z');
    seedPlaybook(t, { playbookId: 'pbk_fb', processType: 'feature-build' });
    run(t, '2026-09-22T02:00:00.000Z', 'e1', 'feature-build');
    run(t, '2026-09-23T02:00:00.000Z', 'e2', 'feature-build');
    run(t, '2026-10-06T02:00:00.000Z', 'e3', 'feature-build', null); // still running: excluded from averages
    // discovery-class: an approved playbook never turns its runs into execution runs.
    seedPlaybook(t, { playbookId: 'pbk_disc', processType: 'discovery' });
    run(t, '2026-09-29T02:00:00.000Z', 'x1', 'discovery');
    run(t, '2026-09-30T02:00:00.000Z', 'x2', 'discovery');
    // bug-fix: no playbook yet → execution cost is projected from the opus→sonnet rate ratio.
    run(t, '2026-10-05T02:00:00.000Z', 'b1', 'bug-fix');
    run(t, '2026-10-06T02:00:00.000Z', 'b2', 'bug-fix');
    // A run older than the trend window still counts in the all-time split.
    run(t, '2026-07-01T02:00:00.000Z', 'old', 'test-repair');
    t.clock.set(NOW);

    const entries = await t.json<RegistryEntry[]>('GET', '/api/registry', { headers: builder.headers });
    expect(entries.map((e) => e.processType)).toEqual([
      'feature-build',
      'bug-fix',
      'discovery',
      'bug-triage',
      'test-repair',
    ]);

    const fb = byType(entries, 'feature-build');
    expect(fb.discovery).toEqual({ runs: 3, completedRuns: 2, avgCostUsd: 10, totalCostUsd: 30 });
    expect(fb.execution).toEqual({ runs: 2, completedRuns: 2, avgCostUsd: 4, totalCostUsd: 8 });
    expect(fb.activeRuns).toBe(1);
    expect(fb.savingsPct).toBe(60);
    expect(fb.realizedSavingsUsd).toBe(12);
    expect(fb.opportunity).toEqual({ usd: 30, basis: 'measured', windowRuns: 5, executionCostUsd: 4 });
    expect(fb.currentModel).toBe('sonnet');
    expect(fb.playbook).toMatchObject({
      status: 'approved',
      activePlaybookId: 'pbk_fb',
      activeVersion: 1,
      versions: 1,
      pendingPlaybookId: null,
    });
    expect(fb.lessonsInScope).toBe(2);
    expect(fb.openRepeatOffences).toBeNull();
    expect(fb.costBasis).toBe('metered');
    expect(fb.trend.map((p) => p.weekStart)).toEqual([
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
      '2026-10-05',
    ]);
    expect(fb.trend.map((p) => p.avgCostUsd)).toEqual([null, null, null, 11, 8, 4, null, null]);
    expect(fb.trend[3]).toMatchObject({ runs: 2, discoveryRuns: 2, executionRuns: 0 });
    expect(fb.trend[5]).toMatchObject({ runs: 2, discoveryRuns: 0, executionRuns: 2 });

    const disc = byType(entries, 'discovery');
    expect(disc.discovery).toMatchObject({ runs: 2, avgCostUsd: 21 });
    expect(disc.execution.runs).toBe(0);
    expect(disc.savingsPct).toBeNull();
    expect(disc.opportunity).toEqual({ usd: 0, basis: 'none', windowRuns: 2, executionCostUsd: null });
    expect(disc.currentModel).toBe('opus');

    const bf = byType(entries, 'bug-fix');
    expect(bf.opportunity).toEqual({ usd: 6, basis: 'projected', windowRuns: 2, executionCostUsd: 3 });
    expect(bf.savingsPct).toBeNull();
    expect(bf.playbook.status).toBe('none');
    expect(bf.lessonsInScope).toBe(0);

    const tr = byType(entries, 'test-repair');
    expect(tr.discovery.runs).toBe(1);
    expect(tr.opportunity.windowRuns).toBe(0);
    expect(tr.trend.every((p) => p.runs === 0)).toBe(true);

    expect((await t.request('GET', '/api/registry', { headers: t.user('requester').headers })).status).toBe(
      403,
    );
    expect((await t.request('GET', '/api/registry')).status).toBe(401);
    await t.close();
  });

  it('estimates cost from usage.recorded × default rates when no metering service is loaded, and counts a rollover chain once', async () => {
    const t = await start({ now: NOW });
    t.clock.set('2026-10-06T02:00:00.000Z');
    launch(t, { sessionId: 's1', processType: 'feature-build' });
    usage(t, 's1', 'claude-opus-5-5', { input: 1_000_000, output: 100_000 }); // 4 + 2 = $6
    ended(t, 's1', 'retired');
    launch(t, { sessionId: 's2', processType: 'feature-build' });
    rollover(t, 's1', 's2');
    usage(t, 's2', 'claude-sonnet-5-5', { cacheRead: 1_000_000 }); // $0.2
    usage(t, 's2', 'mystery-model', { output: 50_000 }); // unknown → launch tier (opus): $1
    ended(t, 's2', 'completed');
    t.clock.set(NOW);

    const entries = await t.json<RegistryEntry[]>('GET', '/api/registry', {
      headers: t.user('approver').headers,
    });
    const fb = byType(entries, 'feature-build');
    expect(fb.discovery).toEqual({ runs: 1, completedRuns: 1, avgCostUsd: 7.2, totalCostUsd: 7.2 });
    expect(fb.costBasis).toBe('estimated');
    expect(fb.lessonsInScope).toBeNull();
    expect(fb.trend.at(-1)).toMatchObject({ runs: 1, avgCostUsd: 7.2 });
    // Projected execution: opus → sonnet blended rate ratio (12 / 24).
    expect(fb.opportunity).toEqual({ usd: 3.6, basis: 'projected', windowRuns: 1, executionCostUsd: 3.6 });
    expect(byType(entries, 'bug-triage').costBasis).toBe('none');
    await t.close();
  });

  it('pure rules: run kind by launch vs approval interval, Monday-based local weeks', () => {
    const exec = { id: 'fb', class: 'execution', model: 'opus', executionModel: 'sonnet' } as ProcessType;
    const approvals = [{ processType: 'fb', approvedSeq: 10, retiredSeq: 20 }];
    expect(runKind(exec, 5, approvals)).toBe('discovery');
    expect(runKind(exec, 15, approvals)).toBe('execution');
    expect(runKind(exec, 25, approvals)).toBe('discovery');
    expect(runKind({ ...exec, class: 'discovery' }, 15, approvals)).toBe('discovery');
    // 2026-10-04T20:00Z is Monday 04:00 in Kuala Lumpur (UTC+8) — the local week, not the UTC one.
    expect(weekStarts(Date.parse('2026-10-04T20:00:00.000Z'), 'Asia/Kuala_Lumpur', 2)).toEqual([
      '2026-09-28',
      '2026-10-05',
    ]);
    expect(weekStarts(Date.parse('2026-10-04T20:00:00.000Z'), 'UTC', 1)).toEqual(['2026-09-28']);
    const none = computeRegistryEntries({
      types: [{ ...exec, name: 'FB', description: '', readOnly: false, risky: false } as ProcessType],
      runs: [],
      approvals: [],
      playbookStatus: () => ({
        status: 'none',
        activePlaybookId: null,
        activeVersion: null,
        approvedAt: null,
        pendingPlaybookId: null,
        pendingDecisionId: null,
        versions: 0,
      }),
      currentModel: () => 'opus',
      lessonsInScope: () => null,
      rates: { ...DEFAULT_RATES },
      nowMs: Date.parse(NOW),
      timezone: 'Asia/Kuala_Lumpur',
      weeks: 8,
    });
    expect(none[0]).toMatchObject({
      savingsPct: null,
      realizedSavingsUsd: null,
      costBasis: 'none',
      opportunity: { usd: 0, basis: 'none' },
    });
    expect(none[0]!.trend).toHaveLength(8);
  });
});
