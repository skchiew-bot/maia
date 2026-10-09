import type { ConsoleSnapshot, DecisionListResponse, ProjectSummary } from '@aoc/contracts';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useEventStream, useStreamStatus } from '../../api/stream';
import { useResource } from '../../api/useResource';
import { ChartTable, useElementWidth } from '../../charts/shared';
import {
  ButtonLink,
  EmptyState,
  ErrorState,
  InlineAlert,
  LIVENESS_META,
  LIVENESS_PRECEDENCE,
  LivenessBadge,
  PageHeader,
  RelativeTime,
  Widget,
  formatAge,
  formatClock,
  formatInteger,
  formatPercent,
  useNow,
  type LivenessState,
} from '../../components';
import { cx } from '../../lib/dom';
import { EventFeed } from './EventFeed';
import { FleetTrack, nodeColor } from './FleetTrack';
import {
  buildLanes,
  changesMap,
  changesProjects,
  feedItem,
  isDecisionEvent,
  livenessCounts,
  pushFeed,
  type FeedItem,
  type LaneModel,
  type TrackModel,
} from './model';
import { useManifests } from './useManifests';
import './showcase.css';

const FEED_LENGTH = 8;

type Filter = LivenessState | 'all';

/**
 * Showcase (§12): optional and never the landing view. A live 2D map of the fleet, driven only by the event
 * stream: sessions move along their plan's phases, decisions wait as purple diamonds, throttles and stalls are
 * marked. Nothing animates at rest; with reduced motion every change is instant.
 */
