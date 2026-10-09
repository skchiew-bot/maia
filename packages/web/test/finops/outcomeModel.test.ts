import { describe, expect, it } from 'vitest';
import { axisUsd, niceAxis } from '../../src/pages/metering/meteringModel';
import {
  axisPct,
  blendedRate,
  byProject,
  noOutcomes,
  outcomeAxis,
  outcomeClasses,
  outcomeCount,
  outcomeHref,
  outcomeRm,
  outcomeRows,
  outcomeUsd,
  percentile,
  phaseIdOf,
  rangeText,
} from '../../src/pages/metering/outcomeModel';
import { NO_OUTCOMES, OUTCOMES } from './fixtures';

const plain = (s: string | null) => (s ?? '').replace(/ /g, ' ');
const names: Record<string, string> = { prj_aoc: 'AOC Platform', prj_claims: 'Claims Intake Bot' };
const nameOf = (id: string) => names[id] ?? null;

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

describe('money and the RM rate', () => {
  it('says a cost under a cent instead of reading as zero', () => {
    expect(outcomeUsd(17)).toBe('US$17.00');
    expect(outcomeUsd(0.003)).toBe('<US$0.01');
    expect(outcomeUsd(0)).toBe('US$0.00');
  });

  it('prices RM at the blend of the stamped rollups: exact for the whole portfolio, indicative per outcome', () => {
    const totals = { notionalUsd: 31.16, notionalRm: 131.95, rmComplete: true };
    const basis = blendedRate(totals)!;
    expect(basis.rate).toBeCloseTo(131.95 / 31.16, 12);
    expect(basis).toMatchObject({ usd: 31.16, rm: 131.95 });
    // total × blend is the rollups' RM
    expect(31.16 * basis.rate).toBeCloseTo(131.95, 9);
    expect(plain(outcomeRm(17, basis.rate))).toBe('≈ RM 71.99');
    expect(plain(outcomeRm(0.001, basis.rate))).toBe('≈ <RM 0.01');
  });

  it('gives no RM when any day with usage had no stamped rate, or nothing was metered', () => {
    expect(blendedRate({ notionalUsd: 31.16, notionalRm: 120, rmComplete: false })).toBeNull();
    expect(blendedRate({ notionalUsd: 31.16, notionalRm: null, rmComplete: true })).toBeNull();
    expect(blendedRate({ notionalUsd: 0, notionalRm: 0, rmComplete: true })).toBeNull();
    expect(blendedRate(undefined)).toBeNull();
    expect(outcomeRm(17, null)).toBeNull();
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
  it('lists the three kinds in a fixed order with how many include unpriced usage', () => {
    const classes = outcomeClasses(OUTCOMES);
    expect(classes.map((c) => [c.info.label, c.stats.count, c.unpriced])).toEqual([
      ['Tickets fixed', 2, 0],
      ['Changes shipped', 2, 0],
      ['Phases completed', 3, 3],
    ]);
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

describe('grouping by project', () => {
  it('goes by project name, outcomes that span projects last, never by cost', () => {
    const rows = byProject(OUTCOMES, nameOf);
    expect(rows.map((r) => [r.projectId, r.name, r.count])).toEqual([
      ['prj_aoc', 'AOC Platform', 1],
      ['prj_claims', 'Claims Intake Bot', 5],
      [null, 'Several projects', 1],
    ]);
    // The costliest project is not first: the lens does not rank.
    expect(rows[1]!.totalUsd).toBeGreaterThan(rows[0]!.totalUsd);
  });

  it('computes each kind the daemon\'s way, so a kind confined to one project matches its own figure', () => {
    const claims = byProject(OUTCOMES, nameOf).find((r) => r.projectId === 'prj_claims')!;
    expect(claims.byKind.ticketsFixed).toMatchObject({ count: 2, totalUsd: 34 });
    expect(claims.byKind.ticketsFixed.medianUsd).toBeCloseTo(OUTCOMES.ticketsFixed.stats.medianUsd!, 9);
    expect(claims.byKind.phasesCompleted.count).toBe(2);
    expect(claims.byKind.phasesCompleted.medianUsd).toBeCloseTo((3.084031 + 8.800845) / 2, 9);
    expect(claims.totalUsd).toBeCloseTo(34 + 20 + 3.084031 + 8.800845, 9);
    const aoc = byProject(OUTCOMES, nameOf).find((r) => r.projectId === 'prj_aoc')!;
    expect(aoc.byKind.ticketsFixed).toEqual({ count: 0, medianUsd: null, totalUsd: 0 });
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
