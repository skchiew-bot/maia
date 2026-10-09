import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  AuditEventHeaderDTO,
  AuditEventPageDTO,
  DecisionCardView,
  DecisionListResponse,
  InternalTicket,
} from '@aoc/contracts';
import { useAuth } from '../../api/auth';
import type { StreamMessage } from '../../api/stream';
import { ApiError, apiPost } from '../../api/client';
import { useResource } from '../../api/useResource';
import { Meter } from '../../charts/Meter';
import { Badge } from '../../components/Badge';
import { Button, ButtonLink } from '../../components/Button';
import { CopyableHash } from '../../components/CopyableHash';
import { Dialog } from '../../components/Dialog';
import { EmptyState, ErrorState, InlineAlert, describeError } from '../../components/EmptyState';
import { Select, TextArea } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { RelativeTime } from '../../components/RelativeTime';
import { useToast } from '../../components/Toast';
import { Widget, WidgetGrid } from '../../components/Widget';
import { useClock, useNow } from '../../lib/clock';
import { cx } from '../../lib/dom';
import { formatAge, formatDateTime, formatInteger, formatTokens } from '../../lib/format';
import { usePasskeys, useDecisionActions } from '../decisions/actions';
import { RecommendationBox } from '../decisions/DecisionDetail';
import { useDirectory, type Directory } from '../decisions/directory';
import { isDecisionEvent } from '../decisions/inbox';
import { KIND_LABEL, agingOf, methodLabel, outcomeLabel, requesterOf, shortId } from '../decisions/model';
import { AgingBadge, KindLine } from '../decisions/parts';
import { ResolvePanel } from '../decisions/ResolvePanel';
import '../decisions/decisions.css';
import { describeEvent } from './events';
import {
  CLOSE_RESOLUTIONS,
  PUBLIC_STATUS_LABEL,
  RESOLUTION_LABEL,
  STAGE_HINT,
  STAGE_LABEL,
  TERMINAL,
  budgetUse,
  budgetsFrom,
  diagnosisOf,
  gatesOf,
  latestPromotion,
  latestRound,
  stageSpans,
  timelineEvents,
  type CloseResolution,
  type StageSpan,
} from './model';
import { ConfidenceBar, GateTrail, SeverityTag, StageTag } from './parts';
import './tickets.css';

const WORK_STAGES = new Set(['triage', 'building']);
const GATE_STAGES = new Set(['awaiting_human', 'fix_plan_gate', 'uat', 'go_live_gate']);

/** Stage spans to scale: grey = agents working, purple = waiting on a human, light = queued or done. */
function StageSpans({ spans, now }: { spans: readonly StageSpan[]; now: number }) {
  const total = Math.max(
    1,
    spans.reduce((n, s) => n + Math.max(0, s.end - s.start), 0),
  );
  const kind = (s: StageSpan) =>
    WORK_STAGES.has(s.stage) ? 'work' : GATE_STAGES.has(s.stage) ? 'gate' : 'other';
  const summary = spans
    .map((s) => `${STAGE_LABEL[s.stage]} ${formatAge(s.end - s.start)}${s.current ? ' so far' : ''}`)
    .join(', ');
  return (
    <figure
      className="tkt-spans"
      aria-label={`Time by stage: ${summary}. Lead time ${formatAge(total)}.`}
      role="img"
    >
      <div className="tkt-spans__bar" aria-hidden="true">
        {spans.map((s, i) => (
          <span
            key={`${s.stage}-${i}`}
            className={cx(
              'tkt-spans__seg',
              `tkt-spans__seg--${kind(s)}`,
              s.current && 'tkt-spans__seg--current',
            )}
            style={{ flexGrow: Math.max(0, s.end - s.start), flexBasis: 0 }}
            title={`${STAGE_LABEL[s.stage]}: ${formatAge(s.end - s.start)}`}
          />
        ))}
      </div>
      <ol className="tkt-spans__legend" aria-hidden="true">
        {spans.map((s, i) => (
          <li key={`${s.stage}-${i}`} className="tkt-spans__item">
            <span className={cx('tkt-spans__swatch', `tkt-spans__swatch--${kind(s)}`)} />
            <span className="tkt-spans__name">{STAGE_LABEL[s.stage]}</span>
            <span className="tkt-spans__dur aoc-num">
              {TERMINAL.has(s.stage) ? formatDateTime(s.start).slice(11, 16) : formatAge(s.end - s.start)}
              {s.current && <span className="tkt-spans__now"> so far</span>}
            </span>
          </li>
        ))}
      </ol>
      <figcaption className="aoc-sr-only">
        Lead time {formatAge(total)} as of {formatDateTime(now)}
      </figcaption>
    </figure>
  );
}

