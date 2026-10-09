import type { SessionDetail, SessionSummary, ThreadDetail } from '@aoc/contracts';
import { Link } from 'react-router-dom';
import { LivenessBadge } from '../../components/liveness/LivenessBadge';
import { cx } from '../../lib/dom';
import { formatClock, formatInteger, formatShortDate } from '../../lib/format';
import { Glyph } from './glyphs';
import { sessionLiveness, shortId } from './sessionText';

export interface ThreadLineageProps {
  session: SessionDetail;
  thread: ThreadDetail | undefined;
  /** Summaries of the project's sessions, for titles and states. */
  sessions: ReadonlyMap<string, SessionSummary>;
  now: number;
}

const REASON_WORD: Record<string, string> = {
  rollover: 'rolled over',
  ended: 'ended',
  failed: 'failed',
  stopped: 'stopped',
};

function when(iso: string, now: number): string {
  const t = Date.parse(iso);
  return now - t > 20 * 3600_000 ? `${formatShortDate(t)}, ${formatClock(t)}` : formatClock(t);
}

function SessionRef({ id, sessions, label }: { id: string; sessions: ReadonlyMap<string, SessionSummary>; label: string }) {
  const s = sessions.get(id);
  return (
    <span className="session-lineage__ref">
      <span className="session-lineage__dir">{label}</span>
      <Link to={`/sessions/${encodeURIComponent(id)}`}>{s?.title ?? shortId(id)}</Link>
      {s && <LivenessBadge state={sessionLiveness(s)} size="sm" />}
    </span>
  );
}

/**
 * The durable project thread (§5): one writer session at a time, rollovers at clean task boundaries. Shows
 * where this session sits, the rollover links and the writer hand-offs.
 */
export function ThreadLineage({ session, thread, sessions, now }: ThreadLineageProps) {
  if (!session.threadId) {
    return <p className="session-empty-line">Not on a project thread (observed sessions have none).</p>;
  }
  const ids = thread?.sessionIds ?? [];
  const index = ids.indexOf(session.sessionId);
  const previous = session.predecessorSessionId ?? (index > 0 ? ids[index - 1] : undefined);
  const next = session.successorSessionId ?? (index >= 0 && index < ids.length - 1 ? ids[index + 1] : undefined);
  const writers = thread?.writers ?? [];
  return (
    <div className="session-lineage">
      <p className="session-lineage__thread">
        <strong>{thread?.title ?? session.threadId}</strong>
        {ids.length > 0 && (
          <>
            {' · '}session <span className="aoc-num">{formatInteger(index + 1)}</span> of{' '}
            <span className="aoc-num">{formatInteger(ids.length)}</span>
          </>
        )}
        {thread?.activeWriterSessionId && (
          <>
            {' · '}
            {thread.activeWriterSessionId === session.sessionId ? 'this session holds the writer lock' : 'another session holds the writer lock'}
          </>
        )}
      </p>
      {(session.predecessorSessionId || session.successorSessionId) && (
        <p className="session-lineage__rollover">
          <Glyph name="rollover" size={14} />
          {session.predecessorSessionId && <>Rolled over from {shortId(session.predecessorSessionId)}. </>}
          {session.successorSessionId && <>Rolled over to {shortId(session.successorSessionId)}.</>}
        </p>
      )}
      <div className="session-lineage__nav">
        {previous ? <SessionRef id={previous} sessions={sessions} label="← Previous" /> : <span className="session-lineage__none">First session on this thread</span>}
        {next ? <SessionRef id={next} sessions={sessions} label="Next →" /> : <span className="session-lineage__none">Latest session on this thread</span>}
      </div>
      {writers.length > 0 && (
        <ol className="session-lineage__writers" aria-label="Writer hand-offs">
          {writers.map((w) => (
            <li key={`${w.sessionId}-${w.acquiredAt}`} className={cx(w.sessionId === session.sessionId && 'is-current')}>
              <span className="aoc-num">{when(w.acquiredAt, now)}</span>
              <Link to={`/sessions/${encodeURIComponent(w.sessionId)}`}>{sessions.get(w.sessionId)?.title ?? shortId(w.sessionId)}</Link>
              <span className="session-lineage__reason">
                {w.releasedAt ? `${REASON_WORD[w.reason ?? ''] ?? 'released'} ${when(w.releasedAt, now)}` : 'writing now'}
              </span>
            </li>
          ))}
        </ol>
      )}
      {ids.length > 1 && (
        <details className="session-lineage__all">
          <summary>All {formatInteger(ids.length)} sessions on this thread</summary>
          <ol>
            {ids.map((id, i) => {
              const s = sessions.get(id);
              return (
                <li key={id} className={cx(id === session.sessionId && 'is-current')}>
                  <span className="session-lineage__n aoc-num">{i + 1}</span>
                  {id === session.sessionId ? (
                    <span aria-current="page">{s?.title ?? shortId(id)}</span>
                  ) : (
                    <Link to={`/sessions/${encodeURIComponent(id)}`}>{s?.title ?? shortId(id)}</Link>
                  )}
                  {s && <span className="session-lineage__date">{when(s.startedAt, now)}</span>}
                </li>
              );
            })}
          </ol>
        </details>
      )}
    </div>
  );
}
