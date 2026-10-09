import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuditEventHeaderDTO, AuditEventPageDTO } from '@aoc/contracts';
import { apiGet } from '../../api/client';
import { useEventStream, type StreamMessage } from '../../api/stream';
import { useResource } from '../../api/useResource';
import { Button, EmptyState, InlineAlert, describeError } from '../../components';
import { formatInteger } from '../../lib/format';
import { EventTable } from './EventTable';
import { parseScopeFilter, parseTypeFilter, rangeCutoff, withinRange, type RangePreset } from './model';
import { LoadFailed, Skeleton } from './Skeleton';

export interface ExplorerFilters {
  /** Type filter as typed: a family prefix (`change.`) or exact types. */
  q: string;
  actorId: string;
  projectId: string;
  /** A session or ticket id. */
  scopeId: string;
  range: RangePreset;
}

/** Events per page: a phone shows each event as a card, so it pages in smaller steps. */
const PAGE = 100;
const PHONE_PAGE = 25;

/** The daemon query for the filters (newest first). */
export function explorerQuery(f: ExplorerFilters, limit = PAGE) {
  return {
    order: 'desc' as const,
    limit,
    ...parseTypeFilter(f.q),
    actorId: f.actorId || undefined,
    ...parseScopeFilter(f.scopeId),
    ...(f.projectId ? { projectId: f.projectId } : {}),
  };
}

/** Whether a live event would appear under these filters (actors are not on the stream, so they cannot narrow it). */
function matchesLive(f: ExplorerFilters, msg: StreamMessage): boolean {
  if (msg.kind !== 'aoc') return false;
  const e = msg.event;
  const t = parseTypeFilter(f.q);
  if (t.type && !t.type.split(',').includes(e.type)) return false;
  if (t.typePrefix && !e.type.startsWith(t.typePrefix)) return false;
  const s = parseScopeFilter(f.scopeId);
  if (s.sessionId && e.scope.sessionId !== s.sessionId) return false;
  if (s.ticketId && e.scope.ticketId !== s.ticketId) return false;
  const project = f.projectId || s.projectId;
  if (project && e.scope.projectId !== project) return false;
  return true;
}

export function Explorer({
  filters,
  now,
  onOpen,
}: {
  filters: ExplorerFilters;
  now: number;
  onOpen: (e: AuditEventHeaderDTO) => void;
}) {
  // Chosen once: a later resize keeps the loaded pages instead of refetching them at another size.
  const [pageSize] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia?.('(max-width: 640px)').matches ? PHONE_PAGE : PAGE,
  );
  const query = useMemo(() => explorerQuery(filters, pageSize), [filters, pageSize]);
  const first = useResource<AuditEventPageDTO>('/api/audit/events', { query });
  const [older, setOlder] = useState<{ events: AuditEventHeaderDTO[]; next: number | null } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<unknown>(undefined);
  const [fresh, setFresh] = useState(0);
  const topSeq = useRef(0);

  const queryKey = JSON.stringify(query);
  useEffect(() => {
    setOlder(null);
    setOlderError(undefined);
    setFresh(0);
  }, [queryKey, first.data]);
  useEffect(() => {
    if (first.data) topSeq.current = first.data.events[0]?.seq ?? first.data.headSeq;
  }, [first.data]);

  useEventStream((msg) => {
    if (msg.kind === 'aoc' && msg.event.seq > topSeq.current && matchesLive(filters, msg))
      setFresh((n) => n + 1);
  });

  const cutoff = rangeCutoff(filters.range, now);
  const all = useMemo(() => [...(first.data?.events ?? []), ...(older?.events ?? [])], [first.data, older]);
  const shown = useMemo(() => withinRange(all, cutoff), [all, cutoff]);
  const next = older ? older.next : (first.data?.nextToSeq ?? null);
  const reachedCutoff = cutoff !== null && all.length > 0 && Date.parse(all[all.length - 1]!.ts) < cutoff;
  const canLoadOlder = next !== null && !reachedCutoff;

  const loadOlder = useCallback(async () => {
    if (next === null) return;
    setLoadingOlder(true);
    setOlderError(undefined);
    try {
      const page = await apiGet<AuditEventPageDTO>('/api/audit/events', { query: { ...query, toSeq: next } });
      setOlder((o) => ({ events: [...(o?.events ?? []), ...page.events], next: page.nextToSeq }));
    } catch (err) {
      setOlderError(err);
    } finally {
      setLoadingOlder(false);
    }
  }, [next, query]);

  if (!first.data) {
    if (first.error) return <LoadFailed what="audit events" error={first.error} onRetry={first.reload} />;
    return <Skeleton label="Loading audit events" blocks={[360]} />;
  }

  return (
    <div className="audit-explorer">
      <div className="audit-explorer__bar" aria-live="polite">
        <span className="aoc-num">
          {formatInteger(shown.length)} {shown.length === 1 ? 'event' : 'events'} shown · chain head #
          {formatInteger(first.data.headSeq)}
        </span>
        {fresh > 0 && (
          <button
            type="button"
            className="audit-explorer__fresh"
            onClick={() => {
              setFresh(0);
              first.reload();
            }}
          >
            {formatInteger(fresh)} new {fresh === 1 ? 'event' : 'events'}
            {filters.actorId ? ' (any actor)' : ''} — show
          </button>
        )}
      </div>
      {first.error !== undefined && (
        <InlineAlert tone="warn" title="Showing the last loaded events">
          {describeError(first.error)}
        </InlineAlert>
      )}
      <EventTable
        caption="Audit events, newest first"
        events={shown}
        onOpen={onOpen}
        maxHeight={560}
        empty={
          <EmptyState
            size="sm"
            icon="audit"
            title="No events match"
            body="Widen the time range or clear a filter. Every state change is an event, so an empty result means none happened in this slice."
          />
        }
      />
      <div className="audit-explorer__more">
        {canLoadOlder ? (
          <Button size="sm" loading={loadingOlder} loadingText="Loading…" onClick={() => void loadOlder()}>
            Load older events
          </Button>
        ) : (
          <span className="audit-muted">
            {reachedCutoff ? 'All events in this time range are shown.' : 'The start of the log is reached.'}
          </span>
        )}
        {olderError !== undefined && <span className="audit-error">{describeError(olderError)}</span>}
      </div>
    </div>
  );
}
