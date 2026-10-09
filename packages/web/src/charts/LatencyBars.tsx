import { cx } from '../lib/dom';
import { formatDuration, formatInteger } from '../lib/format';
import { Icon } from '../components/Icon';
import { estimateTextWidth, useElementWidth } from './shared';

export interface LatencyRow {
  id: string;
  /** Category ("Fix-plan sign-off", "Rollback approval"). */
  label: string;
  /** Median latency (ms). */
  p50Ms: number;
  /** 90th-percentile latency (ms). */
  p90Ms: number;
  /** Service-level target (ms); draws the SLA marker. */
  slaMs?: number;
  /** Items that exceeded the SLA in the period. */
  breaches?: number;
  /** Items measured (context). */
  total?: number;
}

export interface LatencyBarsProps {
  rows: readonly LatencyRow[];
  /** What is timed ("Decision latency") — names the summary. */
  label: string;
  /** Duration formatter. Default `2h 14m` style. */
  format?: (ms: number) => string;
  className?: string;
}

const TRACK_H = 14;
const P50_H = 6;

/**
 * p50/p90 per category as bullet bars on one shared time scale: the wide light bar is p90, the narrow solid
 * bar p50, the vertical rule the SLA. p90 beyond the SLA turns danger-tinted; breaches are counted in words.
 */
export function LatencyBars({ rows, label, format = formatDuration, className }: LatencyBarsProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(640);
  const narrow = width < 560;
  const labelCol = narrow ? 0 : Math.min(200, Math.max(120, Math.round(width * 0.22)));
  const statsCol = narrow ? 0 : 168;
  const barsW = Math.max(60, width - labelCol - statsCol - (narrow ? 0 : 24));
  const max = Math.max(1, ...rows.flatMap((r) => [r.p90Ms, r.p50Ms, r.slaMs ?? 0])) * 1.06;
  const x = (ms: number) => (Math.max(0, ms) / max) * barsW;

  const summary = `${label}: ${rows
    .map(
      (r) =>
        `${r.label} — p50 ${format(r.p50Ms)}, p90 ${format(r.p90Ms)}${r.slaMs !== undefined ? `, SLA ${format(r.slaMs)}` : ''}${
          r.breaches !== undefined ? `, ${formatInteger(r.breaches)} over SLA` : ''
        }`,
    )
    .join('; ')}.`;

  return (
    <figure
      className={cx('aoc-chart', 'aoc-latency', narrow && 'is-narrow', className)}
      role="img"
      aria-label={summary}
      ref={ref}
    >
      <div className="aoc-legend aoc-latency__legend" aria-hidden="true">
        <span className="aoc-legend__item">
          <span className="aoc-legend__swatch aoc-latency__swatch-p50" />
          p50
        </span>
        <span className="aoc-legend__item">
          <span className="aoc-legend__swatch aoc-latency__swatch-p90" />
          p90
        </span>
        <span className="aoc-legend__item">
          <span className="aoc-latency__swatch-sla" />
          SLA
        </span>
        <span className="aoc-legend__item">
          <span className="aoc-legend__swatch aoc-latency__swatch-over" />
          p90 over SLA
        </span>
      </div>
      <div className="aoc-latency__rows" aria-hidden="true">
        {rows.map((r) => {
          const sla = r.slaMs;
          const within = sla === undefined ? r.p90Ms : Math.min(r.p90Ms, sla);
          const slaLabel = sla !== undefined ? `SLA ${format(sla)}` : '';
          const slaX = sla !== undefined ? x(sla) : 0;
          const slaAnchor = slaX + estimateTextWidth(slaLabel) / 2 > barsW ? 'end' : 'middle';
          return (
            <div
              key={r.id}
              className="aoc-latency__row"
              style={{ gridTemplateColumns: narrow ? '1fr' : `${labelCol}px ${barsW}px ${statsCol}px` }}
            >
              <div className="aoc-latency__label">
                <span className="aoc-latency__name">{r.label}</span>
                {r.total !== undefined && (
                  <span className="aoc-latency__total aoc-num">{formatInteger(r.total)} measured</span>
                )}
              </div>
              <svg
                width={barsW}
                height={TRACK_H + 14}
                viewBox={`0 0 ${barsW} ${TRACK_H + 14}`}
                className="aoc-latency__svg"
              >
                <rect x={0} y={12} width={x(within)} height={TRACK_H} rx={2} className="aoc-latency__p90" />
                {sla !== undefined && r.p90Ms > sla && (
                  <rect
                    x={x(sla)}
                    y={12}
                    width={x(r.p90Ms) - x(sla)}
                    height={TRACK_H}
                    rx={2}
                    className="aoc-latency__over"
                  />
                )}
                <rect
                  x={0}
                  y={12 + (TRACK_H - P50_H) / 2}
                  width={x(r.p50Ms)}
                  height={P50_H}
                  rx={1.5}
                  className="aoc-latency__p50"
                />
                {sla !== undefined && (
                  <>
                    <line x1={slaX} x2={slaX} y1={9} y2={12 + TRACK_H + 2} className="aoc-latency__sla" />
                    <text x={slaX} y={8} textAnchor={slaAnchor} className="aoc-chart__axis-label">
                      {slaLabel}
                    </text>
                  </>
                )}
              </svg>
              <div className="aoc-latency__stats">
                <span className="aoc-num">
                  p50 <strong>{format(r.p50Ms)}</strong> · p90 <strong>{format(r.p90Ms)}</strong>
                </span>
                {r.breaches !== undefined && (
                  <span className={cx('aoc-latency__breach', r.breaches > 0 ? 'is-breached' : 'is-clear')}>
                    <Icon name={r.breaches > 0 ? 'danger' : 'ok'} size={12} />
                    {r.breaches > 0 ? `${formatInteger(r.breaches)} over SLA` : 'within SLA'}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </figure>
  );
}
