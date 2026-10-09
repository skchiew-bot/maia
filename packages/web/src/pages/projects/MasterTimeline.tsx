import { useMemo, useState } from 'react';
import type {
  ManifestPhaseDTO,
  PhasePinDTO,
  ProgressDTO,
  RollbackDTO,
  SessionSummary,
  ProjectHistory,
} from '@aoc/contracts';
import { HitLayer, MarkShape, useElementWidth, type HitItem } from '../../charts';
import { Button, Icon, SegmentedControl, RelativeTime } from '../../components';
import { cx } from '../../lib/dom';
import { formatAge, formatInteger, formatPercent, formatShortDate } from '../../lib/format';
import { FlagGlyph } from './glyphs';
import { ActivityLane, EventsLane, TimeAxis, type LaneEvent, type TimeScale } from './lanes';
import {
  DRIFT_KIND_LABEL,
  SIZE_LEGEND,
  contributorsOf,
  isFlagged,
  isLiveTask,
  phaseStatsFromManifest,
  totalsOf,
  weightText,
  type Contributor,
  type People,
  type PhaseStat,
} from './model';
import { PinRef, StatusText } from './parts';
import { PhaseBar } from './PhaseBar';
import { TaskTable, matchesTaskFilter, type TaskFilter } from './TaskTable';

const GAP = 2;

/** One phase's completion stacked by developer, in order of first declaration (attribution, never a ranking). */
function ContributorBar({ contributors, label }: { contributors: readonly Contributor[]; label: string }) {
  const [ref, width] = useElementWidth<HTMLDivElement>(220);
  const height = 10;
  const total = contributors.reduce((a, c) => a + c.totalWeight, 0);
  const usable = Math.max(1, width - GAP * Math.max(0, contributors.length - 1));
  let x = 0;
  const segs = contributors.map((c) => {
    const w = total > 0 ? (c.totalWeight / total) * usable : 0;
    const done = c.totalWeight > 0 ? (c.doneWeight / c.totalWeight) * w : 0;
    const flagged = c.totalWeight > 0 ? Math.min(done, (c.flaggedWeight / c.totalWeight) * w) : 0;
    const seg = { c, x, w, verified: done - flagged, flagged };
    x += w + GAP;
    return seg;
  });
  const sentence = (c: Contributor) =>
    `${c.name}: ${weightText(c.doneWeight)} of ${weightText(c.totalWeight)} weight done, ${formatInteger(
      c.doneTasks,
    )} of ${formatInteger(c.totalTasks)} tasks${c.flaggedWeight > 0 ? ', some flagged' : ''}`;
  const hits: HitItem[] = segs.map((s) => ({
    key: s.c.id,
    x: s.x,
    y: 0,
    width: Math.max(1, s.w),
    height,
    label: sentence(s.c),
    tooltip: (
      <>
        <span className="aoc-chart-tip__kind">Declared by</span>
        <strong>{s.c.name}</strong>
        <span className="aoc-chart-tip__meta aoc-num">
          {weightText(s.c.doneWeight)}/{weightText(s.c.totalWeight)} weight · {formatInteger(s.c.doneTasks)}/
          {formatInteger(s.c.totalTasks)} tasks
        </span>
      </>
    ),
  }));
  return (
    <div className="aoc-chart prj-contrib">
      <div className="aoc-chart__plot" ref={ref}>
        <svg
          role="img"
          aria-label={`${label}, by developer: ${contributors.map(sentence).join('; ') || 'no tasks'}.`}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
        >
          {segs.map((s) => (
            <g key={s.c.id}>
              <rect x={s.x} y={0} width={Math.max(0, s.w)} height={height} rx={2} className="prj-phasebar__track" />
              {s.verified > 0 && (
                <rect x={s.x} y={0} width={s.verified} height={height} rx={2} className="prj-phasebar__done" />
              )}
              {s.flagged > 0 && (
                <rect
                  x={s.x + s.verified}
                  y={0}
                  width={s.flagged}
                  height={height}
                  rx={s.verified > 0 ? 0 : 2}
                  className="prj-phasebar__flagged"
                />
              )}
            </g>
          ))}
        </svg>
        <HitLayer items={hits} label={`${label}: developers`} width={width} height={height} />
      </div>
    </div>
  );
}

function phaseStatus(p: PhaseStat): { state: 'done' | 'active' | 'pending'; text: string } {
  if (p.state === 'done') return { state: 'done', text: p.completedAt ? `Done ${formatShortDate(p.completedAt)}` : 'Done' };
  if (p.state === 'active') return { state: 'active', text: 'In progress' };
  return { state: 'pending', text: 'Not started' };
}

