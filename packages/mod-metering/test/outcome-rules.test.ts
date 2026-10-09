import { describe, expect, it } from 'vitest';
import type { OutcomeCostItemDTO } from '@aoc/contracts';
import { dominantProcessType, outcomeClass } from '../src/outcomes';

const spend = (...pairs: [string | null, number][]) => new Map(pairs);

describe('dominantProcessType', () => {
  it('is the process type that carries the largest share of the outcome’s spend', () => {
    expect(dominantProcessType(spend(['bug-fix', 14], ['bug-triage', 10]))).toBe('bug-fix');
    expect(dominantProcessType(spend(['feature', 3], ['bug-fix', 4.5], ['docs', 1]))).toBe('bug-fix');
    expect(dominantProcessType(spend(['feature', 7]))).toBe('feature');
  });

  it('does not depend on the order the usage arrived in', () => {
    const pairs: [string | null, number][] = [
      ['feature', 6],
      ['bug-fix', 6],
      ['docs', 9],
    ];
    for (const order of [
      [0, 1, 2],
      [2, 1, 0],
      [1, 2, 0],
      [1, 0, 2],
    ])
      expect(dominantProcessType(spend(...order.map((i) => pairs[i]!)))).toBe('docs');
  });

  it('is null when nothing was spent under any process type', () => {
    expect(dominantProcessType(spend())).toBeNull();
  });

  it('is null when the two largest shares tie to the micro-dollar, and not when they differ by a micro-dollar', () => {
    expect(dominantProcessType(spend(['bug-fix', 5], ['feature', 5]))).toBeNull();
    expect(dominantProcessType(spend(['bug-fix', 5.0000001], ['feature', 5.0000004]))).toBeNull();
    expect(dominantProcessType(spend(['bug-fix', 5], ['feature', 5.000001]))).toBe('feature');
    // a tie below the leader does not matter
    expect(dominantProcessType(spend(['bug-fix', 2], ['feature', 2], ['docs', 9]))).toBe('docs');
  });

  it('is null when usage with no process type outweighs, or ties, every named one', () => {
    expect(dominantProcessType(spend(['feature', 10], [null, 12]))).toBeNull();
    expect(dominantProcessType(spend(['feature', 10], [null, 10]))).toBeNull();
    expect(dominantProcessType(spend(['feature', 12], [null, 10]))).toBe('feature');
    expect(dominantProcessType(spend([null, 3]))).toBeNull();
  });

  it('names a process type whose usage was all unpriced (US$0) when it is the only one, and none when several ran', () => {
    expect(dominantProcessType(spend(['feature', 0]))).toBe('feature');
    expect(dominantProcessType(spend(['feature', 0], ['bug-fix', 0]))).toBeNull();
  });
});

function item(
  refId: string,
  notionalUsd: number,
  notionalRm: number | null,
  rmComplete: boolean,
): OutcomeCostItemDTO {
  return {
    refId,
    projectId: 'prj_a',
    completedAt: '2026-10-09T02:00:00.000Z',
    notionalUsd,
    notionalRm,
    rmComplete,
    sessions: 1,
    unpriced: false,
    processType: 'feature',
  };
}

describe('outcomeClass', () => {
  it('computes the US$ statistics over every outcome and the RM twins over the outcomes whose RM is complete only', () => {
    const cls = outcomeClass('ticket_fixed', [
      item('tkt_1', 10, 42, true),
      item('tkt_2', 20, 90, true),
      // a day of its spend had no stamped rate: its partial RM must not enter any RM statistic
      item('tkt_3', 30, 100, false),
    ]);
    expect(cls.kind).toBe('ticket_fixed');
    expect(cls.stats).toEqual({
      count: 3,
      totalUsd: 60,
      meanUsd: 20,
      medianUsd: 20,
      p90Usd: 28,
      minUsd: 10,
      maxUsd: 30,
      totalRm: 132,
      meanRm: 66,
      medianRm: 66,
      p90Rm: 85.2,
      minRm: 42,
      maxRm: 90,
      rmComplete: false,
    });
    expect(cls.items.map((i) => i.refId)).toEqual(['tkt_1', 'tkt_2', 'tkt_3']);
  });

  it('is complete, with RM twins that mirror the US$ ones, when every outcome has its RM', () => {
    const { stats } = outcomeClass('change_shipped', [
      item('chg_1', 14, 59.2, true),
      item('chg_2', 20, 84.588, true),
    ]);
    expect(stats).toMatchObject({
      rmComplete: true,
      totalRm: 143.788,
      meanRm: 71.894,
      medianRm: 71.894,
      p90Rm: 82.0492,
      minRm: 59.2,
      maxRm: 84.588,
    });
  });

  it('has no RM figure, and says so, when no outcome has a complete RM', () => {
    const { stats } = outcomeClass('phase_completed', [
      item('prj_a/ph1', 5, null, false),
      item('prj_a/ph2', 7, 12, false),
    ]);
    expect(stats).toMatchObject({
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

  it('is vacuously complete when nothing completed', () => {
    expect(outcomeClass('ticket_fixed', []).stats).toEqual({
      count: 0,
      totalUsd: 0,
      meanUsd: null,
      medianUsd: null,
      p90Usd: null,
      minUsd: null,
      maxUsd: null,
      totalRm: null,
      meanRm: null,
      medianRm: null,
      p90Rm: null,
      minRm: null,
      maxRm: null,
      rmComplete: true,
    });
  });
});
