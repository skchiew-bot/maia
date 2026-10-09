import type { SessionSummary } from '@aoc/contracts';
import { useId } from 'react';
import { Link } from 'react-router-dom';
import { Sparkline } from '../../charts/Sparkline';
import { Chip } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { AliveIndicator } from '../../components/liveness/AliveIndicator';
import { LivenessBadge } from '../../components/liveness/LivenessBadge';
import { Money } from '../../components/Money';
import { cx } from '../../lib/dom';
import { formatClock, formatInteger, formatPercent } from '../../lib/format';
import { ContextMeter } from '../sessions/ContextMeter';
import { impliedWindow } from '../sessions/processTypes';
import { etaText, livenessDetail, modelLabel, phaseLabel, sessionLiveness } from '../sessions/sessionText';
import { FLAT_AFTER_MINUTES } from './model';

export interface SessionTileProps {
  session: SessionSummary;
  /** Shared sparkline maximum across the grid. */
  apmMax: number;
  rolloverPct: number;
  /** Latest activity event seq for this session (one pulse per change). */
  activitySeq: number | undefined;
  now: number;
}

/**
 * One small multiple: liveness badge, actions-per-minute sparkline on the shared scale, weighted progress,
 * context pressure and today's notional cost. Every chart prints its number.
 */
export function SessionTile({ session: s, apmMax, rolloverPct, activitySeq, now }: SessionTileProps) {
  const titleId = useId();
  const state = sessionLiveness(s);
  const detail = livenessDetail(s, now);
  const observed = s.mode === 'observed';
  const model = modelLabel(s.model);
  const phase = phaseLabel(s.currentPhase);
  const p = s.progress;
  const weighted = p && p.totalWeight > 0 ? p.doneWeight / p.totalWeight : 0;
  const apmNow = state === 'dead' ? null : s.apm.current;
  const lastActivity = s.lastActivityAt ? `last activity ${formatClock(s.lastActivityAt)}` : 'no activity yet';

  return (
    <li className={cx('console-tile', `console-tile--${state}`)}>
      <article aria-labelledby={titleId}>
        <div className="console-tile__top">
          <h3 id={titleId} className="console-tile__name">
            <Link to={`/sessions/${encodeURIComponent(s.sessionId)}`} className="console-tile__link">
              {s.title}
            </Link>
          </h3>
          <div className="console-tile__chips">
            {s.processType && <Chip>{s.processType}</Chip>}
            {model && <Chip className="console-chip--model">{model}</Chip>}
          </div>
        </div>
        <p className="console-tile__ctx">
          {s.projectName ?? 'No project'}
          {phase && <> · {phase}</>}
        </p>

        <div className="console-tile__state">
          <LivenessBadge
            state={state}
            size="sm"
            title={s.liveness?.reason}
            detail={
              s.openDecision && state === 'waiting_on_you' ? (
                <Link
                  to={`/decisions#${encodeURIComponent(s.openDecision.decisionId)}`}
                  className="console-tile__decision"
                >
                  {detail}
                </Link>
              ) : (
                detail
              )
            }
          />
          {state !== 'dead' && (
            <AliveIndicator
              activitySeq={activitySeq}
              state={state}
              label={lastActivity}
            />
          )}
          <span className="console-tile__owner">
            {observed ? (
              <>
                <Icon name="eye" size={12} /> observed · read-only
              </>
            ) : (
              (s.ownerName ?? 'Unassigned')
            )}
          </span>
        </div>

        <div className="console-tile__act">
          <Sparkline
            values={s.apm.points}
            label={`${s.title}, actions per minute over the last ${s.apm.windowMinutes} minutes`}
            unit="APM"
            tone="muted"
            yMax={apmMax}
            height={36}
            showValue={false}
            flatAfter={FLAT_AFTER_MINUTES}
            liveness={state}
            className="console-tile__spark"
          />
          <p className="console-tile__apm">
            <span className="console-tile__apm-value aoc-num">{apmNow === null ? '—' : formatInteger(apmNow)}</span>
            <span className="console-tile__apm-unit">APM now</span>
          </p>
        </div>

        <dl className="console-tile__stats">
          <div className="console-stat">
            <dt>Tasks</dt>
            {p ? (
              <>
                <dd className="console-stat__value">
                  <span className="aoc-num">
                    {formatInteger(p.doneTasks)}/{formatInteger(p.totalTasks)}
                  </span>
                  <span className="console-stat__pct aoc-num">{formatPercent(weighted)}</span>
                  {p.flaggedTasks > 0 && (
                    <span className="console-stat__flag" title="Closed with no file change or unverified evidence">
                      <Icon name="warn" size={12} />
                      <span className="aoc-num">{p.flaggedTasks}</span>
                      <span className="aoc-sr-only"> flagged</span>
                    </span>
                  )}
                </dd>
                <dd className="console-stat__bar">
                  <span
                    className="console-meter"
                    role="img"
                    aria-label={`${formatPercent(weighted)} of declared weight done (${p.doneWeight} of ${p.totalWeight})`}
                  >
                    <span className="console-meter__fill" style={{ width: `${weighted * 100}%` }} />
                  </span>
                </dd>
                <dd className="console-stat__sub">{etaText(p, state, now)}</dd>
              </>
            ) : (
              <dd className="console-stat__sub">{observed ? 'No plan (observed)' : 'No plan declared'}</dd>
            )}
          </div>
          <div className="console-stat">
            <dt>Context</dt>
            <dd className="console-stat__value">
              <span className="aoc-num">{s.contextPct === null ? '—' : `${Math.round(s.contextPct)}%`}</span>
            </dd>
            <dd className="console-stat__bar">
              <ContextMeter
                pct={s.contextPct}
                rolloverPct={rolloverPct}
                windowTokens={impliedWindow(s.contextTokens, s.contextPct)}
              />
            </dd>
          </div>
          <div className="console-stat">
            <dt>Today</dt>
            <dd className="console-stat__value">
              <Money usd={s.costTodayUsd} myr={s.costTodayRm} layout="stacked" className="console-stat__money" />
            </dd>
            <dd className="console-stat__sub">notional</dd>
          </div>
        </dl>
      </article>
    </li>
  );
}
