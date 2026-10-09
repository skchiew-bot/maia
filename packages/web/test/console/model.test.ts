import { describe, expect, it } from 'vitest';
import {
  applyFilters,
  endedSpend,
  filterOptions,
  filtersFromParams,
  filtersToParams,
  fleetCounts,
  NO_FILTERS,
  openDecisionsOldestFirst,
  sharedApmMax,
  sortByPrecedence,
  splitSessions,
} from '../../src/pages/console/model';
import { ago, decision, summary } from '../sessions/fixtures';

const s = (id: string, state: 'working' | 'thinking' | 'stalled' | 'dead' | 'throttled' | 'waiting_on_you', minutes = 5, over = {}) =>
  summary({ sessionId: id, liveness: { state, reason: 'x', since: ago(minutes) }, ...over });

describe('console model', () => {
  it('orders tiles by liveness precedence, longest in state first', () => {
    const sorted = sortByPrecedence([
      s('w', 'working'),
      s('t1', 'thinking'),
      s('d', 'dead', 3),
      s('wait-new', 'waiting_on_you', 2),
      s('st', 'stalled'),
      s('thr', 'throttled'),
      s('wait-old', 'waiting_on_you', 90),
    ]);
    expect(sorted.map((x) => x.sessionId)).toEqual(['wait-old', 'wait-new', 'thr', 'd', 'st', 't1', 'w']);
  });

  it('counts every state in precedence order, zeros included', () => {
    expect(fleetCounts([s('a', 'working'), s('b', 'working'), s('c', 'dead')])).toEqual([
      { state: 'waiting_on_you', count: 0 },
      { state: 'throttled', count: 0 },
      { state: 'dead', count: 1 },
      { state: 'stalled', count: 0 },
      { state: 'thinking', count: 0 },
      { state: 'working', count: 2 },
    ]);
  });

  it('keeps crashed sessions as tiles and moves finished ones to the ended table, latest first', () => {
    const split = splitSessions({
      sessions: [
        s('live', 'working'),
        summary({ sessionId: 'crashed', lifecycle: 'failed', liveness: { state: 'dead', reason: 'process_failed', since: ago(3) } }),
        summary({ sessionId: 'early', lifecycle: 'ended', endedAt: ago(300), outcome: 'completed', liveness: null }),
        summary({ sessionId: 'late', lifecycle: 'retired', endedAt: ago(20), outcome: 'retired', liveness: null }),
      ],
    });
    expect(split.live.map((x) => x.sessionId)).toEqual(['live', 'crashed']);
    expect(split.endedToday.map((x) => x.sessionId)).toEqual(['late', 'early']);
  });

  it('filters by project, liveness, owner and mine', () => {
    const rows = [
      s('a', 'working', 1, { projectId: 'p1', ownerId: 'u1' }),
      s('b', 'stalled', 1, { projectId: 'p2', ownerId: 'u2' }),
      s('c', 'stalled', 1, { projectId: 'p1', ownerId: 'u2' }),
    ];
    const ids = (f: Partial<typeof NO_FILTERS>, viewer: string | null = 'u1') =>
      applyFilters(rows, { ...NO_FILTERS, ...f }, viewer).map((x) => x.sessionId);
    expect(ids({ project: 'p1' })).toEqual(['a', 'c']);
    expect(ids({ liveness: 'stalled' })).toEqual(['b', 'c']);
    expect(ids({ owner: 'u2', project: 'p1' })).toEqual(['c']);
    expect(ids({ mine: true })).toEqual(['a']);
    expect(ids({ mine: true }, null)).toEqual([]);
  });

  it('round-trips filters through the URL and rejects unknown states', () => {
    const f = { project: 'prj_1', liveness: 'stalled' as const, owner: 'usr_2', mine: true };
    expect(filtersFromParams(filtersToParams(f))).toEqual(f);
    expect(filtersToParams(NO_FILTERS).toString()).toBe('');
    expect(filtersFromParams(new URLSearchParams('liveness=sleeping')).liveness).toBe('');
  });

  it('lists projects and owners by name, shares one APM scale and sums ended spend', () => {
    const rows = [
      s('a', 'working', 1, { projectId: 'p2', projectName: 'Zeta', ownerId: 'u1', ownerName: 'Wei Jie' }),
      s('b', 'working', 1, { projectId: 'p1', projectName: 'Alpha', ownerId: 'u2', ownerName: 'Aisyah' }),
    ];
    expect(filterOptions(rows).projects.map((o) => o.label)).toEqual(['Alpha', 'Zeta']);
    expect(filterOptions(rows).owners.map((o) => o.label)).toEqual(['Aisyah', 'Wei Jie']);
    expect(sharedApmMax(rows)).toBe(15);
    expect(sharedApmMax([summary({ apm: { windowMinutes: 30, points: [2, 22], current: 22 } })])).toBe(22);
    expect(endedSpend([summary({ costTodayUsd: 1.5, costTodayRm: 6.3 }), summary({ costTodayUsd: 2, costTodayRm: 8.4 })])).toEqual({
      usd: 3.5,
      rm: expect.closeTo(14.7, 6),
    });
    expect(endedSpend([summary({ costTodayRm: null })]).rm).toBeNull();
  });

  it('keeps open decisions, oldest first', () => {
    const list = openDecisionsOldestFirst([
      decision({ id: 'new', createdAt: ago(5) }),
      decision({ id: 'closed', status: 'resolved', createdAt: ago(500) }),
      decision({ id: 'old', createdAt: ago(300) }),
    ]);
    expect(list.map((d) => d.id)).toEqual(['old', 'new']);
  });
});
