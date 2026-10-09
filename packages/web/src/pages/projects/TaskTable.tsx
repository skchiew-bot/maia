import { Link } from 'react-router-dom';
import type { ManifestTaskDTO, SessionSummary } from '@aoc/contracts';
import { cx } from '../../lib/dom';
import { formatClock, formatShortDate } from '../../lib/format';
import { isFlagged, shortId, type People } from './model';
import { EvidenceChip, FlagNote, SizeChip, StatusText } from './parts';

export type TaskFilter = 'all' | 'open' | 'flagged';

export function matchesTaskFilter(t: ManifestTaskDTO, filter: TaskFilter): boolean {
  if (filter === 'open') return t.status === 'open';
  if (filter === 'flagged') return isFlagged(t);
  return true;
}

function doneLabel(at: string): string {
  return `Done ${formatShortDate(at)}, ${formatClock(at)}`;
}

/**
 * The tasks of one phase across every developer (§9): owner, declared size, status and the evidence each close
 * carried (§4). Titles, refs and reasons are untrusted text and render as text only.
 */
export function TaskTable({
  caption,
  tasks,
  people,
  sessions,
}: {
  caption: string;
  tasks: readonly ManifestTaskDTO[];
  people: People;
  sessions: ReadonlyMap<string, SessionSummary>;
}) {
  return (
    <div className="prj-tasks-wrap">
      <table className="prj-tasks">
        <caption className="aoc-sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Title</th>
            <th scope="col">Developer</th>
            <th scope="col">Size</th>
            <th scope="col">Status</th>
            <th scope="col">Evidence</th>
            <th scope="col">Session</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => {
            const session = sessions.get(t.sessionId);
            const owner = people.resolve(t.declaredBy, t.sessionId);
            return (
              <tr
                key={`${t.sessionId}/${t.taskId}`}
                className={cx(isFlagged(t) && 'is-flagged', t.status === 'removed' && 'is-removed')}
              >
                <td className="prj-tasks__id" data-label="Task">
                  {t.taskId}
                </td>
                <td className="prj-tasks__title" data-label="Title">
                  <span className="prj-tasks__title-text">{t.title}</span>
                  {t.flag && t.status === 'done' && <FlagNote flag={t.flag} />}
                  {t.status === 'removed' && (
                    <p className="prj-tasks__note">Removed by an audited amendment</p>
                  )}
                  {t.carriedToSessionId && (
                    <p className="prj-tasks__note">
                      Carried over to {shortId(t.carriedToSessionId)} at rollover
                    </p>
                  )}
                </td>
                <td className="prj-tasks__owner" data-label="Developer">
                  {owner.name}
                </td>
                <td data-label="Size">
                  <SizeChip size={t.size} />
                </td>
                <td data-label="Status">
                  {t.status === 'done' && t.doneAt ? (
                    <StatusText state="done">
                      <time dateTime={t.doneAt}>{doneLabel(t.doneAt)}</time>
                    </StatusText>
                  ) : t.status === 'removed' ? (
                    <StatusText state="removed" />
                  ) : (
                    <StatusText state="pending">Open</StatusText>
                  )}
                </td>
                <td className="prj-tasks__evidence" data-label="Evidence">
                  {t.evidence ? <EvidenceChip evidence={t.evidence} /> : <span className="prj-muted">—</span>}
                </td>
                <td className="prj-tasks__session" data-label="Session">
                  <Link to={`/sessions/${encodeURIComponent(t.sessionId)}`} title={session?.title}>
                    {shortId(t.sessionId)}
                  </Link>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
