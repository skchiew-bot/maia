import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { cx } from '../lib/dom';
import { formatCompact } from '../lib/format';
import { Sparkline } from './Sparkline';
import type { Series, ValueFormatter } from './types';

export interface SmallMultipleSeries {
  id: string;
  /** Panel title (agent, project, process type). */
  label: string;
  /** Samples at equal intervals, oldest first — every panel covers the same time range. */
  values: Series;
  /** Context under the title. */
  note?: string;
  /** Router path for drill-down; makes the title a link. */
  href?: string;
}

export interface SmallMultiplesProps {
  series: readonly SmallMultipleSeries[];
  /** What every panel plots ("Actions per minute by agent"). */
  label: string;
  format?: ValueFormatter;
  /** Unit after values ("APM"). */
  unit?: string;
  /** One y-scale for every panel so heights compare honestly. Default true. */
  sharedScale?: boolean;
  /** `area` (default): line + soft wash; `line`: line only. */
  variant?: 'line' | 'area';
  /** Minimum panel width in px. Default 150 (two panels per row on a phone). */
  minPanelWidth?: number;
  /** Plot height in px. Default 36. */
  height?: number;
  /** The shared time range, printed in the caption ("last 30 min"). */
  rangeLabel?: string;
  className?: string;
}

/**
 * A grid of mini line/area charts on one shared scale (§12: "a flat line reveals a stall before any badge").
 * Every panel prints its latest value; the caption prints the shared scale.
 */
export function SmallMultiples({
  series,
  label,
  format = formatCompact,
  unit,
  sharedScale = true,
  variant = 'area',
  minPanelWidth = 150,
  height = 36,
  rangeLabel,
  className,
}: SmallMultiplesProps) {
  const all = series.flatMap((s) => s.values);
  const globalMax = all.length > 0 ? Math.max(...all) : 0;
  const withUnit = (v: number) => `${format(v)}${unit ? ` ${unit}` : ''}`;
  return (
    <div className={cx('aoc-smallmult', className)}>
      <p className="aoc-smallmult__caption">
        {sharedScale ? (
          <>
            One scale: <span className="aoc-num">0–{withUnit(globalMax)}</span>
          </>
        ) : (
          'Each panel on its own scale'
        )}
        {rangeLabel && <> · {rangeLabel}</>}
      </p>
      <ul
        className="aoc-smallmult__grid"
        aria-label={label}
        style={{ '--panel-min': `${minPanelWidth}px` } as CSSProperties}
      >
        {series.map((s) => {
          const last = s.values.length > 0 ? s.values[s.values.length - 1]! : undefined;
          return (
            <li key={s.id} className="aoc-smallmult__panel">
              <div className="aoc-smallmult__head">
                <span className="aoc-smallmult__title">
                  {s.href ? <Link to={s.href}>{s.label}</Link> : s.label}
                </span>
                <strong className="aoc-smallmult__value aoc-num">
                  {last === undefined ? '—' : withUnit(last)}
                </strong>
              </div>
              {s.note && <span className="aoc-smallmult__note">{s.note}</span>}
              <Sparkline
                values={s.values}
                label={s.label}
                unit={unit}
                format={format}
                height={height}
                yMax={sharedScale ? globalMax : undefined}
                area={variant === 'area'}
                showValue={false}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
