import { Link } from 'react-router-dom';
import type { TowerFleet } from '@aoc/contracts';
import {
  ButtonLink,
  Icon,
  LIVENESS_META,
  LivenessBadge,
  Widget,
  formatAge,
  formatClock,
  livenessColors,
  type LivenessState,
} from '../../components';
import { cx } from '../../lib/dom';
import { niceCeil } from './towerModel';

type LiveState = Exclude<LivenessState, 'ended' | 'retired'>;

/** Badge order follows §4 precedence: what needs a human first. */
const COUNT_ORDER: readonly LiveState[] = ['waiting_on_you', 'throttled', 'dead', 'stalled', 'thinking', 'working'];
/** Trend panels read healthy → needs-you, as in the approved mock. */
const TREND_ORDER: readonly LiveState[] = ['working', 'thinking', 'stalled', 'dead', 'throttled', 'waiting_on_you'];

/** Stall rate is drawn on a 0–25% scale unless it runs past it. */
const STALL_SCALE_PCT = 25;

function pctText(pct: number): string {
  return `${pct < 10 && !Number.isInteger(pct) ? pct.toFixed(1) : Math.round(pct)}%`;
}

/** Live sessions by liveness (badges + counts), the 2-hour trend per state, and the fleet's friction numbers. */
export function FleetPanel({ fleet }: { fleet: TowerFleet }) {
  const live = COUNT_ORDER.reduce((n, s) => n + (fleet.byLiveness[s] ?? 0), 0);
  const peak = Math.max(1, ...fleet.trend.flatMap((b) => TREND_ORDER.map((s) => b[s] ?? 0)));
  const scaleMax = niceCeil(peak, 2);
  const stallScale = Math.max(STALL_SCALE_PCT, Math.ceil(fleet.stallRatePct));
  return (
    <Widget
      title="Fleet health"
      subtitle={`${live} live ${live === 1 ? 'session' : 'sessions'} · ${fleet.byLiveness.ended_today} ended today`}
      actions={
        <ButtonLink variant="ghost" size="sm" to="/console" iconAfter="chevron-right">
          Console
        </ButtonLink>
      }
      className="tower-fleet"
    >
      <ul className="tower-fleet__counts" aria-label="Live sessions by liveness">
        {COUNT_ORDER.map((s) => {
          const n = fleet.byLiveness[s] ?? 0;
          return (
            <li key={s} className={cx(n === 0 && 'is-zero')}>
              <LivenessBadge state={s} size="sm" />
              <b className="aoc-num">{n}</b>
            </li>
          );
        })}
      </ul>
      {fleet.trend.length > 0 ? (
        <div className="tower-fleet__trend">
          <h3 className="tower-minihead">
            Last 2 hours · 5-minute buckets · same 0–<span className="aoc-num">{scaleMax}</span> scale
          </h3>
          <div className="tower-fm-grid">
            {TREND_ORDER.map((s) => (
              <TrendChart
                key={s}
                state={s}
                values={fleet.trend.map((b) => b[s] ?? 0)}
                from={fleet.trend[0]!.at}
                to={fleet.trend[fleet.trend.length - 1]!.at}
                max={scaleMax}
              />
            ))}
          </div>
        </div>
      ) : (
        <p className="tower-note">No liveness history in the last 2 hours yet.</p>
      )}
      <ul className="tower-fstats">
        <li className="tower-fst">
          <p className="tower-fst__k">Stall rate</p>
          <p className="tower-fst__v">
            <b className="aoc-num">{pctText(fleet.stallRatePct)}</b>
            <span>
              {fleet.byLiveness.stalled} of {live} live
            </span>
          </p>
          <div className="tower-fst__viz">
            <div
              className="tower-bullet tower-bullet--sm"
              role="img"
              aria-label={`Stall rate ${pctText(fleet.stallRatePct)} on a 0 to ${stallScale}% scale.`}
            >
              <span
                className="tower-bullet__bar"
                style={{ width: `${Math.min(100, (fleet.stallRatePct / stallScale) * 100)}%` }}
              />
            </div>
            <p className="tower-fst__note">Stalled = alive but silent past the 10-minute threshold · scale 0–{stallScale}%</p>
          </div>
        </li>
        <li className="tower-fst">
          <p className="tower-fst__k">
            <Link to="/metering">Lost to throttling today</Link>
          </p>
          <p className="tower-fst__v">
            <b className="aoc-num">{formatAge(fleet.throttleLostMsToday)}</b>
            <span>{fleet.byLiveness.throttled} throttled now</span>
          </p>
          <p className="tower-fst__viz tower-fst__note">
            Plan-limit idle time, metered for the Enterprise migration case (§10).
          </p>
        </li>
        <li className="tower-fst">
          <p className="tower-fst__k">Rollover pressure</p>
          <p className="tower-fst__v">
            <b className="aoc-num">{fleet.rolloverPressure}</b>
            <span>
              {fleet.rolloverPressure === 1 ? 'session' : 'sessions'} above 60% of context
            </span>
          </p>
          <p className="tower-fst__viz tower-fst__note">
            Rolled over with a handoff brief at the next clean task boundary (§5).
          </p>
        </li>
      </ul>
    </Widget>
  );
}

const VIEW_W = 120;
const VIEW_H = 24;
const BASELINE = 22.5;
const PLOT_H = 20;

function TrendChart({
  state,
  values,
  from,
  to,
  max,
}: {
  state: LiveState;
  values: readonly number[];
  from: string;
  to: string;
  max: number;
}) {
  const meta = LIVENESS_META[state];
  const slot = VIEW_W / Math.max(1, values.length);
  const barW = slot * 0.72;
  const latest = values[values.length - 1] ?? 0;
  const summary = `${meta.word} sessions per 5-minute bucket, ${formatClock(from)} to ${formatClock(to)}: ${values.join(
    ', ',
  )}. Now ${latest}.`;
  return (
    <figure className="tower-fm">
      <figcaption>
        <span className="tower-fm__ic" style={{ color: livenessColors(meta.tone).fg }}>
          <Icon name={meta.icon} size={12} />
        </span>
        {meta.word}
        <b className="aoc-num">{latest}</b>
      </figcaption>
      <svg className="tower-fm__chart" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} role="img" aria-label={summary}>
        <line className="tower-fm__base" x1={0} y1={BASELINE} x2={VIEW_W} y2={BASELINE} />
        {values.map((v, i) => {
          if (v <= 0) return null;
          const h = Math.max(1.2, (Math.min(v, max) / max) * PLOT_H);
          return (
            <rect
              key={i}
              className={i === values.length - 1 ? 'is-now' : undefined}
              x={i * slot + (slot - barW) / 2}
              y={BASELINE - 0.5 - h}
              width={barW}
              height={h}
            />
          );
        })}
      </svg>
    </figure>
  );
}
