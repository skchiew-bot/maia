import type { CSSProperties } from 'react';
import { cx } from '../lib/dom';
import { formatInteger } from '../lib/format';
import { ChartTable, columnPath } from './shared';
import type { RecurrenceClass, RecurrenceStage } from './types';

export interface RecurrenceTrendProps {
  /** Root-cause classes in priority order (by cost of recurrence, not count — §11). */
  classes: readonly RecurrenceClass[];
  /** Name for the group. Default "Recurrence by root-cause class". */
  label?: string;
  /** One y-scale for every facet so heights compare honestly. Default true. */
  sharedScale?: boolean;
  /** Minimum facet width in px. Default 200. */
  minFacetWidth?: number;
  /** Adds a collapsible table of all weekly counts. */
  tableView?: boolean;
  className?: string;
}

export const RECURRENCE_STAGE_WORD: Record<RecurrenceStage, string> = {
  detected: 'Detected',
  root_caused: 'Root-caused',
  fix_applied: 'Fix applied',
  verified_closed: 'Verified closed',
};

const FACET_W = 160;
const FACET_H = 36;

/**
 * Small multiples of weekly counts per root-cause class (§11). One hue for every facet — the classes are told
 * apart by their titles, not colour. Latest, total and peak are printed in each facet.
 */
export function RecurrenceTrend({
  classes,
  label = 'Recurrence by root-cause class',
  sharedScale = true,
  minFacetWidth = 200,
  tableView,
  className,
}: RecurrenceTrendProps) {
  const globalMax = Math.max(1, ...classes.flatMap((c) => c.weeks.map((w) => w.count)));
  const weeks = classes[0]?.weeks.map((w) => w.week) ?? [];
  return (
    <div className={cx('aoc-recur', className)}>
      <ul
        className="aoc-recur__grid"
        aria-label={label}
        style={{ '--facet-min': `${minFacetWidth}px` } as CSSProperties}
      >
        {classes.map((c) => {
          const counts = c.weeks.map((w) => w.count);
          const n = counts.length;
          const latest = n > 0 ? counts[n - 1]! : 0;
          const total = counts.reduce((a, b) => a + b, 0);
          const peak = Math.max(0, ...counts);
          const peakWeek = c.weeks[counts.indexOf(peak)]?.week;
          const top = sharedScale ? globalMax : Math.max(1, peak);
          const slot = n > 0 ? FACET_W / n : FACET_W;
          const barW = Math.max(2, Math.min(14, slot - 2));
          const summary = `${c.label}: ${formatInteger(latest)} in the latest week, ${formatInteger(total)} over ${n} weeks, peak ${formatInteger(
            peak,
          )}${peakWeek ? ` in ${peakWeek}` : ''}. Weekly: ${c.weeks.map((w) => `${w.week} ${w.count}`).join(', ')}.${
            c.stage ? ` Status: ${RECURRENCE_STAGE_WORD[c.stage]}.` : ''
          }`;
          return (
            <li key={c.id} className="aoc-recur__facet">
              <figure role="img" aria-label={summary}>
                <div className="aoc-recur__head">
                  <span className="aoc-recur__title">{c.label}</span>
                  {c.stage && (
                    <span className={cx('aoc-recur__stage', `is-${c.stage}`)}>
                      {RECURRENCE_STAGE_WORD[c.stage]}
                    </span>
                  )}
                </div>
                <div className="aoc-recur__body">
                  <div className="aoc-recur__latest">
                    <strong className="aoc-num">{formatInteger(latest)}</strong>
                    <span>latest wk</span>
                  </div>
                  <svg
                    className="aoc-recur__svg"
                    width="100%"
                    height={FACET_H}
                    viewBox={`0 0 ${FACET_W} ${FACET_H}`}
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <line
                      x1={0}
                      x2={FACET_W}
                      y1={FACET_H - 0.5}
                      y2={FACET_H - 0.5}
                      className="aoc-chart__baseline"
                    />
                    {counts.map((v, i) => {
                      const h = v > 0 ? Math.max(2, (v / top) * (FACET_H - 2)) : 0;
                      return (
                        <path
                          key={c.weeks[i]!.week}
                          d={columnPath(i * slot + (slot - barW) / 2, FACET_H - h, barW, h, 2)}
                          className={cx('aoc-recur__bar', i === n - 1 && 'is-last')}
                        />
                      );
                    })}
                  </svg>
                </div>
                <div className="aoc-recur__foot aoc-num">
                  {formatInteger(total)} in {n} wk · peak {formatInteger(peak)}
                  {c.note && <span className="aoc-recur__note"> · {c.note}</span>}
                </div>
              </figure>
            </li>
          );
        })}
      </ul>
      {tableView && (
        <ChartTable
          caption={label}
          columns={['Class', ...weeks]}
          rows={classes.map((c) => [c.label, ...c.weeks.map((w) => formatInteger(w.count))])}
          numericColumns={weeks.map((_, i) => i + 1)}
        />
      )}
    </div>
  );
}
