import type { ConsoleSnapshot, DecisionListResponse, FxStatusDTO, SessionSummary } from '@aoc/contracts';
import { useCallback, useId, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../api/auth';
import type { StreamMessage } from '../../api/stream';
import { useResource } from '../../api/useResource';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { EmptyState, ErrorState } from '../../components/EmptyState';
import { Select } from '../../components/Field';
import { KpiStrip, KpiTile } from '../../components/KpiStrip';
import { FilterBar } from '../../components/Layout';
import { LIVENESS_META } from '../../components/liveness/liveness';
import { PageHeader } from '../../components/PageHeader';
import { useNow } from '../../lib/clock';
import {
  formatAge,
  formatClock,
  formatInteger,
  formatMyr,
  formatNumber,
  formatPercent,
  formatUsd,
} from '../../lib/format';
import { rolloverPctFor, useProcessTypes } from '../sessions/processTypes';
import { DecisionRail } from './DecisionRail';
import { EndedToday } from './EndedToday';
import { FleetCounts } from './FleetCounts';
import {
  FLAT_AFTER_MINUTES,
  applyFilters,
  filterOptions,
  filtersFromParams,
  filtersToParams,
  fleetCounts,
  hasFilters,
  NO_FILTERS,
  openDecisionsOldestFirst,
  projectCount,
  sharedApmMax,
  sortByPrecedence,
  splitSessions,
  type ConsoleFilters,
  type LiveState,
} from './model';
import { SessionTile } from './SessionTile';
import { useActivitySeqs } from './useActivitySeqs';
import './console.css';

const CONSOLE_EVENT = /^(session|tool|usage|task|plan|phase|throttle|decision|project|user)\./;
const isAoc = (m: StreamMessage, re: RegExp) => m.kind === 'aoc' && re.test(m.event.type);

const ACTIVE_LIFECYCLES = new Set(['launching', 'running', 'idle', 'waiting_decision', 'blocked', 'throttled']);

/** The Builder landing (§12 console hero): every session's activity on one shared scale, then what waits on people. */
export default function ConsolePage() {
  const { user } = useAuth();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const filters = filtersFromParams(params);
  const setFilters = useCallback(
    (next: Partial<ConsoleFilters>) => setParams(filtersToParams({ ...filtersFromParams(params), ...next }), { replace: true }),
    [params, setParams],
  );

  const snapshot = useResource<ConsoleSnapshot>('/api/console', { refreshOn: (m) => isAoc(m, CONSOLE_EVENT) });
  const decisions = useResource<DecisionListResponse>('/api/decisions', {
    query: { status: 'open' },
    refreshOn: (m) => isAoc(m, /^decision\./),
  });
  const fx = useResource<FxStatusDTO>('/api/fx/status', { refreshOn: (m) => isAoc(m, /^fx\./) });
  const registry = useProcessTypes();
  const activity = useActivitySeqs();

  const data = snapshot.data;
  const split = useMemo(() => (data ? splitSessions(data) : { live: [], endedToday: [] }), [data]);
  const options = useMemo(() => filterOptions(data?.sessions ?? []), [data]);
  const visible = useMemo(
    () => sortByPrecedence(applyFilters(split.live, filters, user?.id ?? null)),
    // filters is rebuilt from params each render; its fields are the real dependencies
    [split.live, filters.project, filters.liveness, filters.owner, filters.mine, user?.id],
  );
  const endedVisible = useMemo(
    () => applyFilters(split.endedToday, { ...filters, liveness: '' }, user?.id ?? null),
    [split.endedToday, filters.project, filters.owner, filters.mine, user?.id],
  );
  const counts = useMemo(
    () => fleetCounts(applyFilters(split.live, { ...filters, liveness: '' }, user?.id ?? null)),
    [split.live, filters.project, filters.owner, filters.mine, user?.id],
  );
  const apmMax = useMemo(() => sharedApmMax(split.live), [split.live]);
  const open = useMemo(() => openDecisionsOldestFirst(decisions.data?.decisions ?? []), [decisions.data]);
  const sessionsById = useMemo(
    () => new Map<string, SessionSummary>((data?.sessions ?? []).map((s) => [s.sessionId, s])),
    [data],
  );

  const activeSessions = split.live.filter((s) => ACTIVE_LIFECYCLES.has(s.lifecycle));
  const subtitle = data
    ? `${formatInteger(data.kpis.activeSessions)} active ${data.kpis.activeSessions === 1 ? 'session' : 'sessions'} · updated ${formatClock(data.generatedAt)}`
    : 'Every session at a glance, live from the event stream.';

  return (
    <div className="console-page">
      <PageHeader title="Console" subtitle={subtitle} />
      {data === undefined ? (
        snapshot.error ? (
          <ErrorState title="Couldn't load the console" error={snapshot.error} onRetry={snapshot.reload} />
        ) : (
          <ConsoleSkeleton />
        )
      ) : (
        <>
          <ConsoleKpis
            snapshot={data}
            active={activeSessions}
            dead={split.live.length - activeSessions.length}
            openDecisions={open}
            fx={fx.data}
            now={now}
          />
          <FilterBar
            label="Console filters"
            end={
              <>
                <span aria-live="polite">
                  {formatInteger(visible.length)} of {formatInteger(split.live.length)} live sessions
                </span>
                {hasFilters(filters) && (
                  <Button size="sm" variant="ghost" icon="close" onClick={() => setParams(filtersToParams(NO_FILTERS), { replace: true })}>
                    Clear filters
                  </Button>
                )}
              </>
            }
          >
            <Select
              label="Project"
              fieldClassName="console-filter"
              value={filters.project}
              onChange={(e) => setFilters({ project: e.target.value })}
              options={[{ value: '', label: 'All projects' }, ...options.projects]}
            />
            <Select
              label="Liveness"
              fieldClassName="console-filter"
              value={filters.liveness}
              onChange={(e) => setFilters({ liveness: e.target.value as LiveState | '' })}
              options={[
                { value: '', label: 'Every state' },
                ...counts.map((c) => ({ value: c.state, label: `${LIVENESS_META[c.state].word} (${c.count})` })),
              ]}
            />
            <Select
              label="Owner"
              fieldClassName="console-filter"
              value={filters.owner}
              onChange={(e) => setFilters({ owner: e.target.value })}
              options={[{ value: '', label: 'Everyone' }, ...options.owners]}
            />
            <Chip selected={filters.mine} onToggle={(mine) => setFilters({ mine })} className="console-filter__mine">
              Mine
            </Chip>
          </FilterBar>

          <div className="console-layout">
            <ActivitySection
              sessions={visible}
              total={split.live.length}
              counts={counts}
              filters={filters}
              onLiveness={(liveness) => setFilters({ liveness })}
              onClear={() => setParams(filtersToParams(NO_FILTERS), { replace: true })}
              apmMax={apmMax}
              rollover={(type) => rolloverPctFor(registry.data, type)}
              activity={activity}
              now={now}
            />
            <div className="console-layout__rail">
              {decisions.data === undefined && decisions.error ? (
                <ErrorState size="sm" title="Couldn't load decisions" error={decisions.error} onRetry={decisions.reload} />
              ) : (
                <DecisionRail decisions={open} sessions={sessionsById} onResolved={decisions.reload} />
              )}
            </div>
            <div className="console-layout__ended">
              <EndedToday sessions={endedVisible} filtered={hasFilters(filters)} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface ActivitySectionProps {
  sessions: readonly SessionSummary[];
  total: number;
  counts: readonly { state: LiveState; count: number }[];
  filters: ConsoleFilters;
  onLiveness: (state: LiveState | '') => void;
  onClear: () => void;
  apmMax: number;
  rollover: (processType: string | null) => number;
  activity: ReadonlyMap<string, number>;
  now: number;
}

function ActivitySection({
  sessions,
  total,
  counts,
  filters,
  onLiveness,
  onClear,
  apmMax,
  rollover,
  activity,
  now,
}: ActivitySectionProps) {
  const headingId = useId();
  return (
    <section className="console-activity" aria-labelledby={headingId}>
      <div className="console-activity__head">
        <h2 id={headingId} className="console-panel__title">
          Agent activity
        </h2>
        <p className="console-activity__note">
          Actions per minute (APM), last 30 min · same 0–{formatInteger(apmMax)} scale on every tile · a line turns
          amber after {FLAT_AFTER_MINUTES} quiet minutes, before the 10-minute stall badge
        </p>
      </div>
      <FleetCounts counts={counts} active={filters.liveness} onSelect={onLiveness} />
      {sessions.length === 0 ? (
        total === 0 ? (
          <EmptyState
            icon="console"
            title="No sessions running"
            body={
              <>
                Launch one with <code>aoc run --type &lt;process-type&gt;</code>. Managed and observed sessions appear
                here as soon as their first event lands.
              </>
            }
          />
        ) : (
          <EmptyState
            icon="filter"
            title="No sessions match these filters"
            body="Every live session is hidden by the current filters."
            action={
              <Button size="sm" onClick={onClear}>
                Clear filters
              </Button>
            }
          />
        )
      ) : (
        <ol className="console-tiles" aria-label="Live sessions, highest liveness precedence first">
          {sessions.map((s) => (
            <SessionTile
              key={s.sessionId}
              session={s}
              apmMax={apmMax}
              rolloverPct={rollover(s.processType)}
              activitySeq={activity.get(s.sessionId)}
              now={now}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

interface ConsoleKpisProps {
  snapshot: ConsoleSnapshot;
  active: readonly SessionSummary[];
  dead: number;
  openDecisions: readonly { createdAt: string; viewer: { canResolve: boolean } }[];
  fx: FxStatusDTO | undefined;
  now: number;
}

function ConsoleKpis({ snapshot, active, dead, openDecisions, fx, now }: ConsoleKpisProps) {
  const k = snapshot.kpis;
  const managed = active.filter((s) => s.mode === 'managed').length;
  const oldest = openDecisions[0]?.createdAt;
  const mine = openDecisions.filter((d) => d.viewer.canResolve).length;
  const verified = k.tasksDoneWithEvidencePct / 100;
  const unverified = k.tasksDoneToday - Math.round(k.tasksDoneToday * verified);
  return (
    <KpiStrip label="Today at a glance" className="console-kpis">
      <KpiTile
        label="Active sessions"
        value={k.activeSessions}
        unit={`in ${projectCount(active)} ${projectCount(active) === 1 ? 'project' : 'projects'}`}
        footnote={`${managed} managed · ${active.length - managed} observed${dead > 0 ? ` · ${dead} dead awaiting restart` : ''}`}
      />
      <KpiTile
        label="Waiting on you"
        value={openDecisions.length}
        unit={openDecisions.length === 1 ? 'decision' : 'decisions'}
        tone={openDecisions.length > 0 ? 'warn' : 'neutral'}
        href="/decisions"
        footnote={
          openDecisions.length === 0
            ? `${k.waitingOnYou} sessions paused`
            : `oldest ${oldest ? formatAge(now - Date.parse(oldest)) : '—'} · ${k.waitingOnYou} ${k.waitingOnYou === 1 ? 'session' : 'sessions'} paused · ${mine === 0 ? 'none yours to resolve' : `${mine} yours to resolve`}`
        }
      />
      <KpiTile
        label="Throttled"
        value={k.throttled}
        unit={k.throttled === 1 ? 'session' : 'sessions'}
        href="/metering"
        footnote={`${formatAge(k.throttleIdleMsToday)} idle today from plan limits`}
      />
      <KpiTile
        label="Tasks done today"
        value={k.tasksDoneToday}
        unit={k.tasksDoneToday > 0 ? `${formatPercent(verified)} with verified evidence` : undefined}
        footnote={
          <span className="console-kpi-meter">
            <span
              className="console-meter"
              role="img"
              aria-label={`${formatPercent(verified)} of today's tasks closed with verified evidence`}
            >
              <span className="console-meter__fill" style={{ width: `${verified * 100}%` }} />
            </span>
            <span>{unverified > 0 ? `${unverified} without verified evidence` : 'all evidenced'}</span>
          </span>
        }
      />
      <KpiTile
        label="Notional spend today"
        value={formatUsd(k.notionalUsdToday)}
        unit={k.notionalRmToday === null ? 'RM not available' : formatMyr(k.notionalRmToday)}
        href="/metering"
        info="Notional API-equivalent cost of today's token use at rate-card list prices. On a Max plan there is no per-token bill: this supports decisions, it is not a bill."
        footnote={`notional API-equivalent, not a bill${fx?.current ? ` · FX ${formatNumber(fx.current.rate, 4)} BNM, ${fx.current.status === 'live' ? 'live' : `carried from ${fx.current.sourceDate}`}` : ''}`}
      />
    </KpiStrip>
  );
}

/** Holds the page's shape while the first snapshot loads (no animation). */
function ConsoleSkeleton() {
  return (
    <div className="console-skeleton" role="status" aria-label="Loading the console">
      <div className="console-skeleton__kpis">
        {Array.from({ length: 5 }, (_, i) => (
          <span key={i} className="console-skeleton__block console-skeleton__block--kpi" />
        ))}
      </div>
      <div className="console-skeleton__tiles">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="console-skeleton__block console-skeleton__block--tile" />
        ))}
      </div>
    </div>
  );
}
