import { useMemo } from 'react';
import { cx } from '../lib/dom';
import { formatCompact, formatShortDate } from '../lib/format';
import { ChartTable, HitLayer, columnPath, useElementWidth, type HitItem } from './shared';
import type { DailyValue, ValueFormatter } from './types';

export interface MiniBarChartProps {
  /** One value per calendar day, oldest first. */
  data: readonly DailyValue[];
  /** What is counted ("Daily notional cost") — names the summary. */
  label: string;
  format?: ValueFormatter;
  /** Plot height in px (bars only; date labels add 16px). Default 64. */
  height?: number;
  /** Label for the last bar in the stats line. Default "Latest". Use "Today" for live rollups. */
  lastLabel?: string;
  /** Adds a collapsible data table. */
  tableView?: boolean;
  className?: string;
}

const AXIS_H = 16;
const TOP_PAD = 4;

/** Daily rollup columns (≤ 24px wide, square baseline, rounded data end) with latest/peak/total as text. */
export function MiniBarChart({
  data,
  label,
  format = formatCompact,
  height = 64,
  lastLabel = 'Latest',
  tableView,
  className,
}: MiniBarChartProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(320);
  const n = data.length;
  const max = n > 0 ? Math.max(...data.map((d) => d.value)) : 0;
  const top = Math.max(max, 1e-9);
  const peakIndex = data.findIndex((d) => d.value === max);
  const total = data.reduce((s, d) => s + d.value, 0);
  const last = n > 0 ? data[n - 1]! : undefined;

  const bars = useMemo(() => {
    const slot = n > 0 ? width / n : width;
    const barW = Math.max(1, Math.min(24, slot - 2));
    const plotH = height - TOP_PAD;
    return data.map((d, i) => {
      const h = Math.max(d.value > 0 ? 1 : 0, (d.value / top) * plotH);
      return { d, x: i * slot + (slot - barW) / 2, y: TOP_PAD + plotH - h, w: barW, h };
    });
  }, [data, n, width, height, top]);

  const hits: HitItem[] = bars.map((b) => ({
    key: b.d.date,
    x: b.x,
    y: TOP_PAD,
    width: b.w,
    height: height - TOP_PAD,
    label: `${formatShortDate(b.d.date)}: ${format(b.d.value)}${b.d.note ? `. ${b.d.note}` : ''}`,
    tooltip: (
      <>
        <strong className="aoc-num">{format(b.d.value)}</strong>
        <span className="aoc-chart-tip__meta">{formatShortDate(b.d.date)}</span>
        {b.d.note && <span className="aoc-chart-tip__meta">{b.d.note}</span>}
      </>
    ),
  }));

  const summary =
    n === 0
      ? `${label}: no data`
      : `${label}, ${formatShortDate(data[0]!.date)} to ${formatShortDate(last!.date)}: ${lastLabel.toLowerCase()} ${format(
          last!.value,
        )}, peak ${format(max)} on ${formatShortDate(data[peakIndex]!.date)}, total ${format(total)}.`;

  return (
    <figure className={cx('aoc-chart', 'aoc-minibar', className)}>
      <figcaption className="aoc-chart__stats">
        <span>
          {lastLabel} <strong className="aoc-num">{last ? format(last.value) : '—'}</strong>
        </span>
        <span>
          Peak <strong className="aoc-num">{format(max)}</strong>
          {peakIndex >= 0 && (
            <span className="aoc-chart__stat-note"> {formatShortDate(data[peakIndex]!.date)}</span>
          )}
        </span>
        <span>
          Total <strong className="aoc-num">{format(total)}</strong>
        </span>
      </figcaption>
      <div className="aoc-chart__plot" ref={ref}>
        <svg
          role="img"
          aria-label={summary}
          width={width}
          height={height + AXIS_H}
          viewBox={`0 0 ${width} ${height + AXIS_H}`}
        >
          <line x1={0} x2={width} y1={height + 0.5} y2={height + 0.5} className="aoc-chart__baseline" />
          {bars.map((b, i) => (
            <path
              key={b.d.date}
              d={columnPath(b.x, b.y, b.w, b.h)}
              className={cx('aoc-minibar__bar', i === n - 1 && 'is-last')}
            />
          ))}
          {n > 0 && (
            <>
              <text x={0} y={height + 13} className="aoc-chart__axis-label">
                {formatShortDate(data[0]!.date)}
              </text>
              {n > 1 && (
                <text x={width} y={height + 13} textAnchor="end" className="aoc-chart__axis-label">
                  {formatShortDate(last!.date)}
                </text>
              )}
            </>
          )}
        </svg>
        <HitLayer items={hits} label={`${label}: days`} width={width} height={height} minSize={12} />
      </div>
      {tableView && (
        <ChartTable
          caption={label}
          columns={['Day', 'Value', 'Note']}
          rows={data.map((d) => [formatShortDate(d.date), format(d.value), d.note ?? ''])}
          numericColumns={[1]}
        />
      )}
    </figure>
  );
}
