import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AuditEventPageDTO, InternalTicket, PromotionDTO, Severity, TicketStage } from '@aoc/contracts';
import type { StreamMessage } from '../../api/stream';
import { useResource } from '../../api/useResource';
import { FunnelBar } from '../../charts/FunnelBar';
import { Meter } from '../../charts/Meter';
import { Chip } from '../../components/Chip';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { EmptyState, ErrorState, InlineAlert, describeError } from '../../components/EmptyState';
import { KpiStrip, KpiTile } from '../../components/KpiStrip';
import { FilterBar, Stack } from '../../components/Layout';
import { PageHeader } from '../../components/PageHeader';
import { RelativeTime } from '../../components/RelativeTime';
import { Widget, WidgetGrid } from '../../components/Widget';
import { useNow } from '../../lib/clock';
import { formatAge, formatInteger, formatTokens } from '../../lib/format';
import { ConfidenceBar, GateTrail, SeverityTag, StageTag } from './parts';
import {
  SEVERITY_RANK,
  STAGES,
  STAGE_LABEL,
  TERMINAL,
  budgetUse,
  budgetsFrom,
  diagnosisOf,
  funnelOf,
  gatesOf,
  latestRound,
  shortTicketId,
  timeInStageMs,
  type TriageBudget,
} from './model';
import './tickets.css';

const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'low'];
const BUDGET_QUERY = { type: 'ticket.triage_started', limit: 1000, order: 'desc' };
const PROMOTION_QUERY = { limit: 500 };

/**
 * Ticket lifecycle events, decision or session events scoped to a ticket, and token usage of the triage sessions
 * still running (their diagnosis budget moves with it).
 */
export function isTicketEvent(m: StreamMessage, runningSessions: ReadonlySet<string>): boolean {
  if (m.kind !== 'aoc') return false;
  const t = m.event.type;
  if (t.startsWith('ticket.') || t.startsWith('intake.') || t.startsWith('promotion.')) return true;
  if (m.event.scope.ticketId && (t.startsWith('decision.') || t.startsWith('session.'))) return true;
  return t === 'usage.recorded' && runningSessions.has(m.event.scope.sessionId ?? '');
}

type StageFilter = TicketStage | 'open' | 'gates' | null;

function parseStage(v: string | null): StageFilter {
  if (v === 'open' || v === 'gates') return v;
  return v && (STAGES as readonly string[]).includes(v) ? (v as TicketStage) : null;
}

const GATE_STAGES: ReadonlySet<TicketStage> = new Set(['awaiting_human', 'fix_plan_gate', 'go_live_gate']);

/**
 * Operator view of the intake portal (§7): the ticket pipeline as the hero (where work waits), then every
 * ticket with severity, age, requester, triage diagnosis, gates and diagnosis budget. Raw media never shows
 * here; the ticket page lists attachments behind the role boundary (§6).
 */
