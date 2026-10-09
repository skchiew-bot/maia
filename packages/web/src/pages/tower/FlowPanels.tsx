import type { TowerFlow, TowerKpis } from '@aoc/contracts';
import { useElementWidth } from '../../charts/shared';
import {
  ButtonLink,
  Icon,
  RelativeTime,
  Widget,
  formatAge,
  formatSignedPercent,
} from '../../components';
import { cx } from '../../lib/dom';
import {
  flowDeltaRatio,
  flowTotals,
  formatBaseline,
  hourLabel,
  latencyKindLabel,
  latencyMarks,
  niceCeil,
  splitFunnel,
  ticketStageLabel,
} from './towerModel';

/** The flow row: verified tasks per hour against baseline, the ticket funnel and decision latency vs SLA. */
export function FlowPanels({ flow, kpis }: { flow: TowerFlow; kpis: TowerKpis }) {
  return (
    <div className="tower-flow">
      <TasksPerHour flow={flow} kpis={kpis} />
      <TicketFunnel funnel={flow.ticketFunnel} />
      <DecisionLatency rows={flow.decisionLatency} />
    </div>
  );
}

const CHART_H = 132;
const GUTTER = 24;
const TOP_PAD = 14;

function TasksPerHour({ flow, kpis }: { flow: TowerFlow; kpis: TowerKpis }) {
  const [ref, width] = useElementWidth<HTMLDivElement>(320);
  const rows = flow.tasksPerHour;
  const base = flow.baselinePerHour;
  const { verified, flagged } = flowTotals(rows);
  const delta = flowDeltaRatio(kpis.tasksVerifiedToday, kpis.tasksVerifiedBaseline);
  const n = Math.max(1, rows.length);
  const plotW = Math.max(60, width - GUTTER);
  const slot = plotW / n;
  const barW = Math.min(28, Math.max(4, slot * 0.56));
  const peak = Math.max(0, ...rows.map((r) => r.verified + r.flagged), ...base);
  const yMax = niceCeil(peak, 3);
  const y = (v: number) => TOP_PAD + (1 - Math.min(v, yMax) / yMax) * (CHART_H - TOP_PAD);
  const everyOther = slot < 26;
  const baseline = base.slice(0, rows.length).map((v, i) => `${GUTTER + i * slot + slot / 2},${y(v)}`).join(' ');
  const summary = `Tasks done per hour, ${rows.length ? `${hourLabel(rows[0]!.hour)}:00 to ${hourLabel(rows[rows.length - 1]!.hour)}:00` : 'no data'}: ${rows
    .map((r, i) => {
      const b = base[i];
      return `${hourLabel(r.hour)}:00 ${r.verified} verified${r.flagged ? ` + ${r.flagged} flagged` : ''}${b !== undefined ? `, baseline ${formatBaseline(b)}` : ''}`;
    })
    .join('; ')}.`;

  return (
    <Widget title="Tasks done per hour" subtitle="Last 12 h · line = 7-day baseline" className="tower-flowp">
      <p className="tower-flowsum">
        <b className="aoc-num">{kpis.tasksVerifiedToday}</b> verified today against a 7-day baseline of{' '}
        <b className="aoc-num">{formatBaseline(kpis.tasksVerifiedBaseline)}</b> by this hour
        {delta !== null ? (
          <>
            {' '}
            (<b className="aoc-num">{formatSignedPercent(delta)}</b>)
          </>
        ) : null}
        . Last 12 h: <b className="aoc-num">{verified}</b> verified, <b className="aoc-num">{flagged}</b> flagged.
      </p>
      <div className="tower-hb" ref={ref}>
        <svg
          width={width}
          height={CHART_H + 30}
          viewBox={`0 0 ${width} ${CHART_H + 30}`}
          role="img"
          aria-label={summary}
          className="tower-hb__svg"
        >
          {[0, 1, 2, 3].map((k) => {
            const v = (yMax / 3) * k;
            return (
              <g key={k}>
                <line className="tower-hb__grid" x1={GUTTER} x2={width} y1={y(v)} y2={y(v)} />
                <text className="tower-hb__ytick" x={GUTTER - 6} y={y(v) + 4} textAnchor="end">
                  {Number(v.toPrecision(3))}
                </text>
              </g>
            );
          })}
          {rows.map((r, i) => {
            const cx0 = GUTTER + i * slot + slot / 2;
            const total = r.verified + r.flagged;
            const verifiedTop = y(r.verified);
            const flagTop = y(total);
            const bottom = y(0);
            return (
              <g key={r.hour}>
                {r.verified > 0 && (
                  <rect
                    className="tower-hb__ver"
                    x={cx0 - barW / 2}
                    y={verifiedTop}
                    width={barW}
                    height={Math.max(1, bottom - verifiedTop)}
                    rx={2}
                  />
                )}
                {r.flagged > 0 && (
                  <rect
                    className="tower-hb__flag"
                    x={cx0 - barW / 2}
                    y={flagTop}
                    width={barW}
                    height={Math.max(1, verifiedTop - flagTop - (r.verified > 0 ? 2 : 0))}
                    rx={2}
                  />
                )}
                {total > 0 && (
                  <text className="tower-hb__n" x={cx0} y={flagTop - 4} textAnchor="middle">
                    {total}
                  </text>
                )}
                {(!everyOther || i % 2 === (rows.length - 1) % 2) && (
                  <text
                    className={cx('tower-hb__x', i === rows.length - 1 && 'is-now')}
                    x={cx0}
                    y={CHART_H + 14}
                    textAnchor="middle"
                  >
                    {hourLabel(r.hour)}
                  </text>
                )}
                {i === rows.length - 1 && (
                  <text className="tower-hb__now" x={cx0} y={CHART_H + 27} textAnchor="middle">
                    now
                  </text>
                )}
              </g>
            );
          })}
          <line className="tower-hb__axis" x1={GUTTER} x2={width} y1={y(0)} y2={y(0)} />
          {base.length > 1 && (
            <>
              <polyline className="tower-hb__halo" points={baseline} />
              <polyline className="tower-hb__line" points={baseline} />
            </>
          )}
        </svg>
      </div>
      <ul className="tower-legend">
        <li>
          <span className="tower-sw tower-sw--ver" aria-hidden="true" />
          Verified evidence
        </li>
        <li>
          <span className="tower-sw tower-sw--flag" aria-hidden="true" />
          Flagged close
        </li>
        <li>
          <span className="tower-lg tower-lg--base" aria-hidden="true" />
          7-day baseline
        </li>
        <li>Latest hour still running</li>
      </ul>
    </Widget>
  );
}

