import type {
  DecisionListResponse,
  FxStatusDTO,
  IdentityUserDto,
  MeteringSessionDTO,
  RateCardDTO,
  SessionActivityDTO,
  SessionDetail,
  SessionSummary,
  SessionTimeline as SessionTimelineDTO,
  ThreadDetail,
} from '@aoc/contracts';
import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../api/auth';
import { ApiError } from '../../api/client';
import type { StreamMessage } from '../../api/stream';
import { useResource } from '../../api/useResource';
import { StackedPhaseBar } from '../../charts/StackedPhaseBar';
import { ButtonLink } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { EmptyState, ErrorState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { AliveIndicator } from '../../components/liveness/AliveIndicator';
import { LivenessBadge } from '../../components/liveness/LivenessBadge';
import { PageHeader } from '../../components/PageHeader';
import { Widget } from '../../components/Widget';
import { useNow } from '../../lib/clock';
import { cx, useMediaQuery } from '../../lib/dom';
import { formatAge, formatClock, formatInteger, formatNumber, formatShortDate } from '../../lib/format';
import { useActivitySeqs } from '../console/useActivitySeqs';
import { EventFeed, type FeedEvent } from './EventFeed';
import { Glyph } from './glyphs';
import { buildHero, pendingStop, phaseProgress, phaseStatuses } from './model';
import { OperatorActions } from './OperatorActions';
import { PlanManifest } from './PlanManifest';
import { processTypeOf, rolloverPctFor, useProcessTypes } from './processTypes';
import { SessionDecisions } from './SessionDecisions';
import { SessionMetering } from './SessionMetering';
import { SessionTimeline } from './SessionTimeline';
import { isEnded, livenessDetail, modelLabel, sessionLiveness, shortId } from './sessionText';
import { ThreadLineage } from './ThreadLineage';
import './session.css';

const FEED_PAGE = 25;
/** At ≤640px every event is a stacked card rather than a table row, so the first page is shorter. */
const FEED_PAGE_PHONE = 10;
const FEED_MAX = 500;

const enc = encodeURIComponent;
const aoc = (m: StreamMessage) => (m.kind === 'aoc' ? m.event : null);

/** One managed (or observed) session: what it is doing, how far it got, what it cost, and the levers. */
export default function SessionPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const now = useNow();
  const activitySeqs = useActivitySeqs();

  /** Every event scoped to this session, plus the rollover that links it to a neighbour. */
  const mine = useCallback(
    (m: StreamMessage) => {
      const e = aoc(m);
      if (!e) return false;
      if (e.scope.sessionId === id) return true;
      return e.type.startsWith('session.rollover') && (e.meta.fromSessionId === id || e.meta.toSessionId === id);
    },
    [id],
  );

  const detail = useResource<SessionDetail>(`/api/sessions/${enc(id)}`, { refreshOn: mine });
  const d = detail.data;
  const timeline = useResource<SessionTimelineDTO>(`/api/sessions/${enc(id)}/timeline`, {
    refreshOn: (m) => mine(m) || (aoc(m)?.type.startsWith('rollback.') ?? false),
  });
  const activity = useResource<SessionActivityDTO>(`/api/sessions/${enc(id)}/activity`, {
    refreshOn: (m) => mine(m) && /^(tool|throttle)\./.test(aoc(m)!.type),
  });
  const decisions = useResource<DecisionListResponse>('/api/decisions', {
    query: { sessionId: id },
    refreshOn: (m) => aoc(m)?.type.startsWith('decision.') ?? false,
  });
  const phone = useMediaQuery('(max-width: 640px)');
  const [feedLimit, setFeedLimit] = useState(phone ? FEED_PAGE_PHONE : FEED_PAGE);
  const events = useResource<FeedEvent[]>(`/api/sessions/${enc(id)}/events`, { query: { limit: feedLimit }, refreshOn: mine });
  const metering = useResource<MeteringSessionDTO>(d && d.tokens.length > 0 ? `/api/metering/sessions/${enc(id)}` : null, {
    refreshOn: (m) => mine(m) && /^(usage|throttle|task)\./.test(aoc(m)!.type),
  });
  const rateCard = useResource<RateCardDTO>('/api/ratecard', { refreshOn: (m) => aoc(m)?.type.startsWith('ratecard.') ?? false });
  const fx = useResource<FxStatusDTO>('/api/fx/status', { refreshOn: (m) => aoc(m)?.type.startsWith('fx.') ?? false });
  const registry = useProcessTypes();
  const thread = useResource<ThreadDetail>(d?.threadId ? `/api/threads/${enc(d.threadId)}` : null, {
    refreshOn: (m) => /^(session\.rollover|session\.launch_requested|thread\.)/.test(aoc(m)?.type ?? ''),
  });
  const projectSessions = useResource<SessionSummary[]>(d?.projectId ? '/api/sessions' : null, {
    query: { projectId: d?.projectId ?? undefined },
    refreshOn: (m) => /^session\.(launch_requested|ended|rollover_completed|lifecycle_changed)$/.test(aoc(m)?.type ?? ''),
  });
  const users = useResource<{ users: IdentityUserDto[] }>(user?.role === 'approver' ? '/api/users' : null);

  const sessionsById = useMemo(
    () => new Map((projectSessions.data ?? []).map((s) => [s.sessionId, s])),
    [projectSessions.data],
  );
  const nameOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const s of projectSessions.data ?? []) if (s.ownerId && s.ownerName) names.set(s.ownerId, s.ownerName);
    for (const u of users.data?.users ?? []) names.set(u.id, u.name);
    if (d?.ownerId && d.ownerName) names.set(d.ownerId, d.ownerName);
    if (user) names.set(user.id, `${user.name} (you)`);
    return (uid: string) => names.get(uid) ?? null;
  }, [projectSessions.data, users.data, d?.ownerId, d?.ownerName, user]);

  const hero = useMemo(
    () => (timeline.data ? buildHero(timeline.data, activity.data, decisions.data?.decisions) : null),
    [timeline.data, activity.data, decisions.data],
  );

  const reloadAfterAction = () => {
    detail.reload();
    events.reload();
    timeline.reload();
  };

  if (d === undefined) {
    if (detail.error instanceof ApiError && detail.error.status === 404) {
      return (
        <>
          <PageHeader title="Session not found" breadcrumbs={[{ label: 'Console', to: '/console' }, { label: shortId(id) }]} />
          <EmptyState
            icon="console"
            title="No session with this id"
            body={
              <>
                <code>{id}</code> is not in the event log. It may have been mistyped, or it belongs to a different AOC
                instance.
              </>
            }
            action={<ButtonLink to="/console">Back to the console</ButtonLink>}
          />
        </>
      );
    }
    if (detail.error) {
      return (
        <>
          <PageHeader title="Session" breadcrumbs={[{ label: 'Console', to: '/console' }, { label: shortId(id) }]} />
          <ErrorState title="Couldn't load this session" error={detail.error} onRetry={detail.reload} />
        </>
      );
    }
    return <SessionSkeleton />;
  }

  const state = sessionLiveness(d);
  const type = processTypeOf(registry.data, d.processType);
  const rolloverPct = rolloverPctFor(registry.data, d.processType);
  const manifest = timeline.data?.manifest ?? [];
  const statuses = phaseStatuses(manifest);
  const upcoming = manifest
    .filter((p) => statuses.get(p.phaseId) === 'pending' && !timeline.data?.phases.some((b) => b.phaseId === p.phaseId))
    .sort((a, b) => a.order - b.order)
    .map((p) => `P${p.order + 1} ${p.name}`);
  const lastEvent = events.data?.[0]?.ts ?? d.lastActivityAt;
  const amendments = timeline.data?.amendments ?? [];
  const lastAmendment = amendments[amendments.length - 1];

  return (
    <div className="session-page">
      <div className="session-head">
        <div className="session-head__main">
          <PageHeader
            title={d.title}
            documentTitle={`${d.title} · Session`}
            breadcrumbs={[
              { label: 'Console', to: '/console' },
              ...(d.projectId ? [{ label: d.projectName ?? d.projectId, to: `/projects/${enc(d.projectId)}` }] : []),
              { label: shortId(d.sessionId) },
            ]}
            meta={
              <>
                <LivenessBadge state={state} detail={livenessDetail(d, now)} announce title={d.liveness?.reason} />
                {!isEnded(d) && state !== 'dead' && (
                  <span className="session-alive">
                    <AliveIndicator activitySeq={activitySeqs.get(d.sessionId)} state={state} />
                    {lastEvent ? (
                      <>
                        last event <time dateTime={lastEvent}>{formatClock(lastEvent)}</time>
                      </>
                    ) : (
                      'no events yet'
                    )}
                  </span>
                )}
              </>
            }
          />
          <div className="session-facts">
            {d.processType && (
              <Chip>
                {d.processType}
                {type ? ` · ${type.class}` : ''}
              </Chip>
            )}
            {d.model && <Chip className="session-chip--model">{modelLabel(d.model)}</Chip>}
            {d.mode === 'managed' ? (
              <Chip>
                <Glyph name="shield" size={12} /> Managed
              </Chip>
            ) : (
              <Chip icon="eye">Observed · read-only</Chip>
            )}
            {d.readOnly && d.mode === 'managed' && <Chip icon="eye-off">Read-only triage</Chip>}
            {d.projectId && (
              <span>
                <Link to={`/projects/${enc(d.projectId)}`}>{d.projectName ?? d.projectId}</Link>
                {thread.data && (
                  <>
                    {' · '}
                    {thread.data.title}, {formatInteger(thread.data.sessionIds.length)}{' '}
                    {thread.data.sessionIds.length === 1 ? 'session' : 'sessions'}
                  </>
                )}
              </span>
            )}
            <span className="session-facts__owner">
              <Icon name="user" size={12} /> {d.ownerName ?? (d.mode === 'observed' ? 'developer terminal' : 'unassigned')}
            </span>
            <span>
              Started {formatClock(d.startedAt)}
              {now - Date.parse(d.startedAt) > 20 * 3600_000 ? ` ${formatShortDate(d.startedAt)}` : ''} ·{' '}
              {formatAge((d.endedAt ? Date.parse(d.endedAt) : now) - Date.parse(d.startedAt))}
              {d.endedAt ? ` · ended ${formatClock(d.endedAt)}` : ''} · {formatInteger(d.turns)}{' '}
              {d.turns === 1 ? 'turn' : 'turns'}
            </span>
            {d.ticketId && <Link to={`/tickets/${enc(d.ticketId)}`}>Ticket {shortId(d.ticketId)}</Link>}
          </div>
        </div>
        <OperatorActions
          session={d}
          pendingStop={pendingStop(events.data, d)}
          threadWriter={thread.data?.activeWriterSessionId}
          onDone={reloadAfterAction}
        />
      </div>

      <Widget
        span={12}
        title="Session timeline"
        subtitle={
          hero
            ? `Phases to scale by elapsed time · ${formatClock(hero.start)}–${hero.ended ? formatClock(hero.end) : `now ${formatClock(hero.end)}`}`
            : 'Phases to scale by elapsed time'
        }
        className="session-hero"
      >
        {hero ? (
          <>
            <dl className="session-tlstats">
              <div>
                <dt>Elapsed</dt>
                <dd className="aoc-num">{formatAge(hero.stats.elapsedMs)}</dd>
              </div>
              <div>
                <dt>Tool calls</dt>
                <dd className="aoc-num">{formatInteger(hero.stats.toolCalls)}</dd>
              </div>
              <div>
                <dt>Avg per active min</dt>
                <dd className="aoc-num">
                  {hero.stats.activeMinutes > 0 ? formatNumber(hero.stats.toolCalls / hero.stats.activeMinutes, 1) : '—'}
                </dd>
              </div>
              <div>
                <dt>Decisions</dt>
                <dd className="aoc-num">
                  {formatInteger(hero.stats.decisions)}
                  {hero.stats.decisions > 0 && (
                    <span className="session-tlstats__sub">
                      {' · '}
                      {formatAge(hero.stats.decisionWaitMs)} waiting
                      {hero.stats.openDecisions > 0 ? `, ${hero.stats.openDecisions} open` : ''}
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Drift marks</dt>
                <dd className="aoc-num">{formatInteger(hero.stats.drift)}</dd>
              </div>
              <div>
                <dt>Rollbacks</dt>
                <dd className="aoc-num">{formatInteger(hero.stats.rollbacks)}</dd>
              </div>
              <div>
                <dt>Throttled</dt>
                <dd className="aoc-num">{hero.stats.throttledMs > 0 ? formatAge(hero.stats.throttledMs) : '0m'}</dd>
              </div>
            </dl>
            <SessionTimeline model={hero} upcoming={upcoming} />
            <div className="session-completion">
              <h3 className="session-minihead">Plan completion</h3>
              {manifest.length > 0 ? (
                <>
                  <StackedPhaseBar phases={phaseProgress(manifest)} label="Plan completion by phase" />
                  {lastAmendment && (
                    <p className="session-completion__note">
                      <Glyph name="plus-circle" size={12} /> Denominator changed {formatClock(lastAmendment.at)} (amendment
                      #{amendments.length}, weight {lastAmendment.prevTotalWeight} → {lastAmendment.newTotalWeight}).
                    </p>
                  )}
                </>
              ) : (
                <p className="session-empty-line">
                  {d.mode === 'observed'
                    ? 'Observed sessions declare no plan; their activity is logged but never counts as progress.'
                    : 'No plan declared yet. A managed session declares its plan before touching code (§4).'}
                </p>
              )}
            </div>
          </>
        ) : timeline.error ? (
          <ErrorState size="sm" title="Couldn't load the timeline" error={timeline.error} onRetry={timeline.reload} />
        ) : (
          <div className="session-skeleton__block session-skeleton__block--hero" role="status" aria-label="Loading the timeline" />
        )}
      </Widget>

      <div className="session-body">
        <Widget
          span={12}
          className="session-body__manifest"
          title="Plan manifest"
          subtitle={`${d.threadId ? `${thread.data?.title ?? 'Thread'} · ` : ''}manifest v${1 + amendments.length} · weights xs 1 · s 2 · m 3 · l 5 · xl 8`}
        >
          {timeline.data ? (
            <PlanManifest manifest={manifest} amendments={amendments} nameOf={nameOf} now={now} />
          ) : timeline.error ? (
            <ErrorState size="sm" error={timeline.error} onRetry={timeline.reload} />
          ) : (
            <p className="aoc-loading">Loading the manifest…</p>
          )}
        </Widget>
        <div className="session-body__side">
          <Widget span={12} title="Metering" subtitle="Notional API-equivalent · Max plan, so not a bill">
            {metering.error && !metering.data ? (
              <ErrorState size="sm" title="Couldn't load metering" error={metering.error} onRetry={metering.reload} />
            ) : (
              <SessionMetering
                session={d}
                metering={metering.data}
                rateCard={rateCard.data}
                rolloverPct={rolloverPct}
                fxRate={fx.data?.current ?? null}
              />
            )}
          </Widget>
          <Widget span={12} title="Thread lineage" subtitle="One writer per thread · rollovers only at clean task boundaries">
            <ThreadLineage session={d} thread={thread.data} sessions={sessionsById} now={now} />
          </Widget>
        </div>
      </div>

      <div className="session-lower">
        <Widget
          span={12}
          id="decisions"
          title="Decisions"
          subtitle={
            hero && hero.stats.decisions > 0
              ? `${formatInteger(hero.stats.decisions)} raised · ${formatAge(hero.stats.decisionWaitMs)} waiting in total`
              : 'Raised by this session'
          }
        >
          {decisions.data ? (
            <SessionDecisions decisions={decisions.data.decisions} nameOf={nameOf} now={now} onResolved={decisions.reload} />
          ) : decisions.error ? (
            <ErrorState size="sm" title="Couldn't load decisions" error={decisions.error} onRetry={decisions.reload} />
          ) : (
            <p className="aoc-loading">Loading decisions…</p>
          )}
        </Widget>
        <Widget
          span={12}
          title="Event log"
          subtitle="This session's slice of the hash-chained log · gaps in seq are other sessions"
          actions={
            <Link to={`/audit?sessionId=${enc(d.sessionId)}&range=all`} className="session-link-sm">
              Open in Audit
            </Link>
          }
        >
          {events.data ? (
            <EventFeed
              events={events.data}
              limit={feedLimit}
              nameOf={nameOf}
              onMore={feedLimit < FEED_MAX ? () => setFeedLimit((n) => Math.min(FEED_MAX, n * 4)) : null}
            />
          ) : events.error ? (
            <ErrorState size="sm" title="Couldn't load events" error={events.error} onRetry={events.reload} />
          ) : (
            <p className="aoc-loading">Loading events…</p>
          )}
        </Widget>
      </div>
    </div>
  );
}

/** Holds the page's shape while the session loads (static blocks, no animation). */
function SessionSkeleton() {
  return (
    <div className={cx('session-page', 'session-skeleton')} role="status" aria-label="Loading the session">
      <span className="session-skeleton__block session-skeleton__block--title" />
      <span className="session-skeleton__block session-skeleton__block--hero" />
      <div className="session-skeleton__row">
        <span className="session-skeleton__block session-skeleton__block--panel" />
        <span className="session-skeleton__block session-skeleton__block--panel" />
      </div>
    </div>
  );
}
