import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type {
  ChangeRequestDTO,
  DecisionCardView,
  ManifestPhaseDTO,
  PhasePinDTO,
  PlaybookDTO,
  ProcessTypeView,
  ProjectDriftDTO,
  ProjectHistory,
  RollbackDTO,
  SessionSummary,
  ThreadSummary,
} from '@aoc/contracts';
import {
  Badge,
  Button,
  Chip,
  CopyableHash,
  DataTable,
  EmptyState,
  Icon,
  LivenessBadge,
  Money,
  ProgressBar,
  RelativeTime,
  SegmentedControl,
  type DataTableColumn,
  type Tone,
} from '../../components';
import { cx } from '../../lib/dom';
import { formatClock, formatDateTime, formatInteger, formatShortDate } from '../../lib/format';
import { BurnUp, scopeDescription } from './BurnUp';
import { useThread } from './data';
import { DriftGlyph, ScopeGlyph } from './glyphs';
import type { TimeScale } from './lanes';
import {
  DRIFT_KIND_HINT,
  DRIFT_KIND_LABEL,
  isLiveSession,
  sessionBadgeState,
  sessionRank,
  shortId,
  weightText,
  type People,
} from './model';
import { PinRef } from './parts';

function ShowMore({ total, shown, onToggle, expanded }: { total: number; shown: number; onToggle: () => void; expanded: boolean }) {
  if (total <= shown && !expanded) return null;
  return (
    <div className="prj-more">
      <Button size="sm" variant="ghost" iconAfter={expanded ? 'chevron-up' : 'chevron-down'} onClick={onToggle}>
        {expanded ? 'Show fewer' : `Show all ${formatInteger(total)}`}
      </Button>
    </div>
  );
}

// ── Scope changes ───────────────────────────────────────────────────────────