function countOf(events: readonly LaneEvent[], kind: LaneEvent['kind'], one: string, many: string): string {
  const n = events.filter((e) => e.kind === kind).length;
  return `${formatInteger(n)} ${n === 1 ? one : many}`;
}

function etaText(progress: ProgressDTO): string | null {
  if (progress.etaMs !== null) return `ETA ≈ ${formatAge(progress.etaMs)} at the current pace`;
  if (progress.etaHiddenReason === 'fewer_than_3_done') return 'ETA shows once 3 tasks are done';
  return null;
}

export interface MasterTimelineProps {
  manifest: readonly ManifestPhaseDTO[];
  progress: ProgressDTO;
  history: ProjectHistory | undefined;
  rollbacks: readonly RollbackDTO[] | undefined;
  sessions: readonly SessionSummary[];
  people: People;
  scale: TimeScale;
  filter: TaskFilter;
  onFilterChange: (f: TaskFilter) => void;
}

/**
 * The project hero (§9): the overall bar (segments = phases, sized by declared weight), then one row per phase
 * in manifest order with its developer-stacked bar, its activity on the shared calendar, and its pinned
 * rollback point; each row opens to its tasks. A last lane lines up scope changes, drift and rollbacks.
 */
export function MasterTimeline({
  manifest,
  progress,
  history,
  rollbacks,
  sessions,
  people,
  scale,
  filter,
  onFilterChange,
}: MasterTimelineProps) {
  const stats = useMemo(() => phaseStatsFromManifest(manifest), [manifest]);
  const totals = totalsOf(stats);
  const current = stats.find((p) => p.state !== 'done' && p.totalWeight > 0) ?? null;
  const sessionsById = useMemo(() => new Map(sessions.map((s) => [s.sessionId, s])), [sessions]);
  const ordered = useMemo(() => [...manifest].sort((a, b) => a.order - b.order), [manifest]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(current ? [current.id] : []));

  const matching = (p: ManifestPhaseDTO) => p.tasks.filter((t) => matchesTaskFilter(t, filter));
  const isOpen = (id: string, p: ManifestPhaseDTO) =>
    expanded.has(id) || (filter !== 'all' && matching(p).length > 0);
  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allOpen = ordered.every((p) => isOpen(p.phaseId, p));

  const flaggedCount = manifest.flatMap((p) => p.tasks).filter(isFlagged).length;
  const openCount = manifest.flatMap((p) => p.tasks).filter((t) => t.status === 'open').length;

  const pinsByPhase = useMemo(() => {
    const m = new Map<string, PhasePinDTO[]>();
    for (const pin of history?.pins ?? []) m.set(pin.phaseId, [...(m.get(pin.phaseId) ?? []), pin]);
    return m;
  }, [history]);

  const events = useMemo<LaneEvent[]>(() => {
    const out: LaneEvent[] = [];
    for (const s of history?.scope ?? []) {
      if (s.kind !== 'amended') continue;
      out.push({
        id: `a${s.seq}`,
        kind: 'amendment',
        at: Date.parse(s.at),
        title: `Amendment v${s.manifestVersion}: +${s.added} −${s.removed} ~${s.resized}`,
        detail: `${s.ownerName ?? 'unknown'} · ${s.weightDelta >= 0 ? '+' : '−'}${weightText(Math.abs(s.weightDelta))} weight`,
      });
    }
    for (const e of history?.enhancements ?? [])
      out.push({ id: e.eventId, kind: 'enhancement', at: Date.parse(e.at), title: e.title, detail: people.resolve(e.by).name });
    for (const d of history?.drift ?? [])
      out.push({
        id: `d${d.seq}`,
        kind: 'drift',
        at: Date.parse(d.at),
        title: DRIFT_KIND_LABEL[d.kind] ?? d.kind,
        detail: `${d.severity} severity`,
      });
    for (const r of rollbacks ?? [])
      out.push({ id: r.rollbackId, kind: 'rollback', at: Date.parse(r.requestedAt), title: `To ${r.targetRef}`, detail: r.status });
    return out;
  }, [history, rollbacks, people]);

  const eta = etaText(progress);
  const ratio = totals.totalWeight > 0 ? totals.doneWeight / totals.totalWeight : 0;

  return (
    <div className="prj-mt">
      <div className="prj-mt__summary">
        <p className="prj-mt__headline">
          <strong className="aoc-num">{formatPercent(ratio)}</strong>
          <span>done by declared weight</span>
        </p>
        <p className="prj-mt__figures">
          <span className="aoc-num">
            {weightText(totals.doneWeight)} of {weightText(totals.totalWeight)} weight
          </span>
          <span className="aoc-num">
            {formatInteger(totals.doneTasks)} of {formatInteger(totals.totalTasks)} tasks
          </span>
          {totals.flaggedTasks > 0 && (
            <span className="prj-mt__flagged aoc-num">
              <FlagGlyph size={12} /> {formatInteger(totals.flaggedTasks)} flagged · count until reviewed
            </span>
          )}
          {eta && <span>{eta}</span>}
        </p>
      </div>

      <PhaseBar
        phases={stats}
        label="Master timeline completion by phase"
        height={16}
        showLabels
        currentId={current?.id}
        onSelect={(id) => setExpanded((s) => new Set([...s, id]))}
      />

      <p className="prj-legend prj-legend--inline">
        <span className="prj-legend__item">
          <span className="prj-legend__swatch prj-legend__swatch--done" /> done with evidence
        </span>
        <span className="prj-legend__item">
          <span className="prj-legend__swatch prj-legend__swatch--flagged" /> flagged: closed with no file change
        </span>
        <span className="prj-legend__item">
          <span className="prj-legend__swatch prj-legend__swatch--open" /> declared, not done
        </span>
        <span className="prj-legend__item">
          <svg width={10} height={14} aria-hidden="true" className="prj-legend__glyph">
            <rect x={4} y={1} width={1.5} height={12} className="prj-lane__close" />
          </svg>
          task closed
        </span>
        <span className="prj-legend__item">
          <svg width={12} height={14} aria-hidden="true" className="prj-legend__glyph">
            <path d="M2,13V2h6l-1.5,2.25l1.5,2.25h-6" className="prj-lane__pin" />
          </svg>
          phase tag pinned
        </span>
        <span className="prj-legend__item">
          <svg width={14} height={14} aria-hidden="true" className="prj-legend__glyph">
            <MarkShape kind="enhancement" x={7} y={7} r={4.5} />
          </svg>
          amendment or enhancement
        </span>
        <span className="prj-legend__item">
          <svg width={14} height={14} aria-hidden="true" className="prj-legend__glyph">
            <MarkShape kind="drift" x={7} y={7} r={4.5} />
          </svg>
          drift
        </span>
        <span className="prj-legend__item">
          <svg width={14} height={14} aria-hidden="true" className="prj-legend__glyph">
            <MarkShape kind="rollback" x={7} y={7} r={4.5} />
          </svg>
          rollback
        </span>
        <span className="prj-legend__item prj-legend__note">weights {SIZE_LEGEND}</span>
      </p>

      <div className="prj-mt__toolbar">
        <SegmentedControl
          label="Tasks to show"
          size="sm"
          value={filter}
          onChange={onFilterChange}
          options={[
            { value: 'all', label: 'All tasks' },
            { value: 'open', label: `Open (${formatInteger(openCount)})` },
            { value: 'flagged', label: `Flagged (${formatInteger(flaggedCount)})` },
          ]}
        />
        <Button
          size="sm"
          variant="ghost"
          icon={allOpen ? 'chevron-up' : 'chevron-down'}
          onClick={() => setExpanded(allOpen ? new Set() : new Set(ordered.map((p) => p.phaseId)))}
        >
          {allOpen ? 'Collapse all' : 'Expand all'}
        </Button>
      </div>

      <div className="prj-mt__table">
        <div className="prj-mt__head" aria-hidden="true">
          <span>Phase</span>
          <span>Completion by developer</span>
          <TimeAxis scale={scale} />
          <span>Pinned rollback point</span>
        </div>
        {ordered.map((phase, i) => {
          const stat = stats[i]!;
          const open = isOpen(phase.phaseId, phase);
          const tasks = phase.tasks.filter((t) => matchesTaskFilter(t, filter));
          const contributors = contributorsOf(phase, people);
          const live = phase.tasks.filter(isLiveTask);
          const closes = live
            .filter((t) => t.status === 'done' && t.doneAt)
            .map((t) => ({ at: Date.parse(t.doneAt!), flagged: t.flag !== null }));
          const starts = live
            .map((t) => sessionsById.get(t.sessionId)?.startedAt)
            .filter((s): s is string => Boolean(s))
            .map((s) => Date.parse(s));
          const pins = pinsByPhase.get(phase.phaseId) ?? [];
          const lastClose = closes.length ? Math.max(...closes.map((c) => c.at)) : null;
          const status = phaseStatus(stat);
          const tableId = `prj-mt-tasks-${phase.phaseId}`;
          const label = `P${stat.index} ${stat.name}`;
          return (
            <section
              key={phase.phaseId}
              className={cx('prj-mt__phase', stat.id === current?.id && 'is-current', open && 'is-open')}
              aria-label={label}
            >
              <div className="prj-mt__row">
                <div className="prj-mt__name">
                  <button
                    type="button"
                    className="prj-mt__toggle"
                    aria-expanded={open}
                    aria-controls={tableId}
                    onClick={() => toggle(phase.phaseId)}
                  >
                    <Icon name="chevron-right" size={14} className="prj-mt__chev" />
                    <span className="prj-mt__idx aoc-num">P{stat.index}</span>
                    <span className="prj-mt__pname">{stat.name}</span>
                  </button>
                  <StatusText state={status.state}>{status.text}</StatusText>
                </div>
                <div className="prj-mt__completion">
                  <ContributorBar contributors={contributors} label={label} />
                  <p className="prj-mt__nums aoc-num">
                    <b>{weightText(stat.doneWeight)}/{weightText(stat.totalWeight)}</b> weight ·{' '}
                    {formatInteger(stat.doneTasks)}/{formatInteger(stat.totalTasks)} tasks ·{' '}
                    {formatPercent(stat.totalWeight > 0 ? stat.doneWeight / stat.totalWeight : 0)}
                    {stat.flaggedTasks > 0 && (
                      <span className="prj-mt__flagged">
                        {' '}
                        · <FlagGlyph size={11} /> {formatInteger(stat.flaggedTasks)}
                      </span>
                    )}
                  </p>
                  <p className="prj-mt__contribs">
                    {contributors.length} {contributors.length === 1 ? 'developer' : 'developers'}:{' '}
                    {contributors.map((c) => c.name).join(', ') || '—'}
                  </p>
                </div>
                <div className="prj-mt__activity">
                  <ActivityLane
                    scale={scale}
                    label={`${label} activity`}
                    spanStart={starts.length ? Math.min(...starts) : closes.length ? Math.min(...closes.map((c) => c.at)) : null}
                    spanEnd={stat.state === 'done' && stat.completedAt ? Date.parse(stat.completedAt) : null}
                    closes={closes}
                    pins={pins.map((p) => ({ at: Date.parse(p.at), label: p.tag ?? p.sha ?? '' }))}
                    open={stat.state !== 'done'}
                  />
                  <p className="prj-mt__lane-note">
                    {lastClose !== null ? (
                      <>
                        last close <RelativeTime value={lastClose} suffix=" ago" />
                      </>
                    ) : (
                      'no task closed yet'
                    )}
                  </p>
                </div>
                <div className="prj-mt__pin">
                  <PinRef tag={phase.pinnedTag} sha={phase.pinnedSha} />
                  {pins.length > 0 && (
                    <p className="prj-mt__pin-note">
                      {pins.length === 1 ? 'pinned' : `latest of ${pins.length} pins,`}{' '}
                      {formatShortDate(pins[pins.length - 1]!.at)}
                    </p>
                  )}
                </div>
              </div>
              <div id={tableId} hidden={!open} className="prj-mt__tasks">
                {open &&
                  (tasks.length > 0 ? (
                    <TaskTable caption={`${label} tasks`} tasks={tasks} people={people} sessions={sessionsById} />
                  ) : (
                    <p className="prj-mt__none">
                      {filter === 'flagged'
                        ? 'No flagged closes in this phase.'
                        : filter === 'open'
                          ? 'No open tasks in this phase.'
                          : 'No tasks declared in this phase.'}
                    </p>
                  ))}
              </div>
            </section>
          );
        })}
        <section className="prj-mt__phase prj-mt__phase--events" aria-label="Scope changes, drift and rollbacks">
          <div className="prj-mt__row">
            <div className="prj-mt__name">
              <span className="prj-mt__events-title">Scope, drift, rollbacks</span>
            </div>
            <div className="prj-mt__completion prj-mt__events-counts">
              <span className="aoc-num">
                {countOf(events, 'amendment', 'amendment', 'amendments')} ·{' '}
                {countOf(events, 'enhancement', 'enhancement', 'enhancements')}
              </span>
              <span className="aoc-num">
                {countOf(events, 'drift', 'drift mark', 'drift marks')} · {countOf(events, 'rollback', 'rollback', 'rollbacks')}
              </span>
            </div>
            <div className="prj-mt__activity">
              <EventsLane scale={scale} events={events} label="Scope changes, drift and rollbacks" />
            </div>
            <div className="prj-mt__pin prj-mt__events-links">
              <a href="#scope">Scope changes</a>
              <a href="#drift">Drift</a>
              <a href="#changes">Change control</a>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