export default function ShowcasePage() {
  const snapshot = useResource<ConsoleSnapshot>('/api/console', { refreshOn: changesMap });
  const projects = useResource<ProjectSummary[]>('/api/projects', { refreshOn: changesProjects });
  const decisions = useResource<DecisionListResponse>('/api/decisions', {
    query: { status: 'open' },
    refreshOn: isDecisionEvent,
  });
  const connection = useStreamStatus();
  const now = useNow();
  const [filter, setFilter] = useState<Filter>('all');
  const [showFinished, setShowFinished] = useState(false);
  const [activity, setActivity] = useState<ReadonlyMap<string, number>>(() => new Map());
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [lastEvent, setLastEvent] = useState<{ seq: number; ts: string } | null>(null);

  useEventStream((m) => {
    if (m.kind === 'aoc') {
      setLastEvent({ seq: m.event.seq, ts: m.event.ts });
      const sid = m.event.scope.sessionId;
      if (sid) setActivity((prev) => new Map(prev).set(sid, m.event.seq));
    }
    const item = feedItem(m);
    if (item) setFeed((prev) => pushFeed(prev, item, FEED_LENGTH));
  });

  const sessions = snapshot.data?.sessions;
  const visibleIds = useMemo(
    () =>
      (sessions ?? [])
        .filter((s) => s.mode === 'managed' && (showFinished || !['ended', 'retired'].includes(s.lifecycle)))
        .map((s) => s.sessionId),
    [sessions, showFinished],
  );
  const manifests = useManifests(visibleIds);

  const lanes = useMemo(
    () =>
      snapshot.data
        ? buildLanes({
            console: snapshot.data,
            projects: projects.data,
            manifests,
            decisions: decisions.data?.decisions,
          })
        : [],
    [snapshot.data, projects.data, manifests, decisions.data],
  );
  const counts = useMemo(() => livenessCounts(lanes), [lanes]);
  const finishedCount = lanes.reduce((n, l) => n + l.tracks.filter((t) => t.finished).length, 0);
  const openDecisions = decisions.data?.decisions.filter((d) => d.status === 'open').length;
  const titles = useMemo(() => new Map((sessions ?? []).map((s) => [s.sessionId, s.title])), [sessions]);
  const active: Filter = filter !== 'all' && !counts.get(filter) ? 'all' : filter;

  const shown = (t: TrackModel) =>
    (showFinished || !t.finished) && (active === 'all' || (!t.finished && t.liveness === active));

  return (
    <div className="sc-page">
      <PageHeader
        title="Showcase"
        subtitle="A live map of the fleet. Each session moves along its own plan, and only when an event moves it."
        actions={
          <ButtonLink to="/console" variant="ghost" icon="console">
            Open console
          </ButtonLink>
        }
        meta={
          <>
            <span>2D view</span>
            <span>
              {connection === 'live'
                ? 'Live'
                : connection === 'reconnecting'
                  ? 'Reconnecting…'
                  : connection === 'connecting'
                    ? 'Connecting…'
                    : 'Offline'}
            </span>
            <span className="aoc-num">
              {lastEvent ? (
                <>
                  Last event #{formatInteger(lastEvent.seq)} at {formatClock(lastEvent.ts)}
                </>
              ) : (
                'No event since this page opened'
              )}
            </span>
          </>
        }
      />
      {connection === 'reconnecting' && (
        <InlineAlert tone="warn" title="Live updates paused">
          The event stream dropped. The map holds its last state and catches up as soon as it reconnects.
        </InlineAlert>
      )}
      {snapshot.data === undefined ? (
        snapshot.error ? (
          <ErrorState title="Couldn't load the fleet" error={snapshot.error} onRetry={snapshot.reload} />
        ) : (
          <p className="aoc-loading" role="status">
            Loading the fleet…
          </p>
        )
      ) : (
        <>
          <div className="sc-summary">
            <div className="sc-filters" role="group" aria-label="Show sessions by liveness">
              <button
                type="button"
                className={cx('sc-filter', active === 'all' && 'is-pressed')}
                aria-pressed={active === 'all'}
                onClick={() => setFilter('all')}
              >
                All live <span className="sc-filter__count aoc-num">{[...counts.values()].reduce((a, b) => a + b, 0)}</span>
              </button>
              {LIVENESS_PRECEDENCE.filter((s) => counts.get(s)).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={cx('sc-filter', active === s && 'is-pressed')}
                  aria-pressed={active === s}
                  onClick={() => setFilter(active === s ? 'all' : s)}
                >
                  <LivenessBadge state={s} size="sm" />
                  <span className="sc-filter__count aoc-num">{counts.get(s)}</span>
                </button>
              ))}
            </div>
            <div className="sc-stats">
              <Link to="/decisions" className="sc-stat">
                <DecisionGlyph />
                <span className="aoc-num">{openDecisions ?? '—'}</span> decisions waiting
              </Link>
              <span className="sc-stat">
                <span className="aoc-num">{formatInteger(snapshot.data.kpis.tasksDoneToday)}</span> tasks done today ·{' '}
                <span className="aoc-num">{formatPercent(snapshot.data.kpis.tasksDoneWithEvidencePct / 100)}</span> with
                evidence
              </span>
            </div>
          </div>
          <div className="sc-layout">
            <Widget
              span={12}
              title="Fleet map"
              subtitle="phases to scale by declared weight"
              info="Each row is one session's own plan: phases are sized by declared task weight and the dark fill is the weight done. The dot is the session, coloured by its liveness; it moves when a task is done. A purple diamond is a decision waiting on a person, with its age."
              className="sc-map"
              flush
            >
              <Legend />
              {lanes.length === 0 ? (
                <EmptyState
                  size="sm"
                  icon="showcase"
                  title="No sessions yet"
                  body="Sessions appear here as soon as one is launched."
                />
              ) : (
                lanes.map((lane) => <Lane key={lane.key} lane={lane} show={shown} now={now} activity={activity} />)
              )}
              {finishedCount > 0 && (
                <div className="sc-map__more">
                  <button type="button" className="aoc-link-button" onClick={() => setShowFinished((v) => !v)}>
                    {showFinished
                      ? 'Hide sessions that finished in the last 6 hours'
                      : `Show ${finishedCount} session${finishedCount === 1 ? '' : 's'} that finished in the last 6 hours`}
                  </button>
                </div>
              )}
            </Widget>
            <Widget span={12} title="Latest events" subtitle="as they arrive" className="sc-feed-widget">
              <EventFeed items={feed} titles={titles} />
            </Widget>
          </div>
          <DataTwin lanes={lanes} now={now} />
        </>
      )}
    </div>
  );
}

