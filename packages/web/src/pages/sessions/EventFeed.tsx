import type { EventHeader } from '@aoc/contracts';
import { useMemo } from 'react';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Button } from '../../components/Button';
import { EmptyState } from '../../components/EmptyState';
import { formatAge, formatClock, formatDateTime, formatInteger, formatTokens, shortHash } from '../../lib/format';
import { driftWord } from './model';

export type FeedEvent = EventHeader & { hash: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : v === null || v === undefined ? '—' : String(v));
const num = (v: unknown): number => (typeof v === 'number' ? v : 0);

/**
 * One line of context per event, from its chained meta (ids, enums and numbers only — never free text, so
 * nothing here can carry a prompt or personal data).
 */
export function eventDetail(e: Pick<EventHeader, 'type' | 'meta'>): string {
  const m = e.meta as Record<string, unknown>;
  switch (e.type) {
    case 'session.liveness_changed':
    case 'session.lifecycle_changed':
      return `${str(m.from ?? 'none').replace(/_/g, ' ')} → ${str(m.to ?? 'none').replace(/_/g, ' ')} · ${str(m.reason).replace(/_/g, ' ')}`;
    case 'session.turn_started':
      return `turn ${num(m.turn)} · ${str(m.reason).replace(/_/g, ' ')}`;
    case 'session.turn_ended':
      return `turn ${num(m.turn)} · ${str(m.outcome).replace(/_/g, ' ')}${typeof m.durationMs === 'number' ? ` · ${formatAge(m.durationMs)}` : ''}`;
    case 'session.ended':
      return str(m.outcome);
    case 'session.stop_requested':
      return m.immediate ? 'stop now' : 'stop at the next task boundary';
    case 'session.rollover_started':
      return `context ${num(m.contextPct)}%`;
    case 'session.rollover_completed':
      return `→ ${str(m.toSessionId)}`;
    case 'session.rollover_aborted':
      return str(m.reason).replace(/_/g, ' ');
    case 'session.blocked':
      return str(m.reason).replace(/_/g, ' ');
    case 'tool.used':
      return `${str(m.toolName)}${m.fileChanging ? ' · file change' : ''}${m.ok === false ? ' · failed' : ''}`;
    case 'tool.denied':
      return `${str(m.toolName)} · ${str(m.guard)} · ${str(m.decision)}`;
    case 'usage.recorded':
      return `${num(m.messages)} msgs · ${formatTokens(num(m.inputTokens) + num(m.outputTokens) + num(m.cacheReadTokens) + num(m.cacheWrite5mTokens) + num(m.cacheWrite1hTokens))} tokens · context ${formatTokens(num(m.contextTokens))}`;
    case 'task.done':
      return `${str(m.taskId)} · ${str(m.evidenceKind)} evidence${m.flag ? ` · ${str(m.flag).replace(/_/g, ' ')}` : ''}`;
    case 'plan.declared':
      return `v${num(m.manifestVersion)} · ${num(m.taskCount)} tasks · weight ${num(m.totalWeight)}`;
    case 'plan.amended':
      return `v${num(m.manifestVersion)} · +${num(m.added)} −${num(m.removed)}`;
    case 'phase.completed':
      return `${str(m.phaseId)} · ${m.pinnedTag ? str(m.pinnedTag) : m.pinnedSha ? shortHash(str(m.pinnedSha), 7) : 'no pin'}`;
    case 'decision.requested':
      return `${str(m.kind).replace(/_/g, ' ')}${m.test ? ` · test ${str(m.test)}` : ''}`;
    case 'decision.resolved':
      return `${str(m.optionId)} · ${str(m.method)}`;
    case 'throttle.hit':
      return m.resetAt ? `resets ${formatClock(str(m.resetAt))}` : 'reset time unknown';
    case 'throttle.cleared':
      return `idle ${formatAge(num(m.idleMs))}`;
    case 'drift.detected':
      return `${driftWord(str(m.kind))} · ${str(m.severity)}`;
    default:
      return '';
  }
}

export interface EventFeedProps {
  events: readonly FeedEvent[];
  limit: number;
  onMore: (() => void) | null;
  nameOf: (id: string) => string | null;
}

/** The session's slice of the hash-chained log, newest first: what happened, who did it, and the chain hash. */
export function EventFeed({ events, limit, onMore, nameOf }: EventFeedProps) {
  const columns = useMemo<DataTableColumn<FeedEvent>[]>(
    () => [
      { id: 'seq', header: 'Seq', numeric: true, width: '64px', hideOnMobile: true, cell: (e) => formatInteger(e.seq) },
      {
        id: 'time',
        header: 'Time',
        width: '72px',
        cell: (e) => (
          <time dateTime={e.ts} title={formatDateTime(e.ts)}>
            {formatClock(e.ts)}
          </time>
        ),
      },
      {
        id: 'type',
        header: 'Event',
        primary: true,
        cell: (e) => (
          <span className="session-feed__type">
            <code>{e.type}</code>
            {eventDetail(e) && <span className="session-feed__detail">{eventDetail(e)}</span>}
          </span>
        ),
      },
      {
        id: 'actor',
        header: 'Actor',
        cell: (e) =>
          e.actor.kind === 'human' ? (nameOf(e.actor.id) ?? 'person') : e.actor.kind === 'agent' ? 'agent' : e.actor.id,
      },
      {
        id: 'hash',
        header: 'Hash',
        hideOnMobile: true,
        cell: (e) => (
          <code className="session-feed__hash" title={e.hash}>
            {shortHash(e.hash, 8)}
          </code>
        ),
      },
    ],
    [nameOf],
  );
  return (
    <div className="session-feed">
      <DataTable
        caption="Events for this session, newest first"
        columns={columns}
        rows={events}
        rowKey={(e) => String(e.seq)}
        maxHeight={520}
        empty={<EmptyState size="sm" title="No events yet" body="Events appear here as the session works." />}
      />
      <p className="session-feed__foot">
        Showing the latest {formatInteger(events.length)} {events.length === 1 ? 'event' : 'events'}
        {events.length >= limit && onMore && (
          <>
            {' · '}
            <Button size="sm" variant="ghost" onClick={onMore}>
              Show more
            </Button>
          </>
        )}
      </p>
    </div>
  );
}