function OpenDecision({
  card,
  directory,
  passkeys,
  onChanged,
  now,
}: {
  card: DecisionCardView;
  directory: Directory;
  passkeys: ReturnType<typeof usePasskeys>;
  onChanged: () => void;
  now: number;
}) {
  const actions = useDecisionActions(onChanged, passkeys);
  return (
    <section className="tkt-next__card" aria-label={`${KIND_LABEL[card.kind]}: ${card.title}`}>
      <div className="tkt-next__card-head">
        <KindLine card={card}>
          <AgingBadge aging={agingOf(card, now)} />
        </KindLine>
        <Link to={`/decisions?focus=${encodeURIComponent(card.id)}`} className="tkt-links__sub">
          Open in Decisions
        </Link>
      </div>
      <h3 className="tkt-next__title">{card.title}</h3>
      <p className="tkt-next__question">{card.question}</p>
      {card.context && (
        <details>
          <summary className="tkt-links__sub">Context</summary>
          <div className="dec-text">{card.context}</div>
        </details>
      )}
      <RecommendationBox card={card} directory={directory} />
      <ResolvePanel
        card={card}
        directory={directory}
        actions={actions}
        passkeys={passkeys}
        allowWithdraw={false}
      />
    </section>
  );
}

function CloseDialog({
  ticket,
  open,
  onClose,
  onClosed,
}: {
  ticket: InternalTicket;
  open: boolean;
  onClose: () => void;
  onClosed: () => void;
}) {
  const toast = useToast();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [resolution, setResolution] = useState<CloseResolution>('duplicate');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/tickets/${encodeURIComponent(ticket.ticketId)}/close`, {
        resolution,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      toast.notify({
        tone: 'ok',
        title: `Ticket closed: ${RESOLUTION_LABEL[resolution]}`,
        body: ticket.title,
      });
      onClosed();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      role="alertdialog"
      size="sm"
      title="Close this ticket?"
      description="Running triage or build sessions on it stop. The requester sees only “Closed”, never the reason."
      initialFocus={cancelRef}
      dismissOnBackdrop={false}
      footer={
        <>
          <Button ref={cancelRef} onClick={onClose}>
            Keep open
          </Button>
          <Button variant="danger" loading={busy} loadingText="Closing…" onClick={() => void submit()}>
            Close ticket
          </Button>
        </>
      }
    >
      <form
        className="tkt-close"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Select
          label="Resolution"
          value={resolution}
          onChange={(e) => setResolution(e.target.value as CloseResolution)}
          options={CLOSE_RESOLUTIONS.map((r) => ({ value: r, label: RESOLUTION_LABEL[r]! }))}
        />
        <TextArea
          label="Note (optional)"
          hint="Stored in the encrypted body store with the ticket."
          rows={3}
          maxLength={2000}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        {error !== null && (
          <InlineAlert tone="danger" live title="The ticket was not closed">
            {describeError(error)}
          </InlineAlert>
        )}
      </form>
    </Dialog>
  );
}

/**
 * Raises a fresh go-live decision when UAT passed but the promotion never started or did not complete. The
 * request goes through the same provenance and UAT checks, and the person who asks becomes the decision's
 * requester, so separation of duties keeps them from signing it.
 */
function RequestGoLive({
  ticket,
  directory,
  onRequested,
}: {
  ticket: InternalTicket & { projectId: string; uatRef: string };
  directory: Directory;
  onRequested: () => void;
}) {
  const { user } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // Held after success so a second click cannot raise a duplicate promotion before the new one arrives.
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const soleApprover = user?.role === 'approver' && directory.activeApprovers === 1;
  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiPost('/api/promotions', {
        projectId: ticket.projectId,
        fromRef: ticket.uatRef,
        ticketId: ticket.ticketId,
      });
      setSent(true);
      toast.notify({
        tone: 'ok',
        title: 'Go-live requested',
        body: 'A new go-live decision is open for an Approver to sign with a passkey.',
      });
      onRequested();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="tkt-retry">
      <div className="tkt-retry__row">
        <Button
          icon="retry"
          loading={busy}
          loadingText="Requesting…"
          disabled={soleApprover || sent}
          aria-describedby={`tkt-retry-${ticket.ticketId}`}
          onClick={() => void request()}
        >
          Request go-live again
        </Button>
        <p id={`tkt-retry-${ticket.ticketId}`} className="tkt-retry__hint">
          {soleApprover
            ? 'You are the only Approver and could not sign a request you raised (separation of duties): ask a Builder to request it.'
            : user?.role === 'approver'
              ? `Promotes ${ticket.uatRef} once a different Approver signs it: you will be the requester.`
              : `Promotes ${ticket.uatRef} once the Approver signs it with a passkey. Provenance and the UAT sign-off are checked again.`}
        </p>
      </div>
      {error !== null && (
        <InlineAlert tone="danger" live title="Go-live was not requested">
          {describeError(error)}
        </InlineAlert>
      )}
    </div>
  );
}

/**
 * One intake ticket for operators (§6, §7): where its time went, what it waits on now (with the gate decisions
 * resolvable inline), the triage diagnosis and budget, the request, attachments behind the media permission,
 * linked sessions and decisions, and the full event timeline. Refreshes on any event scoped to the ticket.
 */
export default function TicketPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const clock = useClock();
  const now = useNow();
  const directory = useDirectory();
  const [closing, setClosing] = useState(false);

  const scoped = useCallback((m: StreamMessage) => m.kind === 'aoc' && m.event.scope.ticketId === id, [id]);
  const ticket = useResource<InternalTicket>(`/api/tickets/${encodeURIComponent(id)}`, { refreshOn: scoped });
  const events = useResource<AuditEventPageDTO>('/api/audit/events', {
    query: { ticketId: id, limit: 1000, order: 'asc' },
    refreshOn: scoped,
  });
  const decisions = useResource<DecisionListResponse>('/api/decisions', {
    query: { subjectId: id, limit: 100 },
    refreshOn: (m) => isDecisionEvent(m) && scoped(m),
  });
  const evts: AuditEventHeaderDTO[] = events.data?.events ?? [];
  const promotion = useMemo(() => latestPromotion(evts), [evts]);
  // A go-live decision is about the promotion, not the ticket, so it is listed by the latest promotion: the one
  // intake raised after UAT, or one an operator requested again.
  const goLive = useResource<DecisionListResponse>(promotion ? '/api/decisions' : null, {
    query: promotion ? { subjectId: promotion.promotionId, limit: 10 } : undefined,
    // Withdrawn, expired and escalated events carry no kind, so those refetch whichever decision they name.
    refreshOn: (m) =>
      isDecisionEvent(m) && m.kind === 'aoc' && (m.event.meta.kind ?? 'go_live') === 'go_live',
  });
  const allDecisions = useMemo(() => {
    const list = [...(decisions.data?.decisions ?? [])];
    for (const d of goLive.data?.decisions ?? []) if (!list.some((x) => x.id === d.id)) list.push(d);
    return list;
  }, [decisions.data, goLive.data]);
  const openCards = allDecisions.filter((d) => d.status === 'open');
  const passkeys = usePasskeys(openCards.some((d) => d.requiresPasskey && d.viewer.canResolve));
  const { reload: reloadTicket } = ticket;
  const { reload: reloadEvents } = events;
  const { reload: reloadDecisions } = decisions;
  const { reload: reloadGoLive } = goLive;
  const reloadAll = useCallback(() => {
    reloadTicket();
    reloadEvents();
    reloadDecisions();
    reloadGoLive();
  }, [reloadTicket, reloadEvents, reloadDecisions, reloadGoLive]);

  // Geometry is computed once per fetched snapshot, so the bar only moves when an event refetched it.
  const snapshotAt = useMemo(() => clock.now(), [events.data, clock]);
  const spans = useMemo(() => stageSpans(evts, snapshotAt), [evts, snapshotAt]);
  const budget = useMemo(() => budgetsFrom(evts).get(id), [evts, id]);
  const decisionMap = useMemo(() => new Map(allDecisions.map((d) => [d.id, d])), [allDecisions]);
  const timeline = useMemo(() => timelineEvents(evts).reverse(), [evts]);

  if (ticket.data === undefined) {
    const notFound = ticket.error instanceof ApiError && ticket.error.status === 404;
    return (
      <>
        <PageHeader
          title={notFound ? 'Ticket not found' : 'Ticket'}
          breadcrumbs={[{ label: 'Tickets', to: '/tickets' }, { label: shortId(id) }]}
        />
        {notFound ? (
          <EmptyState
            icon="tickets"
            title="No ticket with this id"
            body={`Nothing is recorded for ${id}. It may have been mistyped.`}
            action={<ButtonLink to="/tickets">All tickets</ButtonLink>}
          />
        ) : ticket.error ? (
          <ErrorState title="Couldn't load this ticket" error={ticket.error} onRetry={ticket.reload} />
        ) : (
          <div className="tkt-skeleton" aria-busy="true">
            <p className="aoc-sr-only" role="status">
              Loading ticket…
            </p>
            <span className="tkt-skeleton__block tkt-skeleton__block--wide" aria-hidden="true" />
            <span className="tkt-skeleton__block tkt-skeleton__block--table" aria-hidden="true" />
          </div>
        )}
      </>
    );
  }

  const t = ticket.data;
  const done = TERMINAL.has(t.stage);
  const gates = gatesOf(t, promotion);
  const promotionProblem = gates.goLive === 'failed' || gates.goLive === 'rejected';
  const round = latestRound(t.diagnoses, budget);
  const diag = diagnosisOf(round);
  const use = budgetUse(t, budget);
  const canDownload = user?.role === 'approver';
  const linkedActive = t.diagnoses.some((d) => {
    const s = directory.session(d.sessionId);
    return s?.ownerId === user?.id && !['ended', 'retired', 'failed'].includes(s?.lifecycle ?? 'ended');
  });
  const project = directory.projectName(t.projectId);
  const closedCards = allDecisions.filter((d) => d.status !== 'open');
  const sessionsLinked = [
    ...t.diagnoses.map((d) => ({ id: d.sessionId, role: 'Triage (read-only)' })),
    ...(t.buildSessionId ? [{ id: t.buildSessionId, role: 'Build' }] : []),
  ];

  return (
    <>
      <PageHeader
        title={t.title}
        documentTitle={`Ticket ${shortId(t.ticketId)}`}
        breadcrumbs={[{ label: 'Tickets', to: '/tickets' }, { label: shortId(t.ticketId) }]}
        actions={
          !done && (
            <Button icon="close" onClick={() => setClosing(true)}>
              Close ticket…
            </Button>
          )
        }
        meta={
          <span className="tkt-headmeta">
            <SeverityTag severity={t.severity} />
            <StageTag stage={t.stage} />
            <span className="tkt-headmeta__public" title="What the requester sees in the portal">
              <Icon name="user" size={12} /> Requester sees “{PUBLIC_STATUS_LABEL[t.publicStatus]}”
            </span>
            <span>{t.requesterName ?? 'Unknown requester'}</span>
            {t.projectId && (
              <Link to={`/projects/${encodeURIComponent(t.projectId)}`}>{project ?? t.projectId}</Link>
            )}
            <span>
              submitted <RelativeTime value={t.submittedAt} suffix=" ago" />
            </span>
            <CopyableHash value={t.ticketId} label="ticket id" />
          </span>
        }
      />
      {(ticket.error !== undefined || events.error !== undefined) && (
        <InlineAlert tone="warn" title="Showing the last loaded data">
          {describeError(ticket.error ?? events.error) ?? 'The latest refresh failed.'}
        </InlineAlert>
      )}
      <WidgetGrid>
        <Widget
          span={12}
          title="Where the time went"
          subtitle={
            done
              ? `${STAGE_LABEL[t.stage]}${t.resolution ? ` · ${RESOLUTION_LABEL[t.resolution] ?? t.resolution}` : ''}`
              : `in ${STAGE_LABEL[t.stage]} now · lead time so far`
          }
          info="Each stage to scale by elapsed time, from this ticket's own events. Grey: agents working. Purple: waiting on a human (a builder decision, a gate or the requester's UAT)."
          busy={events.loading}
        >
          {spans.length ? (
            <StageSpans spans={spans} now={snapshotAt} />
          ) : (
            <p className="aoc-loading">Loading the ticket history…</p>
          )}
        </Widget>

        <Widget span={7} title="Next step" subtitle={STAGE_LABEL[t.stage]}>
          <div className="tkt-next">
            <p className="tkt-next__hint">
              {gates.goLive === 'failed'
                ? promotion?.status === 'refused'
                  ? 'The platform refused to promote the change to main, so no go-live decision was raised.'
                  : 'Go-live was approved, but promoting the change to main did not complete.'
                : gates.goLive === 'rejected'
                  ? 'The Approver rejected go-live: nothing reached main. Close the ticket if the fix is not going ahead.'
                  : gates.goLive === 'blocked'
                    ? 'The requester passed UAT, but go-live never started.'
                    : STAGE_HINT[t.stage]}
            </p>
            <GateTrail gates={gates} />
            {promotion && gates.goLive === 'failed' && (
              <InlineAlert tone="danger" title={`Go-live promotion ${promotion.status}`}>
                Promotion {shortId(promotion.promotionId)} {promotion.status} (
                {(promotion.reason ?? 'no reason').replace(/_/g, ' ')}) at{' '}
                {formatDateTime(promotion.at).slice(11, 16)}. Nothing reached main; the timeline has the
                detail.
              </InlineAlert>
            )}
            {gates.goLive === 'blocked' && (
              <InlineAlert tone="danger" title="UAT passed, but go-live did not start">
                The requester signed off UAT and no go-live decision or promotion was recorded, so nothing
                will promote this fix until go-live is requested again.
              </InlineAlert>
            )}
            {(gates.goLive === 'blocked' || gates.goLive === 'failed') && t.projectId && t.uatRef && (
              <RequestGoLive
                ticket={{ ...t, projectId: t.projectId, uatRef: t.uatRef }}
                directory={directory}
                onRequested={reloadAll}
              />
            )}
            {openCards.map((card) => (
              <OpenDecision
                key={card.id}
                card={card}
                directory={directory}
                passkeys={passkeys}
                onChanged={reloadAll}
                now={now}
              />
            ))}
            {!openCards.length && !done && gates.goLive !== 'blocked' && !promotionProblem && (
              <p className="tkt-links__sub">
                No human decision is open on this ticket: the platform moves it on when the current stage
                finishes.
              </p>
            )}
          </div>
        </Widget>

        <Widget
          span={5}
          title="Diagnosis"
          subtitle={
            diag.total
              ? `${diag.reported} of ${diag.total} agents reported${diag.agree === true ? ' · they agree' : diag.agree === false ? ' · they disagree' : ''}`
              : 'not triaged yet'
          }
          info="Read-only triage agents report a root cause, a confidence and a fix plan within the diagnosis budget. Low confidence or disagreement bounces to a human decision."
        >
          {diag.best ? (
            <div className="tkt-diag">
              <div className="tkt-diag__head">
                <ConfidenceBar value={diag.best.confidence ?? 0} label="Root-cause confidence" />
                <Badge>{diag.best.rootCauseClass ?? 'unclassified'}</Badge>
              </div>
              <div>
                <p className="tkt-diag__label">Root cause</p>
                <p className="tkt-text">{diag.best.rootCause ?? '[erased]'}</p>
              </div>
              <div>
                <p className="tkt-diag__label">Fix plan</p>
                <p className="tkt-text">{diag.best.fixPlan ?? '[erased]'}</p>
              </div>
            </div>
          ) : (
            <p className="tkt-links__sub">
              {diag.running ? `${diag.running} agent(s) still diagnosing.` : 'No diagnosis was reported.'}
            </p>
          )}
          {t.diagnoses.length > 0 && (
            <ul className="tkt-agents" aria-label="Triage agents">
              {t.diagnoses.map((d) => {
                const s = directory.session(d.sessionId);
                return (
                  <li key={d.sessionId} className="tkt-agent">
                    <span className="tkt-agent__who">
                      <Link to={`/sessions/${encodeURIComponent(d.sessionId)}`}>
                        <code>{shortId(d.sessionId)}</code>
                      </Link>
                      <span className="tkt-agent__status">
                        {d.status === 'reported'
                          ? `reported ${d.confidence !== null ? `${Math.round(d.confidence * 100)}%` : ''}${d.reportedAt ? ` · ${formatDateTime(d.reportedAt).slice(11, 16)}` : ''}`
                          : d.status === 'running'
                            ? 'diagnosing'
                            : 'stopped without a report'}
                        {s?.model ? ` · ${s.model}` : ''}
                        {round.includes(d) ? '' : ' · earlier round'}
                      </span>
                    </span>
                    {use ? (
                      <Meter
                        size="md"
                        label="Budget"
                        value={d.tokens}
                        max={use.perAgent}
                        detail={`${formatTokens(d.tokens)} of ${formatTokens(use.perAgent)} tokens`}
                      />
                    ) : (
                      <span className="aoc-num">{formatTokens(d.tokens)} tokens</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          {use && (
            <p className="tkt-links__sub">
              Budget per agent: {formatTokens(use.perAgent)} tokens and {formatInteger(use.minutes)} minutes;
              an agent over either is stopped and the ticket bounces to a human.
            </p>
          )}
        </Widget>

        <Widget
          span={6}
          title="Request"
          subtitle={`from ${t.requesterName ?? 'the requester'} · untrusted text`}
        >
          <p className="tkt-text">{t.description}</p>
          {t.comment && (
            <>
              <p className="tkt-diag__label">Comment</p>
              <p className="tkt-text">{t.comment}</p>
            </>
          )}
        </Widget>

        <Widget
          span={6}
          title="Attachments"
          subtitle={`${t.attachments.length} file(s) · encrypted at rest`}
          info="Raw intake media stays behind the role boundary (§6): it opens only with the media permission, or for a builder whose own active session works on this ticket. Every opening is recorded in the audit log."
        >
          {t.attachments.length ? (
            <ul className="tkt-media">
              {t.attachments.map((a) => (
                <li key={a.attachmentId} className="tkt-media__item">
                  <Icon name={a.mime.startsWith('video/') ? 'console' : 'upload'} size={16} />
                  <span>
                    <span className="tkt-media__name">{a.fileName}</span>
                    <span className="tkt-media__meta aoc-num">
                      {a.mime} · {formatInteger(a.bytes)} bytes · scan {a.scan} · sha256{' '}
                      {a.sha256.slice(0, 12)}…
                    </span>
                  </span>
                  {canDownload || linkedActive ? (
                    <a
                      className="aoc-btn aoc-btn--secondary aoc-btn--sm"
                      href={`/api/tickets/${encodeURIComponent(t.ticketId)}/attachments/${encodeURIComponent(a.attachmentId)}`}
                      download
                    >
                      Open (logged)
                    </a>
                  ) : (
                    <span className="tkt-links__sub">Withheld</span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="tkt-links__sub">No attachments were filed with this ticket.</p>
          )}
          {t.attachments.length > 0 && !canDownload && !linkedActive && (
            <p className="tkt-links__sub">
              You see the ticket, not the raw media: opening it needs the media permission or your own active
              session on this ticket (§6).
            </p>
          )}
        </Widget>

        <Widget span={12} title="Linked work" subtitle="sessions and decisions this ticket spawned">
          <ul className="tkt-links">
            {sessionsLinked.map((s) => {
              const info = directory.session(s.id);
              return (
                <li key={s.id}>
                  <Icon name="console" size={12} />
                  <Link to={`/sessions/${encodeURIComponent(s.id)}`}>
                    <code>{shortId(s.id)}</code>
                  </Link>
                  <span className="tkt-links__sub">
                    {s.role}
                    {info ? ` · ${info.lifecycle}` : ''}
                  </span>
                </li>
              );
            })}
            {[...openCards, ...closedCards].map((d) => (
              <li key={d.id}>
                <Icon name="decisions" size={12} />
                <Link to={`/decisions?focus=${encodeURIComponent(d.id)}`}>{KIND_LABEL[d.kind]}</Link>
                <span className="tkt-links__sub">
                  {d.status === 'open'
                    ? `open · waiting ${formatAge(now - Date.parse(d.createdAt))}`
                    : `${outcomeLabel(d)}${d.resolution ? ` · ${requesterOf(d.resolution.resolvedBy, directory).name} · ${methodLabel(d.resolution)}` : ''}`}
                </span>
              </li>
            ))}
            {t.uatRef && (
              <li>
                <Icon name="changes" size={12} />
                <code>{t.uatRef}</code>
                <span className="tkt-links__sub">UAT branch</span>
              </li>
            )}
            {!sessionsLinked.length && !decisionMap.size && (
              <li className="tkt-links__sub">
                Nothing linked yet: triage starts when the ticket is received.
              </li>
            )}
          </ul>
        </Widget>

        <Widget span={12} title="Timeline" subtitle="newest first · from the audit log" busy={events.loading}>
          {events.data === undefined ? (
            events.error ? (
              <ErrorState
                size="sm"
                title="Couldn't load the timeline"
                error={events.error}
                onRetry={events.reload}
              />
            ) : (
              <p className="aoc-loading">Loading the timeline…</p>
            )
          ) : timeline.length ? (
            <ol className="tkt-timeline">
              {timeline.map((e) => {
                const line = describeEvent(e, directory, decisionMap);
                return (
                  <li key={e.seq} className={cx('tkt-timeline__item', `tkt-timeline__item--${line.tone}`)}>
                    <time className="tkt-timeline__at aoc-num" dateTime={e.ts} title={formatDateTime(e.ts)}>
                      {formatDateTime(e.ts).slice(5, 16)}
                    </time>
                    <Icon name={line.icon} size={14} className="tkt-timeline__icon" />
                    <span className="tkt-timeline__text">{line.text}</span>
                    {line.link ? (
                      <Link className="tkt-timeline__link" to={line.link.to}>
                        {line.link.label}
                      </Link>
                    ) : (
                      <span />
                    )}
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="tkt-links__sub">No events recorded for this ticket.</p>
          )}
        </Widget>
      </WidgetGrid>
      <CloseDialog ticket={t} open={closing} onClose={() => setClosing(false)} onClosed={reloadAll} />
    </>
  );
}
