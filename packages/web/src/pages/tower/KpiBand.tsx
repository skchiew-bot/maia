import type { TowerSnapshot } from '@aoc/contracts';
import { KpiStrip, KpiTile, RelativeTime, formatAge, formatClock, useNow } from '../../components';
import {
  ANCHOR_WARN_MS,
  anchorAge,
  attentionKindLabel,
  flowDeltaRatio,
  flowTotals,
  formatBaseline,
  oldestAttention,
  oldestTicketStage,
  passkeyGateCount,
  ticketStageLabel,
} from './towerModel';

/** Five headline numbers: needs you, verified flow vs baseline, gate latency vs SLA, customers waiting, integrity. */
export function KpiBand({ snapshot }: { snapshot: TowerSnapshot }) {
  const now = useNow();
  const { kpis, attention, flow, integrity } = snapshot;
  const oldest = oldestAttention(attention);
  const passkeys = passkeyGateCount(attention);
  const delta = flowDeltaRatio(kpis.tasksVerifiedToday, kpis.tasksVerifiedBaseline);
  const { flagged } = flowTotals(flow.tasksPerHour);
  const breaches = flow.decisionLatency.reduce((n, r) => n + r.breaches, 0);
  const ticketStage = oldestTicketStage(flow.ticketFunnel);
  const anchorMs = anchorAge(integrity.lastAnchorAt, kpis.anchorAgeMs, now);
  const anchorLate = anchorMs !== null && anchorMs > ANCHOR_WARN_MS;
  const p90OverSla = kpis.gateLatencyP90Ms !== null && kpis.gateLatencyP90Ms > kpis.gateSlaMs;

  return (
    <KpiStrip label="Operation at a glance" className="tower-kpis">
      <KpiTile
        label="Needs you"
        value={kpis.needsYou}
        unit={kpis.needsYou === 1 ? 'item' : 'items'}
        footnote={
          kpis.oldestNeedsYouSince ? (
            <>
              oldest{' '}
              <b>
                <RelativeTime value={kpis.oldestNeedsYouSince} />
              </b>
              {oldest ? ` (${attentionKindLabel(oldest).toLowerCase()})` : ''} · <b className="aoc-num">{passkeys}</b>{' '}
              passkey {passkeys === 1 ? 'gate' : 'gates'}
            </>
          ) : (
            'nothing is waiting on a human'
          )
        }
      />
      <KpiTile
        label="Flow · verified tasks today"
        href="/projects"
        value={kpis.tasksVerifiedToday}
        delta={delta === null ? undefined : { value: delta, label: 'vs baseline', good: 'up' }}
        footnote={
          <>
            7-day baseline <b className="aoc-num">{formatBaseline(kpis.tasksVerifiedBaseline)}</b> by this hour ·{' '}
            <b className="aoc-num">{flagged}</b> flagged {flagged === 1 ? 'close' : 'closes'} in 12 h
          </>
        }
      />
      <KpiTile
        label="Human gate latency"
        href="/decisions"
        value={kpis.gateLatencyP50Ms === null ? '—' : formatAge(kpis.gateLatencyP50Ms)}
        unit="p50"
        tone={p90OverSla ? 'warn' : 'neutral'}
        footnote={
          <>
            p90 <b className="aoc-num">{kpis.gateLatencyP90Ms === null ? '—' : formatAge(kpis.gateLatencyP90Ms)}</b> vs
            SLA <b className="aoc-num">{formatAge(kpis.gateSlaMs)}</b> · <b className="aoc-num">{breaches}</b> SLA{' '}
            {breaches === 1 ? 'breach' : 'breaches'} in 7 days
          </>
        }
      />
      <KpiTile
        label="Customer waiting"
        href="/tickets"
        value={kpis.openTickets}
        unit={kpis.openTickets === 1 ? 'open ticket' : 'open tickets'}
        footnote={
          kpis.oldestTicketSince ? (
            <>
              oldest{' '}
              <b>
                <RelativeTime value={kpis.oldestTicketSince} />
              </b>
              {ticketStage ? ` in ${ticketStageLabel(ticketStage)}` : ''}
            </>
          ) : (
            'no customer is waiting'
          )
        }
      />
      <KpiTile
        label="Integrity"
        href="/audit"
        value={kpis.chainOk === true ? 'Verified' : kpis.chainOk === false ? 'Chain broken' : 'Not verified'}
        tone={kpis.chainOk === false ? 'danger' : anchorLate ? 'warn' : 'neutral'}
        footnote={
          <>
            {anchorMs === null ? (
              'no off-host anchor yet'
            ) : (
              <>
                off-host anchor <b className="aoc-num">{formatAge(anchorMs)}</b> old
                {anchorLate ? ' — over 26 h' : ''}
              </>
            )}
            {integrity.lastVerifiedAt ? (
              <>
                {' '}
                · checked <span className="aoc-num">{formatClock(integrity.lastVerifiedAt)}</span>
              </>
            ) : null}
          </>
        }
      />
    </KpiStrip>
  );
}
