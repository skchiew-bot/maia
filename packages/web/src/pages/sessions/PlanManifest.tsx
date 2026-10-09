import type { AmendmentDTO, ManifestPhaseDTO, ManifestTaskDTO } from '@aoc/contracts';
import { Fragment } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { InlineAlert } from '../../components/EmptyState';
import { cx } from '../../lib/dom';
import { formatClock, formatInteger, formatShortDate, shortHash } from '../../lib/format';
import { Glyph } from './glyphs';
import { amendmentDelta, flaggedTasks, phaseStatuses, type PhaseStatus } from './model';
import { evidenceRef, shortId } from './sessionText';

export interface PlanManifestProps {
  manifest: readonly ManifestPhaseDTO[];
  amendments: readonly AmendmentDTO[];
  /** Resolves user ids (amendment authors) to names when known. */
  nameOf: (id: string) => string | null;
  now: number;
}

const STATUS: Record<PhaseStatus, { word: string; glyph: 'check-circle' | 'half-circle' | 'circle' }> = {
  done: { word: 'Done', glyph: 'check-circle' },
  active: { word: 'In progress', glyph: 'half-circle' },
  pending: { word: 'Not started', glyph: 'circle' },
};

function when(iso: string, now: number): string {
  const t = Date.parse(iso);
  return now - t > 20 * 3600_000 ? `${formatShortDate(t)} ${formatClock(t)}` : formatClock(t);
}

function TaskStatus({ task, now }: { task: ManifestTaskDTO; now: number }) {
  if (task.status === 'done')
    return (
      <span className="session-task__status is-done">
        <Glyph name="check-circle" size={14} /> Done{task.doneAt ? ` ${when(task.doneAt, now)}` : ''}
      </span>
    );
  if (task.status === 'removed')
    return (
      <span className="session-task__status">
        <Icon name="minus" size={14} /> Removed
      </span>
    );
  if (task.carriedToSessionId)
    return (
      <span className="session-task__status">
        <Glyph name="rollover" size={14} /> Carried to{' '}
        <Link to={`/sessions/${encodeURIComponent(task.carriedToSessionId)}`}>{shortId(task.carriedToSessionId)}</Link>
      </span>
    );
  return (
    <span className="session-task__status">
      <Glyph name="circle" size={14} /> To do
    </span>
  );
}

/** Paths and test ids break after a separator rather than mid-name ("src/claims/" + "idempotency.ts"). */
function Breakable({ text }: { text: string }) {
  return (
    <>
      {text.split(/(?<=[/>])/).map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          {part}
        </Fragment>
      ))}
    </>
  );
}

function Evidence({ task }: { task: ManifestTaskDTO }) {
  if (!task.evidence) return <span className="session-task__none">—</span>;
  const e = task.evidence;
  return (
    <span className={cx('session-evidence', !e.verified && 'is-unverified')} title={e.ref}>
      <span className="session-evidence__kind">{e.kind}</span>
      <code className="session-evidence__ref">
        <Breakable text={evidenceRef(e.kind, e.ref)} />
      </code>
      {!e.verified && <span className="session-evidence__note">unverified</span>}
    </span>
  );
}

function FlagNote({ task }: { task: ManifestTaskDTO }) {
  if (!task.flag) return null;
  return (
    <p className="session-task__flag">
      <Glyph name="flag" size={12} />
      {task.flag === 'no_file_change'
        ? 'Closed with no file-changing tool call — counts until reviewed'
        : 'Evidence did not verify — counts until reviewed'}
    </p>
  );
}

/**
 * The plan manifest (§4, §9): phases with weighted progress, tasks with size, status and evidence, flagged
 * closes, and manifest amendments as audited rows that show how the denominator moved.
 */
