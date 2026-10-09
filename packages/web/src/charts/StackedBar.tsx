import { useMemo } from 'react';
import { cx } from '../lib/dom';
import { formatInteger, formatPercent } from '../lib/format';
import { CATEGORICAL, ChartTable, toneColor, useElementWidth } from './shared';
import type { SegmentTone, ValueFormatter } from './types';

export interface StackedBarSeries {
  id: string;
  label: string;
  /** Defaults to the next categorical slot. Use status tones only when the part means good/bad. */
  tone?: SegmentTone;
}

export interface StackedBarRow {
  id: string;
  /** Category (project, process type, week). */
  label: string;
  /** Value per series id; missing ids count as 0. */
  values: Readonly<Record<string, number>>;
}

export interface StackedBarProps {
  /** Parts in stacking order (left to right). More than four fold into "Other". */
  series: readonly StackedBarSeries[];
  rows: readonly StackedBarRow[];
  /** What is shown ("Tasks by state") — names the summary. */
  label: string;
  format?: ValueFormatter;
  /** `absolute` (default): one shared scale; `percent`: every row fills the width (shares). */
  mode?: 'absolute' | 'percent';
  /** Bar thickness in px. Default 12. */
  barHeight?: number;
  /** Adds a collapsible table of every value. */
  tableView?: boolean;
  className?: string;
}

const GAP = 2;
const MAX_SERIES = 4;

interface ResolvedSeries {
  id: string;
  label: string;
  tone: SegmentTone;
  ids: readonly string[];
}

/**
 * Horizontal stacked bars per category with a legend that carries each part's total, and each row's total
 * printed at its end. 2px surface gaps separate parts; per-part values are in the summary, the hover title
 * and the optional table.
 */
export function StackedBar({
  series,
  rows,
  label,
  format = formatInteger,
  mode = 'absolute',
  barHeight = 12,
  tableView,
  className,
}: StackedBarProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(640);

  const resolved = useMemo<ResolvedSeries[]>(() => {
    const head = series.length > MAX_SERIES ? series.slice(0, MAX_SERIES - 1) : series;
    const tail = series.length > MAX_SERIES ? series.slice(MAX_SERIES - 1) : [];
    let slot = 0;
    const out: ResolvedSeries[] = head.map((s) => ({
      id: s.id,
      label: s.label,
      tone: s.tone ?? CATEGORICAL[slot++ % CATEGORICAL.length]!,
      ids: [s.id],
    }));
    if (tail.length > 0) {
      out.push({
        id: '__other',
        label: `Other (${tail.length})`,
        tone: 'neutral',
        ids: tail.map((s) => s.id),
      });
    }
    return out;
  }, [series]);

  const valueOf = (row: StackedBarRow, s: ResolvedSeries) =>
    s.ids.reduce((sum, id) => sum + (row.values[id] ?? 0), 0);
  const rowTotal = (row: StackedBarRow) => resolved.reduce((sum, s) => sum + valueOf(row, s), 0);
  const seriesTotals = resolved.map((s) => rows.reduce((sum, r) => sum + valueOf(r, s), 0));
  const grand = seriesTotals.reduce((a, b) => a + b, 0);
  const maxTotal = Math.max(1e-9, ...rows.map(rowTotal));

  const narrow = width < 520;
  const labelCol = narrow ? 0 : Math.min(180, Math.max(100, Math.round(width * 0.2)));
  const totalCol = 64;
  const barsW = Math.max(60, width - labelCol - totalCol - (narrow ? 12 : 24));

  const summary = `${label}: ${resolved.map((s, i) => `${s.label} ${format(seriesTotals[i] ?? 0)}`).join(', ')}; total ${format(
    grand,
  )}. ${rows
    .map((r) => `${r.label}: ${resolved.map((s) => `${s.label} ${format(valueOf(r, s))}`).join(', ')}`)
    .join('; ')}.`;

  return (
    <figure className={cx('aoc-chart', 'aoc-stacked', narrow && 'is-narrow', className)} ref={ref}>
      <div className="aoc-legend aoc-stacked__legend">
        {resolved.map((s, i) => (
          <span key={s.id} className="aoc-legend__item">
            <span
              className="aoc-legend__swatch"
              style={{ background: toneColor(s.tone) }}
              aria-hidden="true"
            />
            <span>{s.label}</span>
            <strong className="aoc-num">{format(seriesTotals[i] ?? 0)}</strong>
          </span>
        ))}
        <span className="aoc-legend__item aoc-stacked__grand">
          Total <strong className="aoc-num">{format(grand)}</strong>
        </span>
      </div>
      <div className="aoc-stacked__rows" role="img" aria-label={summary}>
        {rows.map((r) => {
          const total = rowTotal(r);
          const scale = mode === 'percent' ? (total > 0 ? barsW / total : 0) : barsW / maxTotal;
          const parts = resolved.map((s) => ({ s, v: valueOf(r, s) })).filter((p) => p.v > 0);
          const usable = Math.max(0, total * scale - GAP * Math.max(0, parts.length - 1));
          const factor = total * scale > 0 ? usable / (total * scale) : 0;
          let cursor = 0;
          return (
            <div
              key={r.id}
              className="aoc-stacked__row"
              style={{
                gridTemplateColumns: narrow ? `1fr ${totalCol}px` : `${labelCol}px ${barsW}px ${totalCol}px`,
              }}
            >
              <span className="aoc-stacked__label">{r.label}</span>
              <svg
                width={barsW}
                height={barHeight}
                viewBox={`0 0 ${barsW} ${barHeight}`}
                className="aoc-stacked__svg"
              >
                {parts.map((p) => {
                  const w = p.v * scale * factor;
                  const x = cursor;
                  cursor += w + GAP;
                  return (
                    <rect
                      key={p.s.id}
                      x={x}
                      y={0}
                      width={Math.max(0, w)}
                      height={barHeight}
                      rx={2}
                      style={{ fill: toneColor(p.s.tone) }}
                    >
                      <title>{`${p.s.label}: ${format(p.v)} (${formatPercent(total > 0 ? p.v / total : 0)})`}</title>
                    </rect>
                  );
                })}
              </svg>
              <span className="aoc-stacked__total aoc-num">{format(total)}</span>
            </div>
          );
        })}
      </div>
      {tableView && (
        <ChartTable
          caption={label}
          columns={['', ...resolved.map((s) => s.label), 'Total']}
          rows={rows.map((r) => [
            r.label,
            ...resolved.map((s) => format(valueOf(r, s))),
            format(rowTotal(r)),
          ])}
          numericColumns={[...resolved.map((_, i) => i + 1), resolved.length + 1]}
        />
      )}
    </figure>
  );
}
