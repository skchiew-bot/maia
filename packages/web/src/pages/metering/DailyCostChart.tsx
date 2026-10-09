import type { FxRateDTO, MeteringDayDTO } from '@aoc/contracts';
import { HitLayer, useElementWidth, type HitItem } from '../../charts';
import { cx } from '../../lib/dom';
import { formatInteger, formatMyr, formatShortDate, formatTokens, formatUsd } from '../../lib/format';
import { axisUsd, dayLabel, formatIdle, fxPointKind, fxStampText, niceAxis, rateCardBoundaries } from './meteringModel';

export interface DailyCostChartProps {
  /** Metered days, oldest first. */
  days: readonly MeteringDayDTO[];
  /** FX records by date, to flag carried-forward days that something failed on. */
  fxByDate?: ReadonlyMap<string, FxRateDTO>;
  /** Draw the actual subscription per day (team scope only). */
  showSubscription: boolean;
}

const LEFT = 52;
const TOP = 20;
const PLOT_H = 132;
const FX_H = 18;
const AXIS_H = 18;

/**
 * Metering hero: notional API-equivalent cost per day (columns) against the actual subscription per day (a
 * labelled step line on the same US$ axis — shown alongside, never added in). Open days are outlined, days with
 * unpriced usage carry a ⚠ mark, rate-card versions are marked where they took effect, and every day's FX stamp
 * sits under its column (● live, ○ carried forward, ⚠ carried forward after a failure, × missing).
 */