export function PlanManifest({ manifest, amendments, nameOf, now }: PlanManifestProps) {
  const phases = [...manifest].sort((a, b) => a.order - b.order);
  const statuses = phaseStatuses(phases);
  const flagged = flaggedTasks(phases);
  const totalTasks = phases.reduce((n, p) => n + p.tasks.filter((t) => t.status !== 'removed').length, 0);

  if (phases.length === 0) {
    return (
      <p className="session-empty-line">
        No plan manifest yet. A managed session declares its plan before touching code; a session without one is
        blocked (§4).
      </p>
    );
  }

  return (
    <div className="session-manifest">
      {flagged.length > 0 && (
        <InlineAlert tone="warn" title={`${flagged.length} ${flagged.length === 1 ? 'task' : 'tasks'} flagged`}>
          Closed with no file change or with evidence that did not verify. Flagged tasks still count toward completion
          until reviewed.
        </InlineAlert>
      )}
      <ol className="session-phases">
        {phases.map((p) => {
          const live = p.tasks.filter((t) => t.status !== 'removed');
          const done = live.filter((t) => t.status === 'done');
          const doneW = done.reduce((n, t) => n + t.weight, 0);
          const totalW = live.reduce((n, t) => n + t.weight, 0);
          const status = statuses.get(p.phaseId) ?? 'pending';
          const pct = totalW > 0 ? doneW / totalW : 0;
          return (
            <li key={p.phaseId} className={cx('session-phase', `is-${status}`)}>
              <details open={status === 'active'}>
                <summary className="session-phase__summary">
                  <Icon name="chevron-right" size={14} className="session-phase__chev" />
                  <span className="session-phase__name">
                    <span>
                      <span className="session-phase__code">P{p.order + 1}</span> {p.name}
                    </span>
                    <span className="session-phase__sub">
                      {p.pinnedTag || p.pinnedSha ? (
                        <>
                          <Glyph name="flag" size={12} /> {p.pinnedTag ?? 'pinned'}
                          {p.pinnedSha && <> → {shortHash(p.pinnedSha, 7)}</>}
                          {p.completedAt && <> · {when(p.completedAt, now)}</>}
                        </>
                      ) : p.completedAt ? (
                        `completed ${when(p.completedAt, now)}`
                      ) : status === 'done' ? (
                        'all tasks done · no tag pinned yet'
                      ) : status === 'active' ? (
                        'in progress'
                      ) : (
                        'not started'
                      )}
                    </span>
                  </span>
                  <span className={cx('session-phase__status', `is-${status}`)}>
                    <Glyph name={STATUS[status].glyph} size={14} /> {STATUS[status].word}
                  </span>
                  <span className="session-phase__tasks aoc-num">
                    {formatInteger(done.length)}/{formatInteger(live.length)} tasks
                  </span>
                  <span className="session-phase__bar" role="img" aria-label={`${doneW} of ${totalW} weight done`}>
                    <span style={{ width: `${pct * 100}%` }} />
                  </span>
                  <span className="session-phase__weight aoc-num">
                    {doneW}/{totalW}
                  </span>
                </summary>
                <div className="session-tasks" role="table" aria-label={`P${p.order + 1} ${p.name} tasks`}>
                  <div className="session-tasks__head" role="row">
                    <span role="columnheader">Task</span>
                    <span role="columnheader">Title</span>
                    <span role="columnheader">Size</span>
                    <span role="columnheader">Status</span>
                    <span role="columnheader">Evidence</span>
                  </div>
                  {p.tasks.map((t) => (
                    <div key={`${t.sessionId}/${t.taskId}`} className={cx('session-task', t.status === 'removed' && 'is-removed')} role="row">
                      <span role="cell" className="session-task__id aoc-num" data-label="Task">
                        {t.taskId}
                      </span>
                      <span role="cell" className="session-task__title" data-label="Title">
                        {t.title}
                        <FlagNote task={t} />
                      </span>
                      <span role="cell" data-label="Size">
                        <span className="session-size" title={`weight ${t.weight}`}>
                          {t.size.toUpperCase()}
                        </span>
                      </span>
                      <span role="cell" data-label="Status">
                        <TaskStatus task={t} now={now} />
                      </span>
                      <span role="cell" data-label="Evidence">
                        <Evidence task={t} />
                      </span>
                    </div>
                  ))}
                </div>
              </details>
            </li>
          );
        })}
      </ol>
      {amendments.length > 0 && (
        <ol className="session-amendments" aria-label="Audited manifest amendments">
          {amendments.map((a, i) => (
            <li key={`${a.at}-${i}`} className="session-amendment">
              <Glyph name="plus-circle" size={14} className="session-amendment__icon" />
              <span>
                <strong>Audited amendment #{i + 1}</strong> {when(a.at, now)} · {a.byName ?? nameOf(a.by) ?? 'agent'} · +
                {a.added} −{a.removed}
                {a.resized ? ` ~${a.resized}` : ''} · reason: {a.reason} ·{' '}
                <strong className="session-amendment__delta">
                  denominator{' '}
                  {amendmentDelta(a, i === amendments.length - 1 ? totalTasks : undefined)}
                </strong>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
