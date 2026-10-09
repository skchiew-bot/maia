import { cx } from '../lib/dom';
import { formatInteger, formatPercent, formatUsd } from '../lib/format';
import { barPath, estimateTextWidth, useElementWidth } from './shared';
import type { PairedBarRow, ValueFormatter } from './types';

export interface PairedBarsProps {
  rows: readonly PairedBarRow[];
  /** Name for the accessible summary. Default "Discovery vs execution cost per run". */
  label?: string;
  /** Value formatter. Default US$ with 2 decimals. */
  format?: ValueFormatter;
  /** Series names. Default Discovery / Execution. */
  seriesLabels?: { discovery: string; execution: string };
  className?: string;
}

const BAR_H = 10;
const BAR_GAP = 2;
const ROW_PAD = 6;

/**
 * Registry hero (§12): per process type, what a discovery-class run costs (series-1) next to its distilled
 * execution run (series-2) on one shared scale, with the saving as a percentage. Every value is printed.
 */
export function PairedBars({
  rows,
  label = 'Discovery vs execution cost per run',
  format = (v) => formatUsd(v),
  seriesLabels = { discovery: 'Discovery', execution: 'Execution' },
  className,
}: PairedBarsProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(640);
  const narrow = width < 520;
  const labelCol = narrow ? 0 : Math.min(200, Math.max(110, Math.round(width * 0.24)));
  const savingCol = 84;
  const barsW = Math.max(80, width - labelCol - savingCol - (narrow ? 12 : 24));
  const maxV = Math.max(1e-9, ...rows.flatMap((r) => [r.discovery, r.execution]));
  const valueRoom = estimateTextWidth(format(maxV)) + 8;
  const plotW = Math.max(20, barsW - valueRoom);
  const scale = (v: number) => (Math.max(0, v) / maxV) * plotW;
  const rowSvgH = BAR_H * 2 + BAR_GAP;

  const saving = (r: PairedBarRow) => (r.discovery > 0 ? 1 - r.execution / r.discovery : Number.NaN);
  const savingText = (r: PairedBarRow) => {
    const s = saving(r);
    if (!Number.isFinite(s)) return '—';
    return s >= 0 ? `${formatPercent(s)} saved` : `${formatPercent(-s)} more`;
  };

  const summary = `${label}: ${rows
    .map(
      (r) =>
        `${r.label} — ${seriesLabels.discovery.toLowerCase()} ${format(r.discovery)}, ${seriesLabels.execution.toLowerCase()} ${format(
          r.execution,
        )}, ${savingText(r)}${r.runs !== undefined ? ` over ${formatInteger(r.runs)} runs` : ''}`,
    )
    .join('; ')}.`;

  return (
    <figure
      className={cx('aoc-chart', 'aoc-paired', narrow && 'is-narrow', className)}
      role="img"
      aria-label={summary}
      ref={ref}
    >
      <div className="aoc-legend aoc-paired__legend" aria-hidden="true">
        <span className="aoc-legend__item">
          <span className="aoc-legend__swatch" style={{ background: 'var(--series-1)' }} />
          {seriesLabels.discovery}
        </span>
        <span className="aoc-legend__item">
          <span className="aoc-legend__swatch" style={{ background: 'var(--series-2)' }} />
          {seriesLabels.execution}
        </span>
        <span className="aoc-paired__legend-note">cost per run, one scale</span>
      </div>
      <div className="aoc-paired__rows" aria-hidden="true">
        {rows.map((r) => (
          <div
            key={r.id}
            className="aoc-paired__row"
            style={{
              gridTemplateColumns: narrow ? `1fr ${savingCol}px` : `${labelCol}px 1fr ${savingCol}px`,
            }}
          >
            <div className="aoc-paired__label">
              <span className="aoc-paired__name">{r.label}</span>
              {r.runs !== undefined && (
                <span className="aoc-paired__runs aoc-num">{formatInteger(r.runs)} runs</span>
              )}
            </div>
            <svg
              width={barsW}
              height={rowSvgH + ROW_PAD}
              viewBox={`0 0 ${barsW} ${rowSvgH + ROW_PAD}`}
              className="aoc-paired__svg"
            >
              <path
                d={barPath(0, ROW_PAD / 2, scale(r.discovery), BAR_H, 3)}
                style={{ fill: 'var(--series-1)' }}
              />
              <text x={scale(r.discovery) + 6} y={ROW_PAD / 2 + BAR_H - 1} className="aoc-chart__value">
                {format(r.discovery)}
              </text>
              <path
                d={barPath(0, ROW_PAD / 2 + BAR_H + BAR_GAP, scale(r.execution), BAR_H, 3)}
                style={{ fill: 'var(--series-2)' }}
              />
              <text
                x={scale(r.execution) + 6}
                y={ROW_PAD / 2 + BAR_H * 2 + BAR_GAP - 1}
                className="aoc-chart__value"
              >
                {format(r.execution)}
              </text>
            </svg>
            <div className={cx('aoc-paired__saving', saving(r) < 0 && 'is-worse')}>
              <strong className="aoc-num">{savingText(r).split(' ')[0]}</strong>
              <span>{savingText(r).split(' ').slice(1).join(' ')}</span>
            </div>
          </div>
        ))}
      </div>
    </figure>
  );
}