function TicketFunnel({ funnel }: { funnel: TowerFlow['ticketFunnel'] }) {
  const { open, terminal, openTotal, bottleneck } = splitFunnel(funnel);
  const max = Math.max(1, ...open.map((s) => s.count));
  const completed = terminal.find((s) => s.stage === 'completed');
  const wait = bottleneck ? open.find((s) => s.stage === bottleneck) : undefined;
  return (
    <Widget
      title="Ticket funnel"
      subtitle={`${openTotal} open${completed ? ` · ${completed.count} completed` : ''}`}
      actions={
        <ButtonLink variant="ghost" size="sm" to="/tickets" iconAfter="chevron-right">
          Tickets
        </ButtonLink>
      }
      flush
      className="tower-flowp"
    >
      <table className="tower-funnel">
        <caption className="aoc-sr-only">Open tickets by stage with median and oldest age</caption>
        <thead>
          <tr>
            <th scope="col">Stage</th>
            <th scope="col">Open</th>
            <th scope="col" className="is-num">
              Median
            </th>
            <th scope="col" className="is-num">
              Oldest
            </th>
          </tr>
        </thead>
        <tbody>
          {open.map((s) => {
            const isWait = s.stage === bottleneck;
            return (
              <tr key={s.stage} className={cx(isWait && 'tower-fn--wait')}>
                <th scope="row">
                  {ticketStageLabel(s.stage)}
                  {isWait && (
                    <span className="tower-fn__tag">
                      <Icon name="warn" size={12} />
                      work waits here
                    </span>
                  )}
                </th>
                <td>
                  <span className="tower-fn__cell">
                    <span className="tower-fn__track" aria-hidden="true">
                      <span style={{ width: `${(s.count / max) * 100}%` }} />
                    </span>
                    <b className="aoc-num">{s.count}</b>
                  </span>
                </td>
                <td className="is-num aoc-num">{s.medianAgeMs === null ? '—' : formatAge(s.medianAgeMs)}</td>
                <td className="is-num">{s.oldestSince ? <RelativeTime value={s.oldestSince} /> : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="tower-fn__foot">
        <Icon name={wait ? 'warn' : 'ok'} size={14} className={wait ? 'tower-tone--warn' : 'tower-tone--ok'} />
        <span>
          {wait ? (
            <>
              Work waits longest in <b>{ticketStageLabel(wait.stage)}</b>: <b className="aoc-num">{wait.count}</b>{' '}
              {wait.count === 1 ? 'ticket' : 'tickets'}
              {wait.medianAgeMs !== null ? (
                <>
                  , median <b className="aoc-num">{formatAge(wait.medianAgeMs)}</b>
                </>
              ) : null}
              .
            </>
          ) : (
            'No stage is holding work up.'
          )}
          {terminal.map((s) => (
            <span key={s.stage}>
              {' '}
              {ticketStageLabel(s.stage)}: <b className="aoc-num">{s.count}</b>.
            </span>
          ))}
        </span>
      </p>
    </Widget>
  );
}

function DecisionLatency({ rows }: { rows: TowerFlow['decisionLatency'] }) {
  return (
    <Widget
      title="Decision latency"
      subtitle="Last 7 days · scaled to each SLA"
      actions={
        <ButtonLink variant="ghost" size="sm" to="/decisions" iconAfter="chevron-right">
          Decisions
        </ButtonLink>
      }
      className="tower-flowp"
    >
      {rows.length === 0 ? (
        <p className="tower-note">No decisions were raised or resolved in the last 7 days.</p>
      ) : (
        <>
          <div className="tower-lat__axis" aria-hidden="true">
            <span />
            <span className="tower-lat__scale">
              <i style={{ left: 0 }}>0</i>
              <i style={{ left: '50%' }}>SLA</i>
              <i style={{ left: '100%' }}>2× SLA</i>
            </span>
            <span />
          </div>
          <ol className="tower-lat">
            {rows.map((r) => {
              const m = latencyMarks(r);
              const label = latencyKindLabel(r.kind);
              const measured = r.p50Ms !== null && r.p90Ms !== null;
              const summary = measured
                ? `${label}: p50 ${formatAge(r.p50Ms!)}, p90 ${formatAge(r.p90Ms!)}, SLA ${formatAge(r.slaMs)}, ${r.breaches} ${r.breaches === 1 ? 'breach' : 'breaches'} in 7 days, ${r.open} open.`
                : `${label}: no decisions resolved in 7 days, SLA ${formatAge(r.slaMs)}, ${r.open} open.`;
              return (
                <li key={r.kind} className="tower-lat__row">
                  <p className="tower-lat__kind">
                    {label}
                    <span className="aoc-num">
                      {r.open} open · {r.resolved7d} resolved
                    </span>
                  </p>
                  <div className="tower-lat__track" role="img" aria-label={summary}>
                    {m.p50Pct !== null && <span className="tower-lat__p50" style={{ width: `${m.p50Pct}%` }} />}
                    {m.p50Pct !== null && m.p90Pct !== null && (
                      <span
                        className={cx('tower-lat__p90', m.offScale && 'is-over')}
                        style={{ left: `${m.p50Pct}%`, width: `${Math.max(0, m.p90Pct - m.p50Pct)}%` }}
                      />
                    )}
                    <span className="tower-lat__sla" />
                  </div>
                  <p className="tower-lat__txt">
                    {measured ? (
                      <>
                        p50 <b className="aoc-num">{formatAge(r.p50Ms!)}</b> · p90{' '}
                        <b className="aoc-num">{formatAge(r.p90Ms!)}</b> · SLA{' '}
                        <span className="aoc-num">{formatAge(r.slaMs)}</span>
                        {m.offScale ? ' · p90 off scale' : ''}
                      </>
                    ) : (
                      <>
                        none resolved · SLA <span className="aoc-num">{formatAge(r.slaMs)}</span>
                      </>
                    )}
                  </p>
                  <p className={cx('tower-lat__br', r.breaches > 0 && 'is-on')}>
                    {r.breaches > 0 && <Icon name="warn" size={12} />}
                    <span className="aoc-num">{r.breaches}</span>
                    <span className="aoc-sr-only"> {r.breaches === 1 ? 'breach' : 'breaches'}</span>
                  </p>
                </li>
              );
            })}
          </ol>
          <ul className="tower-legend">
            <li>
              <span className="tower-sw tower-sw--p50" aria-hidden="true" />
              p50
            </li>
            <li>
              <span className="tower-lg tower-lg--p90" aria-hidden="true" />
              p50 to p90
            </li>
            <li>
              <span className="tower-lg tower-lg--sla" aria-hidden="true" />
              SLA
            </li>
            <li>
              <Icon name="warn" size={12} className="tower-tone--warn" /> breaches in 7 days
            </li>
          </ul>
        </>
      )}
    </Widget>
  );
}