function Lane({
  lane,
  show,
  now,
  activity,
}: {
  lane: LaneModel;
  show: (t: TrackModel) => boolean;
  now: number;
  activity: ReadonlyMap<string, number>;
}) {
  const tracks = lane.tracks.filter(show);
  const planned = tracks.filter((t) => t.phases.length > 0);
  const unplanned = tracks.filter((t) => t.phases.length === 0);
  const live = lane.tracks.filter((t) => !t.finished).length;
  const waiting = lane.tracks.filter((t) => !t.finished && t.decision).length + lane.decisions.length;
  const headingId = `lane-${lane.key}`;
  return (
    <section className="sc-lane" aria-labelledby={headingId}>
      <header className="sc-lane__head">
        <h3 id={headingId} className="sc-lane__name">
          {lane.projectId ? <Link to={`/projects/${encodeURIComponent(lane.projectId)}`}>{lane.name}</Link> : lane.name}
        </h3>
        {lane.progressPct !== null && (
          <span className="sc-lane__progress">
            <span className="sc-lane__bar" aria-hidden="true">
              <span style={{ width: `${Math.min(100, Math.max(0, lane.progressPct))}%` }} />
            </span>
            <span className="aoc-num">{formatPercent(lane.progressPct / 100)}</span> of the project plan done
          </span>
        )}
        <span className="sc-lane__counts aoc-num">
          {live} live · {waiting} waiting on a decision
        </span>
      </header>
      {tracks.length === 0 && (lane.projectId !== null || lane.tracks.length > 0) && (
        <p className="sc-lane__empty">No sessions {lane.tracks.length ? 'match this filter' : 'running'} on this project.</p>
      )}
      {planned.length > 0 && (
        <ul className="sc-rows">
          {planned.map((t) => (
            <TrackRow key={t.sessionId} track={t} now={now} activitySeq={activity.get(t.sessionId) ?? null} />
          ))}
        </ul>
      )}
      {unplanned.length > 0 && <Unplanned tracks={unplanned} now={now} />}
      {lane.decisions.length > 0 && (
        <div className="sc-decisions">
          <span className="sc-decisions__label">Waiting on a decision</span>
          <ul className="sc-decisions__list">
            {lane.decisions.map((d) => (
              <li key={d.id}>
                <Link to="/decisions" className="sc-decision">
                  <DecisionGlyph />
                  <span>{d.label}</span>
                  <RelativeTime value={d.createdAt} now={now} className="sc-decision__age" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** Sessions with no plan to move along (observed, triage, not yet declared): one dot each, by liveness. */
function Unplanned({ tracks, now }: { tracks: readonly TrackModel[]; now: number }) {
  const byState = new Map<LivenessState | 'finished', number>();
  for (const t of tracks) {
    const k = t.finished ? 'finished' : (t.liveness ?? 'finished');
    byState.set(k, (byState.get(k) ?? 0) + 1);
  }
  return (
    <div className="sc-row sc-row--unplanned">
      <div className="sc-row__label">
        <span className="sc-row__title">
          {tracks.length} session{tracks.length === 1 ? '' : 's'} without a plan
        </span>
        <span className="sc-row__meta">
          {[...byState].map(([state, n]) => (
            <span key={state} className="sc-unplanned__count">
              <LivenessBadge state={state === 'finished' ? 'ended' : state} size="sm" />
              <span className="aoc-num">{n}</span>
            </span>
          ))}
        </span>
      </div>
      <ul className="sc-dots" aria-label="Sessions without a plan">
        {tracks.map((t) => (
          <li key={t.sessionId}>
            <Link
              to={`/sessions/${encodeURIComponent(t.sessionId)}`}
              className="sc-dot"
              aria-label={trackSummary(t, now)}
              title={t.title}
              style={{ background: nodeColor(t) }}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function trackSummary(t: TrackModel, now: number): string {
  const state = t.finished ? 'finished' : t.liveness ? LIVENESS_META[t.liveness].word : 'state unknown';
  const parts = [`${t.title}: ${state}`];
  if (t.phases.length) {
    const p = t.phases[t.currentPhase];
    parts.push(
      `phase ${p?.name ?? '—'} (${t.currentPhase + 1} of ${t.phases.length})`,
      `${formatInteger(t.doneWeight)} of ${formatInteger(t.totalWeight)} weight done (${formatPercent(t.totalWeight ? t.doneWeight / t.totalWeight : 0)})`,
    );
  } else parts.push(t.mode === 'observed' ? 'observed, read-only' : 'no plan declared');
  if (t.decision) parts.push(`decision waiting ${ageSince(now, t.decision.since)}`);
  if (t.liveness === 'throttled' && t.throttledUntil) parts.push(`resets at ${formatClock(t.throttledUntil)}`);
  return parts.join(', ');
}

function TrackRow({ track, now, activitySeq }: { track: TrackModel; now: number; activitySeq: number | null }) {
  const [ref, width] = useElementWidth<HTMLDivElement>(480);
  const phase = track.phases[track.currentPhase];
  const pct = track.totalWeight ? track.doneWeight / track.totalWeight : 0;
  const detail = track.finished
    ? undefined
    : track.decision
      ? `decision ${ageSince(now, track.decision.since)}`
      : track.liveness === 'throttled' && track.throttledUntil
        ? `resets ${formatClock(track.throttledUntil)}`
        : undefined;
  return (
    <li className={cx('sc-row', track.finished && 'is-finished')}>
      <div className="sc-row__label">
        <Link
          to={`/sessions/${encodeURIComponent(track.sessionId)}`}
          className="sc-row__title"
          title={track.title}
        >
          {track.title}
        </Link>
        <span className="sc-row__meta">
          <LivenessBadge state={track.finished ? 'ended' : (track.liveness ?? 'ended')} size="sm" detail={detail} />
          {track.processType && <span>{track.processType}</span>}
          {phase && (
            <span>
              {phase.name} <span className="aoc-num">{track.currentPhase + 1}/{track.phases.length}</span>
            </span>
          )}
          {track.totalWeight > 0 && <span className="aoc-num">{formatPercent(pct)}</span>}
        </span>
      </div>
      <div className="sc-row__track" ref={ref}>
        <FleetTrack track={track} width={width} now={now} activitySeq={activitySeq} label={trackSummary(track, now)} />
      </div>
    </li>
  );
}

const ageSince = (now: number, since: string) => formatAge(now - Date.parse(since));

function DecisionGlyph() {
  return (
    <svg className="sc-diamond" width={12} height={12} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <path d="M6,0.5L11.5,6L6,11.5L0.5,6Z" />
    </svg>
  );
}

function Legend() {
  return (
    <ul className="sc-legend" aria-label="Legend">
      <li>
        <svg width={34} height={12} aria-hidden="true">
          <rect className="sc-seg" x={1} y={2} width={32} height={8} rx={2} />
          <rect className="sc-seg__done" x={1} y={2} width={18} height={8} rx={2} />
        </svg>
        Phase, done weight dark
      </li>
      <li>
        <svg width={14} height={14} aria-hidden="true">
          <circle cx={7} cy={7} r={6} style={{ fill: 'var(--live-working)' }} />
        </svg>
        Session, coloured by liveness
      </li>
      <li>
        <DecisionGlyph />
        Decision waiting, with its age
      </li>
      <li>
        <svg width={12} height={12} viewBox="-6 -6 12 12" aria-hidden="true">
          <path className="sc-glyph sc-glyph--throttle" d="M-4.5,-6H4.5L0,0L4.5,6H-4.5L0,0Z" />
        </svg>
        Throttled, with reset time
      </li>
      <li>
        <svg width={14} height={12} viewBox="-7 -6 14 12" aria-hidden="true">
          <path className="sc-glyph sc-glyph--stalled" d="M0,-6L6.5,5H-6.5Z" />
        </svg>
        Stalled
      </li>
      <li>
        <svg width={12} height={12} viewBox="-6 -6 12 12" aria-hidden="true">
          <rect className="sc-glyph sc-glyph--dead" x={-5} y={-5} width={10} height={10} rx={1.5} />
        </svg>
        Dead
      </li>
    </ul>
  );
}

/** The map as a table: every mark's numbers in text (screen readers, phones). */
function DataTwin({ lanes, now }: { lanes: readonly LaneModel[]; now: number }) {
  const rows = lanes.flatMap((lane) => [
    ...lane.tracks.map((t) => [
      lane.name,
      t.title,
      t.finished ? 'Finished' : t.liveness ? LIVENESS_META[t.liveness].word : '—',
      t.phases[t.currentPhase]?.name ?? '—',
      t.totalWeight ? `${formatInteger(t.doneWeight)}/${formatInteger(t.totalWeight)}` : '—',
      t.totalWeight ? formatPercent(t.doneWeight / t.totalWeight) : '—',
      t.decision ? `Decision, ${ageSince(now, t.decision.since)}` : t.liveness === 'throttled' && t.throttledUntil ? `Resets ${formatClock(t.throttledUntil)}` : '',
    ]),
    ...lane.decisions.map((d) => [lane.name, '—', 'Decision waiting', '—', '—', '—', `${d.label}, ${ageSince(now, d.createdAt)}`]),
  ]);
  return (
    <ChartTable
      summary="Fleet map as a table"
      caption="Sessions and waiting decisions by project"
      columns={['Project', 'Session', 'State', 'Phase', 'Weight done', 'Done', 'Waiting']}
      rows={rows}
      numericColumns={[4, 5]}
    />
  );
}