export function DailyCostChart({ days, fxByDate, showSubscription }: DailyCostChartProps) {
  const [ref, width] = useElementWidth<HTMLDivElement>(720);
  const n = days.length;
  const plotW = Math.max(40, width - LEFT);
  const slot = n > 0 ? plotW / n : plotW;
  const barW = Math.max(3, Math.min(24, slot * 0.68));
  const subs = days.map((d) => (showSubscription ? d.subscriptionUsd : null));
  const { top, step } = niceAxis(Math.max(...days.map((d) => d.notionalUsd), ...subs.map((s) => s ?? 0), 0));
  const y = (v: number) => TOP + PLOT_H - (Math.max(0, v) / top) * PLOT_H;
  const xMid = (i: number) => LEFT + i * slot + slot / 2;
  const base = TOP + PLOT_H;
  const fxY = base + FX_H / 2 + 1;
  const labelEvery = Math.max(1, Math.ceil(56 / slot));
  const peak = days.reduce((best, d, i) => (d.notionalUsd > (days[best]?.notionalUsd ?? -1) ? i : best), 0);
  const total = days.reduce((a, d) => a + d.notionalUsd, 0);
  const totalRm = days.every((d) => d.notionalRm !== null) ? days.reduce((a, d) => a + (d.notionalRm ?? 0), 0) : null;
  const today = days[n - 1];
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(Number(v.toPrecision(10)));

  // Subscription as a step line: one flat segment per day, joined where days are consecutive.
  let subPath = '';
  subs.forEach((s, i) => {
    if (s === null) return;
    const x0 = LEFT + i * slot;
    subPath += `${subs[i - 1] === null || i === 0 ? 'M' : 'L'}${x0.toFixed(1)},${y(s).toFixed(1)}H${(x0 + slot).toFixed(1)}`;
  });
  const lastSub = [...subs].reverse().find((s) => s !== null) ?? null;

  const hits: HitItem[] = days.map((d, i) => {
    const fx = fxByDate?.get(d.date);
    const lines = [
      `${formatUsd(d.notionalUsd)}${d.notionalRm !== null ? ` · ${formatMyr(d.notionalRm)}` : ''} notional`,
      d.status === 'open' ? 'Open day: still metering' : 'Closed rollup (frozen)',
      `FX ${d.fx.rate !== null ? d.fx.rate.toFixed(4) : '—'} ${fxStampText(d.fx)}${fx?.flagged ? ' (flagged)' : ''}`,
      `Rate card ${d.rateCardVersion > 0 ? `v${d.rateCardVersion}` : 'none'}`,
      ...(d.unpriced ? [`${formatTokens(d.unpricedTokens)} tokens unpriced (counted at US$0)`] : []),
      ...(subs[i] !== null ? [`Subscription ${formatUsd(subs[i]!)} actual`] : []),
      ...(d.throttleIdleMs > 0 ? [`Throttle idle ${formatIdle(d.throttleIdleMs)} · ${d.throttleHits} hit${d.throttleHits === 1 ? '' : 's'}`] : []),
    ];
    return {
      key: d.date,
      x: LEFT + i * slot,
      y: TOP,
      width: slot,
      height: PLOT_H + FX_H,
      label: `${dayLabel(d.date)}: ${lines.join('. ')}`,
      tooltip: (
        <>
          <span className="aoc-chart-tip__kind">{dayLabel(d.date)}</span>
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
      ? 'Daily notional cost: no metered days in this range.'
      : `Daily notional cost, ${formatShortDate(days[0]!.date)} to ${formatShortDate(today!.date)}: latest ${formatUsd(
          today!.notionalUsd,
        )}${today!.status === 'open' ? ' (open day)' : ''}, peak ${formatUsd(days[peak]!.notionalUsd)} on ${formatShortDate(
          days[peak]!.date,
        )}, total ${formatUsd(total)}${lastSub !== null ? `; subscription ${formatUsd(lastSub)} per day, actual` : ''}.`;

  return (
    <figure className="met-daily aoc-chart">
      <figcaption className="aoc-chart__stats">
        <span>
          {today?.status === 'open' ? 'Today (open)' : 'Latest'}{' '}
          <strong className="aoc-num">{today ? formatUsd(today.notionalUsd) : '—'}</strong>
        </span>
        <span>
          Peak <strong className="aoc-num">{n ? formatUsd(days[peak]!.notionalUsd) : '—'}</strong>
          {n > 0 && <span className="aoc-chart__stat-note"> {formatShortDate(days[peak]!.date)}</span>}
        </span>
        <span>
          Total <strong className="aoc-num">{formatUsd(total)}</strong>
          {totalRm !== null && <span className="aoc-chart__stat-note"> {formatMyr(totalRm)}</span>}
        </span>
        {lastSub !== null && (
          <span>
            Subscription <strong className="aoc-num">{formatUsd(lastSub)}</strong>
            <span className="aoc-chart__stat-note"> per day, actual</span>
          </span>
        )}
      </figcaption>
      <div className="aoc-chart__plot" ref={ref}>
        <svg
          width={width}
          height={TOP + PLOT_H + FX_H + AXIS_H}
          viewBox={`0 0 ${width} ${TOP + PLOT_H + FX_H + AXIS_H}`}
          role="img"
          aria-label={summary}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={LEFT} x2={width} y1={y(t) + 0.5} y2={y(t) + 0.5} className={t === 0 ? 'aoc-chart__baseline' : 'met-grid'} />
              <text x={LEFT - 6} y={y(t) + 4} textAnchor="end" className="aoc-chart__axis-label">
                {axisUsd(t)}
              </text>
            </g>
          ))}
          {rateCardBoundaries(days).map((b) => (
            <g key={`rc-${b.index}`}>
              <line x1={LEFT + b.index * slot} x2={LEFT + b.index * slot} y1={TOP - 14} y2={base} className="met-rc" />
              <text x={LEFT + b.index * slot + 3} y={TOP - 5} className="aoc-chart__axis-label">
                rate card v{b.version}
              </text>
            </g>
          ))}
          {days.map((d, i) => {
            const h = Math.max(0, base - y(d.notionalUsd));
            const x = xMid(i) - barW / 2;
            const r = Math.min(4, barW / 2, h);
            return (
              <g key={d.date}>
                {h > 0 && (
                  <path
                    d={`M${x},${base}V${base - h + r}Q${x},${base - h} ${x + r},${base - h}H${x + barW - r}Q${x + barW},${base - h} ${x + barW},${base - h + r}V${base}Z`}
                    className={cx('met-day__bar', d.status === 'open' && 'is-open')}
                  />
                )}
                {d.unpriced && (
                  <path
                    d={`M${xMid(i)},${base - h - 13}l5,8h-10z`}
                    className="met-day__unpriced"
                  />
                )}
                <FxMark kind={fxKind(d, fxByDate?.get(d.date))} x={xMid(i)} y={fxY} />
                {(i % labelEvery === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= labelEvery / 2) && (
                  <text x={xMid(i)} y={base + FX_H + 13} textAnchor="middle" className="aoc-chart__axis-label">
                    {formatShortDate(d.date)}
                  </text>
                )}
              </g>
            );
          })}
          {subPath && <path d={subPath} className="met-subline" />}
          {n > 0 && days[peak]!.notionalUsd > 0 && (
            <text x={xMid(peak)} y={y(days[peak]!.notionalUsd) - (days[peak]!.unpriced ? 16 : 4)} textAnchor="middle" className="aoc-chart__value">
              {formatUsd(days[peak]!.notionalUsd)}
            </text>
          )}
        </svg>
        <HitLayer items={hits} label="Daily notional cost: days" width={width} height={TOP + PLOT_H + FX_H} minSize={20} />
      </div>
      <ul className="met-legend" aria-label="Chart legend">
        <li>
          <span className="met-sw met-sw--bar" aria-hidden="true" /> Notional cost per day
        </li>
        <li>
          <span className="met-sw met-sw--open" aria-hidden="true" /> Open day, still metering
        </li>
        {showSubscription && (
          <li>
            <span className="met-sw met-sw--sub" aria-hidden="true" /> Subscription per day (actual money)
          </li>
        )}
        <li>
          <span className="met-sw met-sw--warn" aria-hidden="true" /> Unpriced usage (US$0)
        </li>
        <li>
          FX: <span className="met-fx met-fx--live" aria-hidden="true" /> live <span className="met-fx met-fx--carried" aria-hidden="true" /> carried forward{' '}
          <span className="met-fx met-fx--flagged" aria-hidden="true" /> after a failure <span className="met-fx-x" aria-hidden="true">×</span> missing
        </li>
        <li className="met-legend__note aoc-num">
          {formatInteger(days.filter((d) => d.status === 'closed').length)} closed · {formatInteger(days.filter((d) => d.status === 'open').length)} open
        </li>
      </ul>
    </figure>
  );
}

type DayFx = 'live' | 'carried' | 'flagged' | 'missing';

/** The rollup's own stamp, refined by the FX record when loaded (an Approver-set rate counts as confirmed). */
function fxKind(d: MeteringDayDTO, record: FxRateDTO | undefined): DayFx {
  if (d.fx.status === 'missing' || d.fx.rate === null) return 'missing';
  if (record) {
    const k = fxPointKind(record);
    return k === 'manual' ? 'live' : k;
  }
  return d.fx.status === 'live' ? 'live' : 'carried';
}

function FxMark({ kind, x, y }: { kind: DayFx; x: number; y: number }) {
  if (kind === 'missing')
    return <path d={`M${x - 3},${y - 3}l6,6M${x + 3},${y - 3}l-6,6`} className="met-fx-svg met-fx-svg--missing" />;
  return <circle cx={x} cy={y} r={3} className={`met-fx-svg met-fx-svg--${kind}`} />;
}
