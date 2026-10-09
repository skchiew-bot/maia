import type { FxRateDTO } from '@aoc/contracts';
import { ChartTable, HitLayer, useElementWidth, type HitItem } from '../../charts';
import { formatShortDate } from '../../lib/format';
import { dayLabel, fxExtractorText, fxPointKind, fxReasonText, fxSessionLabel, type FxPointKind } from './meteringModel';

export interface FxHistoryChartProps {
  /** Rates in the range, oldest first. */
  rates: readonly FxRateDTO[];
  /** Dates with a discrepancy ticket (open or resolved). */
  discrepancyDates?: ReadonlySet<string>;
}

const LEFT = 52;
const TOP = 14;
const PLOT_H = 112;
const AXIS_H = 18;

const KIND_WORD: Record<FxPointKind, string> = {
  live: 'fetched live',
  carried: 'carried forward',
  flagged: 'carried forward after a failure',
  manual: 'set by an Approver',
};

/**
 * USD→MYR by day (§10): a step line (a carried-forward day holds the previous rate), live days as filled dots,
 * carried-forward days hollow, days carried forward after a failure in the warning colour with a ⚠, and
 * discrepancy days with a decision diamond. The y-axis is zoomed to the range, so it is labelled to 4 dp.
 */
export function FxHistoryChart({ rates, discrepancyDates }: FxHistoryChartProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(720);
  const n = rates.length;
  const values = rates.map((r) => r.rate);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max((hi - lo) * 0.15, 0.002);
  const yMin = lo - pad;
  const yMax = hi + pad;
  const plotW = Math.max(40, width - LEFT - 8);
  const x = (i: number) => LEFT + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => TOP + PLOT_H - ((v - yMin) / (yMax - yMin || 1)) * PLOT_H;
  const ticks = [lo, (lo + hi) / 2, hi];
  const labelEvery = Math.max(1, Math.ceil(64 / (plotW / Math.max(1, n - 1))));

  let path = '';
  rates.forEach((r, i) => {
    path += i === 0 ? `M${x(0).toFixed(1)},${y(r.rate).toFixed(1)}` : `H${x(i).toFixed(1)}V${y(r.rate).toFixed(1)}`;
  });

  const describe = (r: FxRateDTO) => {
    const session = fxSessionLabel(r.session);
    return [
      `${r.rate.toFixed(4)} ${KIND_WORD[fxPointKind(r)]}`,
      r.status === 'inherited' ? `from ${formatShortDate(r.sourceDate)}` : null,
      fxReasonText(r.reason),
      r.extractor !== 'none' ? `by ${fxExtractorText(r.extractor)}` : null,
      session ? `BNM ${session}` : null,
      r.closed ? 'day closed' : 'day open',
      discrepancyDates?.has(r.date) ? 'discrepancy ticket' : null,
    ].filter(Boolean) as string[];
  };

  const hits: HitItem[] = rates.map((r, i) => {
    const lines = describe(r);
    const slot = n <= 1 ? plotW : plotW / (n - 1);
    return {
      key: r.date,
      x: x(i) - slot / 2,
      y: TOP,
      width: slot,
      height: PLOT_H,
      label: `${dayLabel(r.date)}: ${lines.join(', ')}`,
      tooltip: (
        <>
          <span className="aoc-chart-tip__kind">{dayLabel(r.date)}</span>
          <strong className="aoc-num">{lines[0]}</strong>
          {lines.slice(1).map((l) => (
            <span key={l} className="aoc-chart-tip__meta">
              {l}
            </span>
          ))}
        </>
      ),
    };
  });

  const summary =
    n === 0
      ? 'USD to MYR: no rates recorded in this range.'
      : `USD to MYR, ${formatShortDate(rates[0]!.date)} to ${formatShortDate(rates[n - 1]!.date)}: latest ${rates[
          n - 1
        ]!.rate.toFixed(4)}, low ${lo.toFixed(4)}, high ${hi.toFixed(4)}; ${rates.filter((r) => r.status === 'inherited').length} carried-forward days, ${
          rates.filter((r) => r.flagged).length
        } flagged.`;

  return (
    <figure className="met-fxchart aoc-chart">
      <div className="aoc-chart__plot" ref={ref}>
        <svg width={width} height={TOP + PLOT_H + AXIS_H} viewBox={`0 0 ${width} ${TOP + PLOT_H + AXIS_H}`} role="img" aria-label={summary}>
          {ticks.map((t, i) => (
            <g key={i}>
              <line x1={LEFT} x2={LEFT + plotW} y1={y(t) + 0.5} y2={y(t) + 0.5} className="met-grid" />
              <text x={LEFT - 6} y={y(t) + 4} textAnchor="end" className="aoc-chart__axis-label">
                {t.toFixed(4)}
              </text>
            </g>
          ))}
          {path && <path d={path} className="met-fxline" />}
          {rates.map((r, i) => {
            const kind = fxPointKind(r);
            const cx = x(i);
            const cy = y(r.rate);
            return (
              <g key={r.date}>
                {kind === 'manual' ? (
                  <rect x={cx - 4} y={cy - 4} width={8} height={8} className="met-fxpt met-fxpt--manual" />
                ) : (
                  <circle cx={cx} cy={cy} r={kind === 'live' ? 3.5 : 4} className={`met-fxpt met-fxpt--${kind}`} />
                )}
                {kind === 'flagged' && <path d={`M${cx},${cy - 16}l5,8h-10z`} className="met-day__unpriced" />}
                {discrepancyDates?.has(r.date) && (
                  <path d={`M${cx},${cy + 7}l5,5l-5,5l-5,-5z`} className="met-fxpt--decision" />
                )}
                {(i % labelEvery === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= labelEvery / 2) && (
                  <text x={cx} y={TOP + PLOT_H + 14} textAnchor="middle" className="aoc-chart__axis-label">
                    {formatShortDate(r.date)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        <HitLayer items={hits} label="USD to MYR: days" width={width} height={TOP + PLOT_H} minSize={16} />
      </div>
      <ul className="met-legend" aria-label="Chart legend">
        <li>
          <span className="met-fx met-fx--live" aria-hidden="true" /> Fetched live
        </li>
        <li>
          <span className="met-fx met-fx--carried" aria-hidden="true" /> Carried forward (weekend, holiday)
        </li>
        <li>
          <span className="met-fx met-fx--flagged" aria-hidden="true" /> Carried forward after a failure
        </li>
        <li>
          <span className="met-fx met-fx--manual" aria-hidden="true" /> Set by an Approver
        </li>
        <li>
          <span className="met-fx met-fx--decision" aria-hidden="true" /> Discrepancy ticket
        </li>
      </ul>
      <ChartTable
        caption="USD to MYR by day with FX stamps"
        columns={['Day', 'Rate', 'Stamp', 'Source date', 'BNM session', 'Extractor', 'Rollup']}
        rows={[...rates].reverse().map((r) => [
          dayLabel(r.date),
          r.rate.toFixed(4),
          KIND_WORD[fxPointKind(r)],
          formatShortDate(r.sourceDate),
          fxSessionLabel(r.session) ?? 'not recorded',
          fxExtractorText(r.extractor),
          r.closed ? 'closed' : 'open',
        ])}
        numericColumns={[1]}
      />
    </figure>
  );
}