export function ScopePanel({
  history,
  manifest,
  scale,
  people,
}: {
  history: ProjectHistory;
  manifest: readonly ManifestPhaseDTO[];
  scale: TimeScale;
  people: People;
}) {
  const [all, setAll] = useState(false);
  const rows = [...history.scope].reverse();
  const visible = all ? rows : rows.slice(0, 8);
  const amendments = history.scope.filter((s) => s.kind === 'amended');
  return (
    <>
      <BurnUp scope={history.scope} manifest={manifest} scale={scale} />
      {history.scope.length === 0 ? (
        <EmptyState
          size="sm"
          icon="projects"
          title="No plan declared yet"
          body="The denominator starts when the first session declares its plan into this project."
        />
      ) : (
        <>
          <p className="prj-scope__lede">
            {amendments.length === 0
              ? 'No amendments: every task entered the denominator through a declared plan.'
              : `${formatInteger(amendments.length)} audited ${amendments.length === 1 ? 'amendment' : 'amendments'} changed the denominator after declaration.`}
          </p>
          <div className="prj-scroll">
            <table className="prj-log">
              <caption className="aoc-sr-only">Changes to the project denominator, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Change</th>
                  <th scope="col">By</th>
                  <th scope="col" className="is-end">
                    Denominator
                  </th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => (
                  <tr key={s.seq} className={cx(s.kind === 'amended' && 'is-amendment')}>
                    <td data-label="When">
                      <time dateTime={s.at} title={formatDateTime(s.at)} className="aoc-num">
                        {formatShortDate(s.at)} {formatClock(s.at)}
                      </time>
                      <span className="prj-log__seq aoc-num">ledger #{formatInteger(s.seq)}</span>
                    </td>
                    <td data-label="Change">
                      <span className="prj-log__kind">
                        {s.kind === 'amended' ? (
                          <>
                            <ScopeGlyph size={12} className="prj-log__amend-icon" /> Amendment v{s.manifestVersion}
                          </>
                        ) : (
                          'Plan declared'
                        )}
                      </span>
                      <span className="prj-log__tasks aoc-num">
                        {s.kind === 'declared'
                          ? `${formatInteger(s.added)} ${s.added === 1 ? 'task' : 'tasks'}${s.carriedOver ? `, ${formatInteger(s.carriedOver)} carried over` : ''}`
                          : `+${s.added} added · −${s.removed} removed · ~${s.resized} resized`}
                      </span>
                      <Link to={`/sessions/${encodeURIComponent(s.sessionId)}`} className="prj-log__session">
                        {shortId(s.sessionId)}
                      </Link>
                    </td>
                    <td data-label="By">{s.ownerName ?? people.resolve(s.ownerId ?? s.sessionId, s.sessionId).name}</td>
                    <td data-label="Denominator" className="is-end aoc-num">
                      <span className="prj-log__denominator">
                        {weightText(s.projectWeightBefore)} → <b>{weightText(s.projectWeightAfter)}</b>
                      </span>
                      <span className={cx('prj-delta', s.weightDelta > 0 ? 'is-up' : s.weightDelta < 0 ? 'is-down' : 'is-flat')}>
                        {s.weightDelta > 0 ? '+' : s.weightDelta < 0 ? '−' : '±'}
                        {weightText(Math.abs(s.weightDelta))}
                      </span>
                    </td>
                    <td data-label="Reason" className="prj-log__reason">
                      {s.reason ?? <span className="prj-muted">new session plan</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ShowMore total={rows.length} shown={8} expanded={all} onToggle={() => setAll((a) => !a)} />
        </>
      )}
      {history.enhancements.length > 0 && (
        <div className="prj-enh">
          <h3 className="prj-subhead">Enhancements recorded</h3>
          <ul className="prj-enh__list">
            {[...history.enhancements].reverse().map((e) => (
              <li key={e.eventId}>
                <ScopeGlyph size={12} className="prj-log__amend-icon" />
                <div>
                  <p className="prj-enh__title">{e.title}</p>
                  <p className="prj-enh__meta">
                    {people.resolve(e.by).name} · <RelativeTime value={e.at} suffix=" ago" />
                    {e.sessionId && (
                      <>
                        {' '}
                        · <Link to={`/sessions/${encodeURIComponent(e.sessionId)}`}>{shortId(e.sessionId)}</Link>
                      </>
                    )}
                  </p>
                  {e.detail && <p className="prj-enh__detail">{e.detail}</p>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

// ── Drift ───────────────────────────────────────────────────────────────────

const SEVERITY_TONE: Record<ProjectDriftDTO['severity'], Tone> = { high: 'danger', medium: 'warn', low: 'neutral' };

export function DriftPanel({ drift, sessions, now }: { drift: readonly ProjectDriftDTO[]; sessions: ReadonlyMap<string, SessionSummary>; now: number }) {
  const [all, setAll] = useState(false);
  const recent = drift.filter((d) => now - Date.parse(d.at) <= 7 * 86_400_000);
  const byKind = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of drift) m.set(d.kind, (m.get(d.kind) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [drift]);
  if (drift.length === 0)
    return (
      <EmptyState
        size="sm"
        icon="ok"
        title="No drift recorded"
        body="Drift marks appear when files change with no declared task open, a playbook step is skipped, amendments grow the plan past its threshold, or a task overruns its size budget."
      />
    );
  const rows = [...drift].reverse();
  const visible = all ? rows : rows.slice(0, 6);
  return (
    <>
      <p className="prj-drift__summary">
        <span>
          <b className="aoc-num">{formatInteger(recent.length)}</b> in the last 7 days ·{' '}
          <span className="aoc-num">{formatInteger(drift.length)}</span> in total
        </span>
        {byKind.map(([kind, n]) => (
          <Chip key={kind}>
            <span title={DRIFT_KIND_HINT[kind]}>
              {DRIFT_KIND_LABEL[kind] ?? kind} <span className="aoc-num">{formatInteger(n)}</span>
            </span>
          </Chip>
        ))}
      </p>
      <ul className="prj-drift">
        {visible.map((d) => {
          const s = sessions.get(d.sessionId);
          return (
            <li key={d.seq} className="prj-drift__item">
              <DriftGlyph size={14} className="prj-drift__icon" />
              <div className="prj-drift__body">
                <p className="prj-drift__head">
                  <b>{DRIFT_KIND_LABEL[d.kind] ?? d.kind}</b>
                  <Badge tone={SEVERITY_TONE[d.severity]} variant="outline">
                    {d.severity}
                  </Badge>
                  <RelativeTime value={d.at} suffix=" ago" />
                </p>
                <p className="prj-drift__detail">{d.detail}</p>
                <p className="prj-drift__meta">
                  <Link to={`/sessions/${encodeURIComponent(d.sessionId)}`} title={s?.title}>
                    {s ? `${s.ownerName ?? 'session'} · ${shortId(d.sessionId)}` : shortId(d.sessionId)}
                  </Link>
                  {d.taskId && <span> · task {d.taskId}</span>}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      <ShowMore total={rows.length} shown={6} expanded={all} onToggle={() => setAll((a) => !a)} />
    </>
  );
}

// ── Sessions ────────────────────────────────────────────────────────────────

function livenessDetail(s: SessionSummary): ReactNode {
  const st = sessionBadgeState(s);
  if (st === 'throttled' && s.throttledUntil)
    return <>resets {formatClock(s.throttledUntil)}</>;
  if (st === 'waiting_on_you' && s.openDecision) return <RelativeTime value={s.openDecision.createdAt} />;
  return undefined;
}

export function SessionsPanel({
  sessions,
  now,
  typeNames,
}: {
  sessions: readonly SessionSummary[];
  now: number;
  typeNames: ReadonlyMap<string, string>;
}) {
  const live = sessions.filter((s) => isLiveSession(s, now));
  const [show, setShow] = useState<'live' | 'all'>(live.length > 0 ? 'live' : 'all');
  const rows = show === 'live' ? live : sessions;
  const columns = useMemo<DataTableColumn<SessionSummary>[]>(
    () => [
      {
        id: 'session',
        header: 'Session',
        primary: true,
        sortValue: (s) => s.title,
        cell: (s) => (
          <span className="prj-session">
            <span className="prj-session__title">{s.title}</span>
            <span className="prj-session__id">{shortId(s.sessionId)}</span>
          </span>
        ),
      },
      {
        id: 'liveness',
        header: 'Liveness',
        sortValue: (s) => sessionRank(s),
        sortLabels: ['most urgent first', 'least urgent first'],
        cell: (s) => <LivenessBadge state={sessionBadgeState(s)} size="sm" detail={livenessDetail(s)} />,
      },
      { id: 'owner', header: 'Developer', sortValue: (s) => s.ownerName ?? '', cell: (s) => s.ownerName ?? '—' },
      {
        id: 'type',
        header: 'Process type',
        sortValue: (s) => s.processType ?? '',
        hideOnMobile: true,
        cell: (s) => (
          <span className="prj-session__type">
            {s.processType ? (typeNames.get(s.processType) ?? s.processType) : '—'}
            {s.model && <span className="prj-session__model">{modelWord(s.model)}</span>}
          </span>
        ),
      },
      {
        id: 'progress',
        header: 'Progress',
        width: '140px',
        sortValue: (s) => (s.progress && s.progress.totalWeight > 0 ? s.progress.doneWeight / s.progress.totalWeight : -1),
        sortLabels: ['least done first', 'most done first'],
        cell: (s) =>
          s.progress ? (
            <ProgressBar done={s.progress.doneTasks} declared={s.progress.totalTasks} size="sm" showPercent={false} />
          ) : (
            <span className="prj-muted">no plan</span>
          ),
      },
      {
        id: 'cost',
        header: 'Cost today',
        numeric: true,
        sortValue: (s) => s.costTodayUsd,
        cell: (s) => <Money usd={s.costTodayUsd} usdOnly />,
      },
      {
        id: 'activity',
        header: 'Last activity',
        numeric: true,
        sortValue: (s) => (s.lastActivityAt ? Date.parse(s.lastActivityAt) : 0),
        cell: (s) => (s.lastActivityAt ? <RelativeTime value={s.lastActivityAt} suffix=" ago" /> : '—'),
      },
    ],
    [typeNames],
  );
  return (
    <>
      <div className="prj-panel-tools">
        <SegmentedControl
          label="Sessions to show"
          size="sm"
          value={show}
          onChange={setShow}
          options={[
            { value: 'live', label: `Live (${formatInteger(live.length)})` },
            { value: 'all', label: `All (${formatInteger(sessions.length)})` },
          ]}
        />
      </div>
      <DataTable
        caption="Sessions of this project"
        columns={columns}
        rows={rows}
        rowKey={(s) => s.sessionId}
        rowHref={(s) => `/sessions/${encodeURIComponent(s.sessionId)}`}
        defaultSort={{ columnId: 'liveness', direction: 'asc' }}
        rowTone={(s) => {
          const st = sessionBadgeState(s);
          return st === 'dead' ? 'danger' : st === 'stalled' || st === 'waiting_on_you' ? 'warn' : undefined;
        }}
        maxHeight={420}
        empty={
          <EmptyState
            size="sm"
            icon="console"
            title={show === 'live' ? 'No live sessions' : 'No sessions yet'}
            body={
              show === 'live'
                ? 'Nothing is running for this project right now. Ended sessions are under All.'
                : 'Sessions appear when a managed session launches against this project.'
            }
          />
        }
      />
    </>
  );
}

function modelWord(model: string): string {
  const m = model.toLowerCase();
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  if (m.includes('haiku')) return 'Haiku';
  return model;
}

// ── Threads & rollover lineage ──────────────────────────────────────────────

const RELEASE_WORD: Record<string, string> = {
  rollover: 'rolled over',
  ended: 'ended',
  failed: 'failed',
  stopped: 'stopped',
};

function ThreadCard({
  thread,
  projectId,
  sessions,
}: {
  thread: ThreadSummary;
  projectId: string;
  sessions: ReadonlyMap<string, SessionSummary>;
}) {
  const detail = useThread(thread.threadId, projectId);
  const d = detail.data;
  const writer = thread.activeWriterSessionId ? sessions.get(thread.activeWriterSessionId) : undefined;
  const rollovers = d?.writers.filter((w) => w.reason === 'rollover').length ?? 0;
  const chain = d ? (d.writers.length ? d.writers.map((w) => w.sessionId) : d.sessionIds) : [];
  const releaseOf = new Map((d?.writers ?? []).map((w) => [w.sessionId, w]));
  return (
    <li className="prj-thread">
      <div className="prj-thread__head">
        <h3 className="prj-thread__title">{thread.title}</h3>
        <span className="prj-muted">
          since {formatShortDate(thread.createdAt)} · {formatInteger(rollovers)} {rollovers === 1 ? 'rollover' : 'rollovers'}
        </span>
      </div>
      <p className="prj-thread__writer">
        {writer ? (
          <>
            Active writer{' '}
            <Link to={`/sessions/${encodeURIComponent(writer.sessionId)}`}>{writer.title}</Link>{' '}
            <LivenessBadge state={sessionBadgeState(writer)} size="sm" />
          </>
        ) : (
          <span className="prj-muted">No active writer: the next session to declare work here takes the thread.</span>
        )}
      </p>
      {d && d.progress.totalTasks > 0 && (
        <ProgressBar done={d.progress.doneTasks} declared={d.progress.totalTasks} label="Thread tasks" size="sm" />
      )}
      {detail.error !== undefined && !d && <p className="prj-muted">Thread history unavailable.</p>}
      {chain.length > 0 && (
        <ol className="prj-lineage" aria-label={`${thread.title}: sessions in order`}>
          {chain.map((id, i) => {
            const s = sessions.get(id);
            const w = releaseOf.get(id);
            return (
              <li key={id} className={cx('prj-lineage__item', w?.reason === 'rollover' && 'is-rollover')}>
                {i > 0 && (
                  <span className="prj-lineage__arrow" aria-hidden="true">
                    →
                  </span>
                )}
                <Link to={`/sessions/${encodeURIComponent(id)}`} title={s?.title}>
                  {shortId(id)}
                </Link>
                {s && <span className="prj-lineage__who">{s.ownerName ?? ''}</span>}
                {w?.releasedAt && w.reason && (
                  <span className="prj-lineage__why">
                    {w.reason === 'rollover' && <Icon name="retired" size={12} />}
                    {RELEASE_WORD[w.reason] ?? w.reason} {formatShortDate(w.releasedAt)}
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </li>
  );
}

export function ThreadsPanel({
  threads,
  projectId,
  sessions,
}: {
  threads: readonly ThreadSummary[];
  projectId: string;
  sessions: ReadonlyMap<string, SessionSummary>;
}) {
  if (threads.length === 0)
    return (
      <EmptyState
        size="sm"
        icon="projects"
        title="No threads yet"
        body="A thread is created when the first session launches into this project, or with New thread."
      />
    );
  return (
    <ul className="prj-threads">
      {threads.map((t) => (
        <ThreadCard key={t.threadId} thread={t} projectId={projectId} sessions={sessions} />
      ))}
    </ul>
  );
}

// ── Open decisions ──────────────────────────────────────────────────────────

const KIND_LABEL: Record<string, string> = {
  agent_decision: 'Agent decision',
  protected_operation: 'Protected operation',
  fix_plan: 'Fix-plan sign-off',
  go_live: 'Go-live',
  rollback: 'Rollback',
  change_request: 'Change request',
  break_glass: 'Break-glass promotion',
  playbook_approval: 'Playbook approval',
  lesson_binding: 'Lesson binding',
  credit_topup: 'Credit top-up',
  fx_discrepancy: 'FX discrepancy',
  triage_reconciliation: 'Triage reconciliation',
  low_confidence_diagnosis: 'Low-confidence diagnosis',
  uat_signoff: 'UAT sign-off',
};

export function DecisionsPanel({ decisions }: { decisions: readonly DecisionCardView[] }) {
  if (decisions.length === 0)
    return (
      <EmptyState
        size="sm"
        icon="decisions"
        title="No open decisions"
        body="Human-required decisions raised for this project's sessions and gates appear here with their age."
      />
    );
  return (
    <ul className="prj-decisions">
      {decisions.map((d) => (
        <li key={d.id} className={cx('prj-decision', d.overdue && 'is-overdue')}>
          <span className="prj-decision__icon" aria-hidden="true">
            <Icon name="decisions" size={14} />
          </span>
          <div className="prj-decision__body">
            <p className="prj-decision__title">{d.title}</p>
            <p className="prj-decision__meta">
              <span>{KIND_LABEL[d.kind] ?? d.kind}</span>
              {d.test && <Chip>test {d.test}</Chip>}
              {d.requiresPasskey && (
                <span className="prj-decision__passkey">
                  <Icon name="key" size={12} /> passkey
                </span>
              )}
              <span>for {d.requiredRole === 'approver' ? 'the Approver' : 'a Builder'}</span>
              <span>
                waiting <RelativeTime value={d.createdAt} />
              </span>
              {d.overdue && <Badge tone="danger" icon="clock">past due</Badge>}
            </p>
          </div>
          <Link to="/decisions" className="prj-decision__open">
            {d.viewer.canResolve ? 'Decide' : 'View'}
            <span className="aoc-sr-only">: {d.title}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

// ── Change control ──────────────────────────────────────────────────────────

const CHANGE_TONE: Record<string, Tone> = {
  draft: 'neutral',
  submitted: 'info',
  approved: 'accent',
  rejected: 'danger',
  in_progress: 'info',
  completed: 'ok',
};
const ROLLBACK_TONE: Record<string, Tone> = {
  requested: 'info',
  verifying: 'info',
  awaiting_approval: 'warn',
  not_clean: 'danger',
  approved: 'accent',
  rejected: 'neutral',
  executed: 'ok',
  failed: 'danger',
};
const words = (s: string) => s.replace(/_/g, ' ');

export function ChangeControlPanel({
  changes,
  rollbacks,
  pins,
  projectId,
  errors,
}: {
  changes: readonly ChangeRequestDTO[] | undefined;
  rollbacks: readonly RollbackDTO[] | undefined;
  pins: readonly PhasePinDTO[];
  projectId: string;
  errors: { changes: boolean; rollbacks: boolean };
}) {
  const [allPins, setAllPins] = useState(false);
  const pinRows = [...pins].reverse();
  const shownPins = allPins ? pinRows : pinRows.slice(0, 5);
  const q = `?projectId=${encodeURIComponent(projectId)}`;
  return (
    <div className="prj-cc">
      <section className="prj-cc__block" aria-labelledby="prj-cc-changes">
        <h3 id="prj-cc-changes" className="prj-subhead">
          Change requests <Link to={`/changes${q}`}>All changes</Link>
        </h3>
        {errors.changes ? (
          <p className="prj-muted">Change requests are unavailable.</p>
        ) : !changes ? (
          <p className="prj-muted">Loading…</p>
        ) : changes.length === 0 ? (
          <p className="prj-muted">
            None yet. Every post-MVP change is a change request with impact, mitigation, rollback plan and acceptance test.
          </p>
        ) : (
          <ul className="prj-cc__list">
            {changes.slice(0, 6).map((c) => (
              <li key={c.changeId}>
                <Link to={`/changes/${encodeURIComponent(c.changeId)}`} className="prj-cc__title">
                  {c.title ?? '[erased]'}
                </Link>
                <span className="prj-cc__meta">
                  <Badge tone={CHANGE_TONE[c.status] ?? 'neutral'}>{words(c.status)}</Badge>
                  <Chip>{words(c.scope)}</Chip>
                  <RelativeTime value={c.createdAt} suffix=" ago" />
                  {c.overdue && <Badge tone="danger">overdue</Badge>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="prj-cc__block" aria-labelledby="prj-cc-rollbacks">
        <h3 id="prj-cc-rollbacks" className="prj-subhead">
          Rollbacks <Link to={`/rollbacks${q}`}>All rollbacks</Link>
        </h3>
        {errors.rollbacks ? (
          <p className="prj-muted">Rollbacks are unavailable.</p>
        ) : !rollbacks ? (
          <p className="prj-muted">Loading…</p>
        ) : rollbacks.length === 0 ? (
          <p className="prj-muted">None. A rollback targets a pinned tag below and is verified on a branch before anything touches main.</p>
        ) : (
          <ul className="prj-cc__list">
            {rollbacks.slice(0, 6).map((r) => (
              <li key={r.rollbackId}>
                <span className="prj-cc__title">
                  To <code>{r.targetRef}</code> <CopyableHash value={r.targetSha} length={8} label="rollback target SHA" />
                </span>
                <span className="prj-cc__meta">
                  <Badge tone={ROLLBACK_TONE[r.status] ?? 'neutral'}>{words(r.status)}</Badge>
                  <RelativeTime value={r.requestedAt} suffix=" ago" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="prj-cc__block" aria-labelledby="prj-cc-pins">
        <h3 id="prj-cc-pins" className="prj-subhead">
          Rollback points <span className="prj-muted aoc-num">{formatInteger(pins.length)} pinned</span>
        </h3>
        {pins.length === 0 ? (
          <p className="prj-muted">Each completed phase pins an immutable tag here.</p>
        ) : (
          <>
            <ul className="prj-cc__list">
              {shownPins.map((p) => (
                <li key={`${p.sessionId}/${p.phaseId}`}>
                  <PinRef tag={p.tag} sha={p.sha} />
                  <span className="prj-cc__meta">
                    {p.phaseId} · {formatShortDate(p.at)} ·{' '}
                    <Link to={`/sessions/${encodeURIComponent(p.sessionId)}`}>{shortId(p.sessionId)}</Link>
                  </span>
                </li>
              ))}
            </ul>
            <ShowMore total={pinRows.length} shown={5} expanded={allPins} onToggle={() => setAllPins((a) => !a)} />
          </>
        )}
      </section>
    </div>
  );
}

// ── Process types & playbooks ───────────────────────────────────────────────

const CLASS_TONE: Record<string, Tone> = { discovery: 'accent', execution: 'info', triage: 'neutral', maintenance: 'neutral' };

export function ProcessTypesPanel({
  sessions,
  types,
  playbooks,
}: {
  sessions: readonly SessionSummary[];
  types: readonly ProcessTypeView[] | undefined;
  playbooks: readonly PlaybookDTO[] | undefined;
}) {
  const used = useMemo(() => {
    const m = new Map<string, { sessions: number; models: Set<string> }>();
    for (const s of sessions) {
      if (!s.processType) continue;
      const e = m.get(s.processType) ?? { sessions: 0, models: new Set<string>() };
      e.sessions += 1;
      if (s.model) e.models.add(modelWord(s.model));
      m.set(s.processType, e);
    }
    return [...m.entries()].sort((a, b) => b[1].sessions - a[1].sessions);
  }, [sessions]);
  if (used.length === 0)
    return <EmptyState size="sm" icon="registry" title="No sessions yet" body="Process types appear once sessions run here." />;
  const typeOf = new Map((types ?? []).map((t) => [t.id, t]));
  const playbookOf = new Map((playbooks ?? []).map((p) => [p.playbookId, p]));
  return (
    <div className="prj-scroll">
      <table className="prj-log prj-types">
        <caption className="aoc-sr-only">Process types used in this project</caption>
        <thead>
          <tr>
            <th scope="col">Process type</th>
            <th scope="col" className="is-end">
              Sessions
            </th>
            <th scope="col">Ran on</th>
            <th scope="col">Active playbook</th>
          </tr>
        </thead>
        <tbody>
          {used.map(([id, u]) => {
            const t = typeOf.get(id);
            const pb = t?.activePlaybookId ? playbookOf.get(t.activePlaybookId) : undefined;
            return (
              <tr key={id}>
                <td data-label="Process type">
                  <span className="prj-types__name">{t?.name ?? id}</span>
                  {t && <Badge tone={CLASS_TONE[t.class] ?? 'neutral'}>{t.class}</Badge>}
                </td>
                <td data-label="Sessions" className="is-end aoc-num">
                  {formatInteger(u.sessions)}
                </td>
                <td data-label="Ran on">
                  {[...u.models].join(', ') || '—'}
                  {t && <span className="prj-muted"> · routes to {t.currentModel}</span>}
                </td>
                <td data-label="Active playbook">
                  {pb ? (
                    <span className="prj-types__pb">
                      <Icon name="ok" size={12} className="prj-types__pb-icon" />
                      <Link to="/registry">{pb.title}</Link>
                      <span className="prj-muted">· v{pb.version}</span>
                    </span>
                  ) : (
                    <span className="prj-muted">no playbook</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
