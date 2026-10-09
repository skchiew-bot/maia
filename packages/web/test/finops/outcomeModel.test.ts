import { describe, expect, it } from 'vitest';
import type { OutcomeCostStatsDTO } from '@aoc/contracts';
import { axisUsd, niceAxis } from '../../src/pages/metering/meteringModel';
import {
  activeProcessType,
  axisPct,
  byProject,
  noOutcomes,
  outcomeAxis,
  outcomeClasses,
  outcomeCount,
  outcomeHref,
  outcomeMyr,
  outcomeRows,
  outcomeUsd,
  percentile,
  phaseIdOf,
  processTypes,
  rangeMyrText,
  rangeText,
  rmIncompleteText,
  statsOf,
  withProcessType,
} from '../../src/pages/metering/outcomeModel';
import { NO_OUTCOMES, OUTCOMES, OUTCOMES_RM_GAP } from './fixtures';

/** `formatMyr` joins `RM` and the figure with a no-break space; DOM text is matched with plain ones. */
const plain = (s: string | null) => (s ?? '').replace(/ /g, ' ');
const names: Record<string, string> = { prj_aoc: 'AOC Platform', prj_claims: 'Claims Intake Bot' };
const nameOf = (id: string) => names[id] ?? null;

/** The daemon rounds to six decimals; the browser does not round at all, so compare to that precision. */
function expectSameStats(actual: OutcomeCostStatsDTO, expected: OutcomeCostStatsDTO) {
  for (const key of Object.keys(expected) as (keyof OutcomeCostStatsDTO)[]) {
    const want = expected[key];
    if (typeof want === 'number') expect(actual[key] as number, key).toBeCloseTo(want, 5);
    else expect(actual[key], key).toBe(want);
  }
}

