import { describe, expect, it } from 'vitest';
import {
  amendmentDelta,
  buildHero,
  costByTokenType,
  flaggedTasks,
  pendingStop,
  phaseProgress,
  phaseStatuses,
} from '../../src/pages/sessions/model';
import { activity, ago, decision, iso, manifest, metering, MIN, NOW, rateCard, timeline } from './fixtures';

describe('buildHero', () => {
  it('lays phases to scale, pairs decision request and answer, and keeps throttle spans', () => {
    const hero = buildHero(timeline(), activity(), undefined);
    expect(hero.start).toBe(NOW - 390 * MIN);
    expect(hero.end).toBe(NOW);
    expect(hero.ended).toBe(false);
    expect(hero.phases.map((p) => [p.code, p.name, p.active])).toEqual([
      ['P1', 'Design', false],
      ['P2', 'Build', true],
    ]);
    expect(hero.phases[1]!.end).toBe(NOW);
    expect(hero.decisions).toEqual([
      expect.objectContaining({ id: 'dec_old', at: NOW - 240 * MIN, closedAt: NOW - 218 * MIN, outcome: 'jsonb' }),
    ]);
    expect(hero.marks.map((m) => m.kind)).toEqual(['phase', 'flag', 'drift', 'amendment']);
    expect(hero.marks.find((m) => m.kind === 'drift')!.label).toBe('Change outside the plan');
    expect(hero.throttles).toEqual([{ start: NOW - 100 * MIN, end: NOW - 77 * MIN, open: false, resetAt: NOW - 77 * MIN }]);
    expect(hero.stats).toMatchObject({
      toolCalls: 21,
      activeMinutes: 3,
      peak: { count: 11, at: NOW - 119 * MIN },
      decisions: 1,
      openDecisions: 0,
      decisionWaitMs: 22 * MIN,
      drift: 1,
      rollbacks: 0,
      throttledMs: 23 * MIN,
    });
  });

  it('runs an open decision to the right edge and takes words from the decision card', () => {
    const t = timeline({
      marks: [{ kind: 'decision', at: ago(30), label: 'agent_decision', refId: 'dec_1', severity: null }],
    });
    const hero = buildHero(t, activity({ throttles: [] }), [decision({ id: 'dec_1', createdAt: ago(30), test: 'main', title: 'Merge to main?' })]);
    expect(hero.decisions[0]).toMatchObject({ title: 'Merge to main?', test: 'main', closedAt: null, outcome: null });
    expect(hero.stats.openDecisions).toBe(1);
    expect(hero.stats.decisionWaitMs).toBe(30 * MIN);
  });

  it('clamps marks into the window and lists marks recorded after an ended session', () => {
    const t = timeline({
      endAt: ago(60),
      marks: [
        { kind: 'drift', at: iso(NOW - 500 * MIN), label: 'overrun', refId: 't1', severity: 'low' },
        { kind: 'drift', at: ago(5), label: 'scope_growth', refId: 't2', severity: 'high' },
      ],
    });
    const hero = buildHero(t, undefined, undefined);
    expect(hero.ended).toBe(true);
    expect(hero.end).toBe(NOW - 60 * MIN);
    expect(hero.marks).toEqual([expect.objectContaining({ at: hero.start, label: 'Task overrun' })]);
    expect(hero.lateMarks).toEqual([expect.objectContaining({ at: NOW - 5 * MIN, label: 'Scope growth' })]);
    expect(hero.stats.drift).toBe(1);
    expect(hero.phases.every((p) => !p.active)).toBe(true);
  });

  it('groups the events of one rollback into a single mark', () => {
    const t = timeline({
      marks: [
        { kind: 'rollback', at: ago(90), label: 'requested', refId: 'rb_1', severity: 'high' },
        { kind: 'rollback', at: ago(80), label: 'verified', refId: 'rb_1', severity: 'high' },
      ],
    });
    const hero = buildHero(t, undefined, undefined);
    expect(hero.marks).toEqual([expect.objectContaining({ kind: 'rollback', detail: 'requested → verified' })]);
    expect(hero.stats.rollbacks).toBe(1);
  });
});

describe('plan helpers', () => {
  it('derives per-phase weighted completion and statuses from the manifest', () => {
    expect(phaseProgress(manifest())).toEqual([
      { id: 'design', label: 'P1 Design', doneWeight: 2, declaredWeight: 2, doneTasks: 1, declaredTasks: 1, state: 'done' },
      { id: 'build', label: 'P2 Build', doneWeight: 3, declaredWeight: 8, doneTasks: 1, declaredTasks: 2, state: 'active' },
      { id: 'verify', label: 'P3 Verify', doneWeight: 0, declaredWeight: 2, doneTasks: 0, declaredTasks: 1, state: 'pending' },
    ]);
    expect([...phaseStatuses(manifest())]).toEqual([
      ['design', 'done'],
      ['build', 'active'],
      ['verify', 'pending'],
    ]);
    expect(flaggedTasks(manifest()).map((t) => t.taskId)).toEqual(['t2']);
  });

  it('says how an amendment moved the denominator', () => {
    const a = timeline().amendments[0]!;
    expect(amendmentDelta(a, 4)).toBe('3 → 4 tasks, weight 10 → 12');
    expect(amendmentDelta(a)).toBe('weight 10 → 12');
  });
});

describe('costByTokenType', () => {
  it('prices each token type with the rate card and scales to the daemon total', () => {
    const m = metering();
    const split = costByTokenType(m.byModel, rateCard().active!, m.totals.notionalUsd)!;
    expect(split.map((p) => p.type)).toEqual(['input', 'output', 'cacheRead', 'cacheWrite']);
    const sum = split.reduce((n, p) => n + p.usd, 0);
    expect(sum).toBeCloseTo(28.22, 6);
    // raw: input 2.48, output 8.6, cache read 9.72, cache write 2.275 + 8 = 10.275 → cache write is the largest part
    expect(split[3]!.usd).toBeGreaterThan(split[2]!.usd);
  });

  it('falls back to the tier rate and gives up when nothing can be priced', () => {
    const m = metering();
    const rows = m.byModel.map((r) => ({ ...r, key: 'claude-sonnet-5-6' }));
    expect(costByTokenType(rows, rateCard().active!, 10)).not.toBeNull();
    expect(costByTokenType(rows, { rates: [], tierFallback: {} }, 10)).toBeNull();
  });
});

describe('pendingStop', () => {
  const ev = (type: string, meta: Record<string, boolean> = {}) => ({ type, ts: ago(2), meta });
  it('reports the latest stop request until the session ends', () => {
    expect(pendingStop([ev('tool.used'), ev('session.stop_requested', { immediate: false })], { lifecycle: 'running' })).toEqual({
      at: ago(2),
      immediate: false,
    });
    expect(pendingStop([ev('session.stop_requested', { immediate: true })], { lifecycle: 'ended' })).toBeNull();
    expect(pendingStop([ev('tool.used')], { lifecycle: 'running' })).toBeNull();
  });
});