export default function TicketsPage() {
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const stageFilter = parseStage(params.get('stage'));
  const sevParam = params.get('severity');
  const sevFilter = (SEVERITIES as readonly string[]).includes(sevParam ?? '')
    ? (sevParam as Severity)
    : null;

  const running = useRef<ReadonlySet<string>>(new Set());
  const tickets = useResource<InternalTicket[]>('/api/tickets', {
    refreshOn: (m) => isTicketEvent(m, running.current),
  });
  useEffect(() => {
    running.current = new Set(
      (tickets.data ?? []).flatMap((t) =>
        t.diagnoses.filter((d) => d.status === 'running').map((d) => d.sessionId),
      ),
    );
  }, [tickets.data]);
  const budgetEvents = useResource<AuditEventPageDTO>('/api/audit/events', {
    query: BUDGET_QUERY,
    refreshOn: (m) => m.kind === 'aoc' && m.event.type === 'ticket.triage_started',
  });
  const budgets = useMemo(() => budgetsFrom(budgetEvents.data?.events ?? []), [budgetEvents.data]);
  const promotions = useResource<{ items: PromotionDTO[] }>('/api/promotions', {
    query: PROMOTION_QUERY,
    refreshOn: (m) => m.kind === 'aoc' && m.event.type.startsWith('promotion.'),
  });
  // Latest go-live promotion per ticket, so the list reads the same gate state as the ticket page.
  const promotionOf = useMemo(() => {
    const latest = new Map<string, PromotionDTO>();
    for (const p of promotions.data?.items ?? []) {
      if (!p.ticketId) continue;
      const prev = latest.get(p.ticketId);
      if (!prev || prev.requestedAt < p.requestedAt) latest.set(p.ticketId, p);
    }
    return latest;
  }, [promotions.data]);
  const gatesFor = useCallback((t: InternalTicket) => gatesOf(t, promotionOf.get(t.ticketId)), [promotionOf]);
  // At the go-live gate a human is only waited on while the promotion is pending, not after it failed.
  const waitsOnGate = useCallback(
    (t: InternalTicket) =>
      GATE_STAGES.has(t.stage) && (t.stage !== 'go_live_gate' || gatesFor(t).goLive === 'waiting'),
    [gatesFor],
  );

  const all = tickets.data ?? [];
  const open = all.filter((t) => !TERMINAL.has(t.stage));
  const funnel = useMemo(() => funnelOf(all, now), [all, now]);
  const gatesWaiting = open.filter(waitsOnGate);
  const uatWaiting = open.filter((t) => t.stage === 'uat' && t.openDecisionIds.length > 0);
  const stuck = open.filter((t) => gatesFor(t).goLive === 'blocked');
  const promotionFailed = open.filter((t) => gatesFor(t).goLive === 'failed');
  const urgent = open.filter((t) => t.severity === 'critical' || t.severity === 'high');
  const oldestOpen = open.reduce<string | null>(
    (min, t) => (min === null || t.submittedAt < min ? t.submittedAt : min),
    null,
  );

  const rows = useMemo(() => {
    const filtered = all.filter((t) => {
      if (sevFilter && t.severity !== sevFilter) return false;
      if (stageFilter === 'open') return !TERMINAL.has(t.stage);
      if (stageFilter === 'gates') return waitsOnGate(t);
      return stageFilter ? t.stage === stageFilter : true;
    });
    // Open work first, most severe first, then oldest first.
    return filtered.sort(
      (a, b) =>
        Number(TERMINAL.has(a.stage)) - Number(TERMINAL.has(b.stage)) ||
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        a.submittedAt.localeCompare(b.submittedAt),
    );
  }, [all, stageFilter, sevFilter, waitsOnGate]);

  const set = (key: 'stage' | 'severity', value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const columns = useMemo<DataTableColumn<InternalTicket>[]>(
    () => [
      {
        id: 'ticket',
        header: 'Ticket',
        primary: true,
        sortValue: (t) => t.title,
        cell: (t) => (
          <span className="tkt-cell-title">
            <span className="tkt-cell-title__main">{t.title}</span>
            <span className="tkt-cell-title__sub">
              <code>{shortTicketId(t.ticketId)}</code> · {t.requesterName ?? 'Unknown requester'}
              {t.diagnoses.length + (t.buildSessionId ? 1 : 0) > 0 &&
                ` · sessions: ${t.diagnoses.length} triage${t.buildSessionId ? ', 1 build' : ''}`}
            </span>
          </span>
        ),
      },
      {
        id: 'severity',
        header: 'Severity',
        width: '96px',
        sortValue: (t) => SEVERITY_RANK[t.severity],
        sortLabels: ['most severe first', 'least severe first'],
        cell: (t) => <SeverityTag severity={t.severity} />,
      },
      {
        id: 'stage',
        header: 'Stage',
        width: '150px',
        sortValue: (t) => STAGES.indexOf(t.stage),
        sortLabels: ['earliest stage first', 'latest stage first'],
        cell: (t) => (
          <span className="tkt-cell-stage">
            <StageTag stage={t.stage} />
            {!TERMINAL.has(t.stage) && (
              <span className="tkt-cell-stage__age aoc-num">{formatAge(timeInStageMs(t, now))} in stage</span>
            )}
          </span>
        ),
      },
      {
        id: 'age',
        header: 'Age',
        numeric: true,
        width: '72px',
        sortValue: (t) => Date.parse(t.submittedAt),
        firstSort: 'asc',
        sortLabels: ['oldest first', 'newest first'],
        cell: (t) => <RelativeTime value={t.submittedAt} now={now} />,
      },
      {
        id: 'diagnosis',
        header: 'Diagnosis',
        width: '230px',
        sortValue: (t) =>
          diagnosisOf(latestRound(t.diagnoses, budgets.get(t.ticketId))).best?.confidence ?? null,
        cell: (t) => {
          const d = diagnosisOf(latestRound(t.diagnoses, budgets.get(t.ticketId)));
          if (!d.best)
            return (
              <span className="tkt-muted">
                {d.running
                  ? `${d.running} agent(s) diagnosing`
                  : d.total
                    ? 'No diagnosis reported'
                    : 'Not triaged'}
              </span>
            );
          return (
            <span className="tkt-cell-diag">
              <ConfidenceBar value={d.best.confidence ?? 0} label="Best root-cause confidence" />
              <span className="tkt-cell-diag__class">
                {d.best.rootCauseClass ?? 'unclassified'}
                {d.agree === true
                  ? ` · ${d.reported}/${d.total} agree`
                  : d.agree === false
                    ? ' · agents disagree'
                    : ''}
              </span>
              <span className="tkt-cell-diag__cause" title={d.best.rootCause ?? undefined}>
                {d.best.rootCause ?? '[erased]'}
              </span>
            </span>
          );
        },
      },
      {
        id: 'gates',
        header: 'Gates',
        width: '196px',
        cell: (t) => <GateTrail gates={gatesFor(t)} compact />,
      },
      {
        id: 'budget',
        header: 'Diagnosis budget',
        width: '150px',
        sortValue: (t) => {
          const u = budgetUse(t, budgets.get(t.ticketId));
          return u ? u.used / u.cap : null;
        },
        cell: (t) => <BudgetCell ticket={t} budget={budgets.get(t.ticketId)} />,
      },
    ],
    [now, budgets, gatesFor],
  );

  if (tickets.data === undefined) {
    return (
      <>
        <PageHeader title="Tickets" subtitle="Requester intake tickets and the work they spawned." />
        {tickets.error ? (
          <ErrorState title="Couldn't load tickets" error={tickets.error} onRetry={tickets.reload} />
        ) : (
          <div className="tkt-skeleton" aria-busy="true">
            <p className="aoc-sr-only" role="status">
              Loading tickets…
            </p>
            <span className="tkt-skeleton__block tkt-skeleton__block--hero" aria-hidden="true" />
            <span className="tkt-skeleton__block tkt-skeleton__block--table" aria-hidden="true" />
          </div>
        )}
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Tickets"
        subtitle="Requester intake tickets and the work they spawned. Requesters only ever see the abstracted status."
      />
      <Stack gap={4}>
        {tickets.error !== undefined && (
          <InlineAlert tone="warn" title="Showing the last loaded tickets">
            {describeError(tickets.error) ?? 'The latest refresh failed.'}
          </InlineAlert>
        )}
        <WidgetGrid>
          <Widget
            span={12}
            title="Ticket pipeline"
            subtitle={`${formatInteger(open.length)} open · time in stage now`}
            info="Every ticket by stage in flow order: triage (read-only), the fix-plan gate, build, the requester's UAT and the go-live gate. Bottleneck = the stage holding the most waiting time (count × median time in stage)."
            busy={tickets.loading}
          >
            <FunnelBar stages={funnel} label="Ticket pipeline" unit="tickets" />
          </Widget>
        </WidgetGrid>
        <KpiStrip label="Tickets at a glance">
          <KpiTile
            label="Open tickets"
            value={open.length}
            href="/tickets?stage=open"
            footnote={oldestOpen ? `oldest open ${formatAge(now - Date.parse(oldestOpen))}` : 'nothing open'}
          />
          <KpiTile
            label="Waiting on a human gate"
            value={gatesWaiting.length}
            href="/tickets?stage=gates"
            tone={gatesWaiting.length ? 'warn' : 'neutral'}
            footnote="awaiting human · fix plan · go-live"
          />
          <KpiTile
            label="Waiting on requester UAT"
            value={uatWaiting.length}
            href="/tickets?stage=uat"
            footnote={stuck.length ? `${stuck.length} passed UAT, go-live not started` : 'testing on UAT'}
          />
          <KpiTile
            label="Critical or high, open"
            value={urgent.length}
            href={urgent.length ? '/tickets?stage=open&severity=critical' : undefined}
            footnote={`${open.filter((t) => t.severity === 'critical').length} critical`}
          />
        </KpiStrip>
        {stuck.length > 0 && (
          <InlineAlert tone="danger" title="Go-live did not start after a UAT pass">
            {stuck.length === 1 ? 'One ticket passed' : `${stuck.length} tickets passed`} the requester&apos;s
            UAT but no go-live request was raised, so nothing will promote the fix. Open the ticket to see its
            history and request go-live again.
          </InlineAlert>
        )}
        {promotionFailed.length > 0 && (
          <InlineAlert tone="danger" title="Go-live promotion did not complete">
            {promotionFailed.length === 1 ? 'One ticket' : `${promotionFailed.length} tickets`} reached the
            go-live gate but the promotion failed or was refused, so nothing reached main. Open the ticket to
            see the reason and request go-live again.
          </InlineAlert>
        )}
        <FilterBar
          label="Ticket filters"
          end={<span className="aoc-num">{formatInteger(rows.length)} shown</span>}
        >
          <Chip selected={stageFilter === null} onToggle={() => set('stage', null)}>
            All <span className="aoc-num">{all.length}</span>
          </Chip>
          <Chip selected={stageFilter === 'open'} onToggle={(on) => set('stage', on ? 'open' : null)}>
            Open <span className="aoc-num">{open.length}</span>
          </Chip>
          {STAGES.filter((s) => funnel.find((f) => f.id === s)!.count > 0).map((s) => (
            <Chip key={s} selected={stageFilter === s} onToggle={(on) => set('stage', on ? s : null)}>
              {STAGE_LABEL[s]} <span className="aoc-num">{funnel.find((f) => f.id === s)!.count}</span>
            </Chip>
          ))}
          {stageFilter === 'gates' && (
            <Chip tone="warn" onRemove={() => set('stage', null)} removeLabel="Remove the gate filter">
              Waiting on a human gate
            </Chip>
          )}
          {SEVERITIES.filter((s) => all.some((t) => t.severity === s)).map((s) => (
            <Chip key={s} selected={sevFilter === s} onToggle={(on) => set('severity', on ? s : null)}>
              {s[0]!.toUpperCase() + s.slice(1)}
            </Chip>
          ))}
        </FilterBar>
        <Widget
          span={12}
          flush
          title="Tickets"
          subtitle="open work first, most severe first"
          busy={tickets.loading}
        >
          <DataTable
            caption="Intake tickets"
            columns={columns}
            rows={rows}
            rowKey={(t) => t.ticketId}
            rowHref={(t) => `/tickets/${encodeURIComponent(t.ticketId)}`}
            rowTone={(t) => (['blocked', 'failed'].includes(gatesFor(t).goLive) ? 'danger' : undefined)}
            empty={
              <EmptyState
                size="sm"
                icon="tickets"
                title={all.length ? 'No tickets match these filters' : 'No tickets yet'}
                body={
                  all.length
                    ? 'Clear the filters to see every ticket.'
                    : 'Tickets appear when a requester files a bug through the intake portal.'
                }
              />
            }
          />
        </Widget>
      </Stack>
    </>
  );
}

function BudgetCell({ ticket, budget }: { ticket: InternalTicket; budget: TriageBudget | undefined }) {
  const use = budgetUse(ticket, budget);
  if (!use) return <span className="tkt-muted">—</span>;
  return (
    <span className="tkt-cell-budget">
      <Meter
        size="sm"
        value={use.used}
        max={use.cap}
        label="Diagnosis budget used"
        detail={`${formatTokens(use.used)} of ${formatTokens(use.cap)} tokens`}
      />
      <span className="tkt-cell-budget__text aoc-num">
        {formatTokens(use.used)} / {formatTokens(use.cap)}
      </span>
    </span>
  );
}