describe('percentile (type 7, as the daemon computes it)', () => {
  // The daemon's own expectations (mod-metering outcomes.test.ts): tickets $14 and $20, changes $1 and $20.
  it('interpolates between closest ranks', () => {
    expect(percentile([14, 20], 0.5)).toBeCloseTo(17, 9);
    expect(percentile([14, 20], 0.9)).toBeCloseTo(19.4, 9);
    expect(percentile([1, 20], 0.5)).toBeCloseTo(10.5, 9);
    expect(percentile([1, 20], 0.9)).toBeCloseTo(18.1, 9);
    expect(percentile([5], 0.9)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe('money as text', () => {
  it('says a cost under a cent instead of reading as zero, in dollars and in ringgit', () => {
    expect(outcomeUsd(17)).toBe('US$17.00');
    expect(outcomeUsd(0.003)).toBe('<US$0.01');
    expect(outcomeUsd(0)).toBe('US$0.00');
    expect(plain(outcomeMyr(71.8716))).toBe('RM 71.87');
    expect(plain(outcomeMyr(0.003))).toBe('<RM 0.01');
    expect(plain(outcomeMyr(0))).toBe('RM 0.00');
  });

  it('prints a range of ringgit as one figure when every outcome cost the same, and none without a complete RM', () => {
    expect(plain(rangeMyrText({ minRm: 59.1552, maxRm: 84.588 }))).toBe('RM 59.16 – RM 84.59');
    expect(plain(rangeMyrText({ minRm: 12, maxRm: 12 }))).toBe('RM 12.00');
    expect(rangeMyrText({ minRm: null, maxRm: null })).toBeNull();
  });

  it('says why outcomes are missing from the RM figures, in the singular and the plural', () => {
    expect(rmIncompleteText(1, 3)).toBe(
      '1 of 3 has usage on a day with no stamped FX rate, so is left out of the RM figures',
    );
    expect(rmIncompleteText(2, 2)).toBe(
      '2 of 2 have usage on a day with no stamped FX rate, so are left out of the RM figures',
    );
  });
});

describe('figures of some outcomes', () => {
  it('are the daemon’s per-outcome figures added up and ordered the daemon’s way: a whole kind matches its own stats', () => {
    for (const key of ['ticketsFixed', 'changesShipped', 'phasesCompleted'] as const)
      expectSameStats(statsOf(OUTCOMES[key].items), OUTCOMES[key].stats);
  });

  it('leave an outcome whose RM is incomplete out of the RM figures, as the daemon does', () => {
    const mine = statsOf(OUTCOMES_RM_GAP.ticketsFixed.items);
    expectSameStats(mine, OUTCOMES_RM_GAP.ticketsFixed.stats);
    expect(mine).toMatchObject({ count: 2, totalUsd: 34, totalRm: 84.588, rmComplete: false });
    expect(
      statsOf([
        { notionalUsd: 5, notionalRm: null, rmComplete: false },
        { notionalUsd: 7, notionalRm: 12, rmComplete: false },
      ]),
    ).toMatchObject({
      count: 2,
      totalUsd: 12,
      totalRm: null,
      meanRm: null,
      medianRm: null,
      p90Rm: null,
      minRm: null,
      maxRm: null,
      rmComplete: false,
    });
  });

  it('are the empty kind’s when there are no outcomes', () => {
    expect(statsOf([])).toEqual(NO_OUTCOMES.ticketsFixed.stats);
  });
});

describe('axis', () => {
  it('rounds the top up to a tick, the same way for every chart', () => {
    expect(niceAxis(22.934199)).toEqual({ top: 30, step: 10 });
    expect(niceAxis(3.2)).toEqual({ top: 4, step: 1 });
    expect(niceAxis(0)).toEqual({ top: 1, step: 0.5 });
    expect(axisUsd(0)).toBe('US$0');
    expect(axisUsd(10)).toBe('US$10');
    expect(axisUsd(0.5)).toBe('US$0.50');
  });

  it('is one scale for the three kinds, set by the costliest outcome of any of them', () => {
    expect(outcomeAxis(OUTCOMES)).toEqual({ top: 30, ticks: [0, 10, 20, 30] });
    expect(outcomeAxis(NO_OUTCOMES)).toEqual({ top: 1, ticks: [0, 0.5, 1] });
    expect(axisPct(15, 30)).toBe(50);
    expect(axisPct(45, 30)).toBe(100);
    expect(axisPct(-1, 30)).toBe(0);
  });
});

describe('outcomes', () => {
  it('lists the three kinds in a fixed order with how many include unpriced usage or lack a complete RM', () => {
    const classes = outcomeClasses(OUTCOMES);
    expect(classes.map((c) => [c.info.label, c.stats.count, c.unpriced, c.rmIncomplete])).toEqual([
      ['Tickets fixed', 2, 0, 0],
      ['Changes shipped', 2, 0, 0],
      ['Phases completed', 3, 3, 0],
    ]);
    expect(outcomeClasses(OUTCOMES_RM_GAP).map((c) => c.rmIncomplete)).toEqual([1, 0, 0]);
    expect(noOutcomes(OUTCOMES)).toBe(false);
    expect(noOutcomes(NO_OUTCOMES)).toBe(true);
    expect(outcomeCount(1)).toBe('1 outcome');
    expect(outcomeCount(2)).toBe('2 outcomes');
  });

  it('prints a range as one figure when every outcome of the kind cost the same', () => {
    expect(rangeText({ minUsd: 14, maxUsd: 20 })).toBe('US$14.00 – US$20.00');
    expect(rangeText({ minUsd: 12, maxUsd: 12 })).toBe('US$12.00');
    expect(rangeText({ minUsd: null, maxUsd: null })).toBe('—');
  });

  it('opens the ticket, the change record, or the phase on its project timeline', () => {
    expect(outcomeHref('ticket_fixed', { refId: 'tkt_1', projectId: 'prj_a' })).toBe('/tickets/tkt_1');
    expect(outcomeHref('change_shipped', { refId: 'chg_1', projectId: null })).toBe('/changes/chg_1');
    expect(outcomeHref('phase_completed', { refId: 'prj_a/build', projectId: 'prj_a' })).toBe(
      '/projects/prj_a#prj-mt-phase-build',
    );
    expect(outcomeHref('phase_completed', { refId: 'prj_a/build', projectId: null })).toBe(
      '/projects/prj_a#prj-mt-phase-build',
    );
    expect(phaseIdOf({ refId: 'prj_a/build' })).toBe('build');
  });

  it('orders outcomes by completion, newest first: the list is never a cost ranking', () => {
    const rows = outcomeRows(OUTCOMES);
    expect(rows.map((r) => r.item.refId)).toEqual([
      'chg_01M4FDC0CVARB5BHJ5HX4BB3RC',
      'tkt_01M4FC3GS5VXC370PY64VM0XE9',
      'tkt_01M4FC3GS5VXC370PY64VM0XE8',
      'chg_01M4FDBZYA4VBEQ8CKEK7FP42E',
      'prj_aoc/build',
      'prj_claims/build',
      'prj_claims/design',
    ]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
  });
});

describe('process types', () => {
  it('are the ones the outcomes name, in name order, with how many outcomes each is the main spend of', () => {
    expect(processTypes(OUTCOMES)).toEqual([
      { processType: 'bug-fix', count: 2 },
      { processType: 'discovery', count: 1 },
      { processType: 'feature-build', count: 3 },
    ]);
    expect(processTypes(NO_OUTCOMES)).toEqual([]);
  });

  it('keep a chosen type only while the chips still offer it', () => {
    const types = processTypes(OUTCOMES);
    expect(activeProcessType('bug-fix', types)).toBe('bug-fix');
    expect(activeProcessType('docs', types)).toBeNull();
    expect(activeProcessType(null, types)).toBeNull();
    // one type is nothing to choose between
    expect(activeProcessType('bug-fix', [{ processType: 'bug-fix', count: 2 }])).toBeNull();
    expect(activeProcessType('bug-fix', [])).toBeNull();
  });

  it('narrow every kind to one type, with the figures worked out from the daemon’s per-outcome ones', () => {
    expect(withProcessType(OUTCOMES, null)).toBe(OUTCOMES);

    const only = withProcessType(OUTCOMES, 'feature-build');
    expect(only.ticketsFixed.items).toEqual([]);
    expect(only.ticketsFixed.stats).toEqual(NO_OUTCOMES.ticketsFixed.stats);
    expect(only.changesShipped.items.map((i) => i.refId)).toEqual(['chg_01M4FDBZYA4VBEQ8CKEK7FP42E']);
    expect(only.changesShipped.stats).toMatchObject({
      count: 1,
      totalUsd: 20,
      medianUsd: 20,
      totalRm: 84.854,
      medianRm: 84.854,
      rmComplete: true,
    });
    expect(only.phasesCompleted.items.map((i) => i.refId)).toEqual(['prj_claims/build', 'prj_aoc/build']);
    expect(only.phasesCompleted.stats.totalUsd).toBeCloseTo(8.800845 + 22.934199, 6);
    expect(only.phasesCompleted.stats.medianRm).toBeCloseTo((37.222294 + 97.130901) / 2, 6);
    // the range and the wording are the daemon's
    expect({ from: only.from, to: only.to, notice: only.notice, method: only.method }).toEqual({
      from: OUTCOMES.from,
      to: OUTCOMES.to,
      notice: OUTCOMES.notice,
      method: OUTCOMES.method,
    });
  });

  it('leave an outcome with no single type under “All” only', () => {
    const named = processTypes(OUTCOMES).reduce((n, t) => n + t.count, 0);
    expect(named).toBe(6);
    const everyTypeAdded = ['bug-fix', 'discovery', 'feature-build'].reduce(
      (n, t) => n + outcomeRows(withProcessType(OUTCOMES, t)).length,
      0,
    );
    expect(everyTypeAdded).toBe(6);
    expect(outcomeRows(OUTCOMES)).toHaveLength(7);
  });
});

describe('grouping by project', () => {
  it('goes by project name, outcomes that span projects last, never by cost', () => {
    const rows = byProject(OUTCOMES, nameOf);
    expect(rows.map((r) => [r.projectId, r.name, r.total.count])).toEqual([
      ['prj_aoc', 'AOC Platform', 1],
      ['prj_claims', 'Claims Intake Bot', 5],
      [null, 'Several projects', 1],
    ]);
    // The costliest project is not first: the lens does not rank.
    expect(rows[1]!.total.totalUsd).toBeGreaterThan(rows[0]!.total.totalUsd);
  });

  it('computes each kind the daemon’s way, so a kind confined to one project matches its own figure', () => {
    const claims = byProject(OUTCOMES, nameOf).find((r) => r.projectId === 'prj_claims')!;
    expect(claims.byKind.ticketsFixed).toMatchObject({ count: 2, totalUsd: 34, totalRm: 143.7432 });
    expect(claims.byKind.ticketsFixed.medianUsd).toBeCloseTo(OUTCOMES.ticketsFixed.stats.medianUsd!, 9);
    expect(claims.byKind.ticketsFixed.medianRm).toBeCloseTo(OUTCOMES.ticketsFixed.stats.medianRm!, 6);
    expect(claims.byKind.phasesCompleted.count).toBe(2);
    expect(claims.byKind.phasesCompleted.medianUsd).toBeCloseTo((3.084031 + 8.800845) / 2, 9);
    expect(claims.byKind.phasesCompleted.medianRm).toBeCloseTo((13.084618 + 37.222294) / 2, 6);
    expect(claims.total.totalUsd).toBeCloseTo(34 + 20 + 3.084031 + 8.800845, 9);
    expect(claims.total.totalRm).toBeCloseTo(143.7432 + 84.854 + 13.084618 + 37.222294, 6);
    expect(claims.total.rmComplete).toBe(true);
    const aoc = byProject(OUTCOMES, nameOf).find((r) => r.projectId === 'prj_aoc')!;
    expect(aoc.byKind.ticketsFixed).toEqual(NO_OUTCOMES.ticketsFixed.stats);
  });

  it('carries an incomplete RM into the project and kind it belongs to, and no further', () => {
    const rows = byProject(OUTCOMES_RM_GAP, nameOf);
    const claims = rows.find((r) => r.projectId === 'prj_claims')!;
    expect(claims.byKind.ticketsFixed).toMatchObject({ rmComplete: false, totalRm: 84.588 });
    expect(claims.byKind.changesShipped.rmComplete).toBe(true);
    expect(claims.total.rmComplete).toBe(false);
    expect(rows.find((r) => r.projectId === 'prj_aoc')!.total.rmComplete).toBe(true);
  });

  it('falls back to the id for a project the viewer cannot name, and groups nothing when nothing completed', () => {
    expect(byProject(OUTCOMES, () => null).map((r) => r.name)).toEqual([
      'prj_aoc',
      'prj_claims',
      'Several projects',
    ]);
    expect(byProject(NO_OUTCOMES, nameOf)).toEqual([]);
  });
});
