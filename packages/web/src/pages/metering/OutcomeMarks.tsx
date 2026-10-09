import type { CSSProperties } from 'react';
import { Icon } from '../../components';
import { cx } from '../../lib/dom';
import {
  axisPct,
  outcomeCount,
  outcomeRm,
  outcomeUsd,
  rangeText,
  type OutcomeAxis,
  type OutcomeClassView,
} from './outcomeModel';
import { axisUsd } from './meteringModel';

export interface OutcomeMarksProps {
  classes: readonly OutcomeClassView[];
  axis: OutcomeAxis;
  /** RM per US$ for the range (see `blendedRate`), or null when the daemon gave none. */
  rate: number | null;
}

const at = (pct: number) => ({ '--x': `${pct}%` }) as CSSProperties;
const between = (a: number, b: number) => ({ '--x0': `${a}%`, '--x1': `${b}%` }) as CSSProperties;

function MarkRow({ view, axis, rate }: { view: OutcomeClassView; axis: OutcomeAxis; rate: number | null }) {
  const { info, stats } = view;
  const empty = stats.count === 0;
  const pct = (usd: number | null) => axisPct(usd ?? 0, axis.top);
  const median = stats.medianUsd ?? 0;
  const p90 = stats.p90Usd ?? median;
  const rm = (usd: number) => outcomeRm(usd, rate);
  return (
    <li className={cx('met-out__row', empty && 'is-empty')}>
      <div className="met-out__who">
        <span className="met-out__name">{info.label}</span>
        {empty ? (
          <span className="met-out__n">None in this range</span>
        ) : (
          <>
            <span className="met-out__n aoc-num">
              {outcomeCount(stats.count)} · {outcomeUsd(stats.totalUsd)} total
            </span>
            {rm(stats.totalUsd) && <span className="met-sub aoc-num">{rm(stats.totalUsd)}</span>}
          </>
        )}
        {view.unpriced > 0 && (
          <span className="met-flag">
            <Icon name="warn" size={12} />
            {view.unpriced} of {stats.count} include unpriced usage
          </span>
        )}
      </div>
      {/* The marks repeat the numbers beside them; they are for the eye. */}
      <div className="met-out__plot" aria-hidden="true">
        {axis.ticks.map((t) => (
          <span key={t} className="met-out__grid" style={at(pct(t))} />
        ))}
        {!empty && (
          <>
            <span className="met-out__whisker" style={between(pct(stats.minUsd), pct(stats.maxUsd))} />
            <span className="met-out__band" style={between(pct(median), pct(p90))} />
            <span className="met-out__median" style={at(pct(median))} />
          </>
        )}
      </div>
      {empty ? (
        <p className="met-out__none">{info.none}</p>
      ) : (
        <dl className="met-out__nums aoc-num">
          <div>
            <dt>Median</dt>
            <dd>
              <b>{outcomeUsd(median)}</b>
              {rm(median) && <span className="met-sub-inline"> {rm(median)}</span>}
            </dd>
          </div>
          <div>
            <dt>p90</dt>
            <dd>
              <b>{outcomeUsd(p90)}</b>
              {rm(p90) && <span className="met-sub-inline"> {rm(p90)}</span>}
            </dd>
          </div>
          <div>
            <dt>{stats.count === 1 ? 'Cost' : 'Range'}</dt>
            <dd>{rangeText(stats)}</dd>
          </div>
        </dl>
      )}
    </li>
  );
}

/**
 * Notional cost per outcome (§14.4), one row per kind on one shared US$ scale. Each row is a range mark: the
 * median (tick) with the p50 to p90 range (band), and the lowest to highest cost as a thin line. Every figure is
 * printed beside its mark, so the marks add shape and nothing else. Rows are in a fixed order and nothing ranks.
 */
export function OutcomeMarks({ classes, axis, rate }: OutcomeMarksProps) {
  return (
    <figure className="met-out">
      <ul className="met-out__rows" aria-label="Notional cost per outcome, by kind">
        {classes.map((c) => (
          <MarkRow key={c.info.key} view={c} axis={axis} rate={rate} />
        ))}
      </ul>
      <div className="met-out__axis" aria-hidden="true">
        <span />
        <div className="met-out__ticks">
          {axis.ticks.map((t) => (
            <span key={t} style={at(axisPct(t, axis.top))}>
              {axisUsd(t)}
            </span>
          ))}
        </div>
        <span />
      </div>
      <ul className="met-legend" aria-hidden="true">
        <li>
          <span className="met-sw met-sw--median" /> median
        </li>
        <li>
          <span className="met-sw met-sw--p90" /> p50 to p90
        </li>
        <li>
          <span className="met-sw met-sw--spread" /> lowest to highest
        </li>
        <li className="met-legend__note aoc-num">one scale: {axisUsd(0)} to {axisUsd(axis.top)}</li>
      </ul>
    </figure>
  );
}
