/**
 * Pure rules of the cost-per-outcome lens (§14): which process type an outcome counts under, the statistics of a
 * kind of outcome, and the method text that states both. Portfolio only: nothing here knows a person.
 */
import type { CostPerOutcomeDTO, OutcomeCostClassDTO, OutcomeCostItemDTO } from '@aoc/contracts';
import { percentile, round6 } from './stats';

/**
 * The process type behind most of an outcome's spend, given the spend booked under each one (key null = usage of no
 * known process type). Null when the largest share belongs to no known process type or is tied: a mixed outcome
 * stays unlabelled rather than taking whichever type the usage happened to arrive under. Shares are compared to the
 * micro-dollar, the precision money is reported at.
 */
export function dominantProcessType(spendByType: ReadonlyMap<string | null, number>): string | null {
  let top: string | null = null;
  let topUsd = -Infinity;
  let tied = false;
  for (const [type, spend] of spendByType) {
    const usd = round6(spend);
    if (usd > topUsd) {
      top = type;
      topUsd = usd;
      tied = false;
    } else if (usd === topUsd) tied = true;
  }
  return tied ? null : top;
}

function spread(values: number[]) {
  const total = values.reduce((sum, v) => sum + v, 0);
  const edge = (v: number | null) => (v === null ? null : round6(v));
  return {
    total: round6(total),
    mean: values.length ? round6(total / values.length) : null,
    median: edge(percentile(values, 0.5)),
    p90: edge(percentile(values, 0.9)),
    min: values.length ? round6(Math.min(...values)) : null,
    max: values.length ? round6(Math.max(...values)) : null,
  };
}

/**
 * Statistics of one kind of outcome. US$ covers every outcome; the RM twins cover only those whose RM is complete,
 * so an outcome missing a day's rate is left out of them rather than counted at a partial figure.
 */
export function outcomeClass(
  kind: OutcomeCostClassDTO['kind'],
  items: OutcomeCostItemDTO[],
): OutcomeCostClassDTO {
  const rmValues = items.flatMap((i) => (i.rmComplete && i.notionalRm !== null ? [i.notionalRm] : []));
  const usd = spread(items.map((i) => i.notionalUsd));
  const rm = spread(rmValues);
  return {
    kind,
    stats: {
      count: items.length,
      totalUsd: usd.total,
      meanUsd: usd.mean,
      medianUsd: usd.median,
      p90Usd: usd.p90,
      minUsd: usd.min,
      maxUsd: usd.max,
      totalRm: rmValues.length ? rm.total : null,
      meanRm: rm.mean,
      medianRm: rm.median,
      p90Rm: rm.p90,
      minRm: rm.min,
      maxRm: rm.max,
      rmComplete: rmValues.length === items.length,
    },
    items,
  };
}

export const OUTCOME_METHOD: CostPerOutcomeDTO['method'] = {
  attribution:
    'Tickets: lifetime notional spend of sessions launched for, triaging or building the ticket. Changes: sessions that drafted, started or built the change. ' +
    'A session linked to several tickets (or changes) is split evenly between them. Phases: usage attributed to the phase’s tasks plus unattributed usage of sessions launched into the phase.',
  window:
    'Outcomes completed (ticket closed as fixed, change completed, phase completed) on a local date within from..to; their spend may predate the window.',
  percentile: 'Median and p90 by linear interpolation between closest ranks (type 7), for US$ and RM alike.',
  fx:
    'Ringgit is notional too. Each usage day’s US$ is converted at that day’s stamped BNM USD→MYR rate (live or carried forward; rates carry 4 decimals, and a closed day keeps the rate it was stamped with), and the days are summed and rounded to 6 decimals once, at the end: never an average rate over a total. ' +
    'A day with usage and no stamped rate is left out of that outcome’s RM and marks it incomplete (rmComplete false); usage that cost US$0 needs no rate. The RM statistics cover only the outcomes whose RM is complete.',
  processType:
    'Process type: the one with the largest share of the outcome’s notional spend (usage booked under it, a session shared between outcomes counting by its share). ' +
    'Null when no spend is on record, when usage of no known process type holds the largest share, or when the two largest shares tie to the micro-dollar.',
};
