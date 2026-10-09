import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ConsoleSnapshot, DecisionCardView, DecisionListResponse, TowerSnapshot } from '@aoc/contracts';
import {
  useEventStream,
  useResource,
  useStreamResync,
  type ResourceState,
  type StreamMessage,
} from '../../api';
import { useLatest } from '../../lib/dom';

const TOWER_PATH = '/api/tower';

/**
 * Event families that can move a Control Tower number: decisions, liveness, credits, change control, rollups,
 * anchors and the audit chain, intake/tickets, FX, throttling, promotions/rollbacks, break-glass, plans and
 * task completions. High-volume telemetry (`tool.used`, `usage.recorded`, turn starts/ends) is deliberately
 * excluded — those never change what needs a human.
 */
const REFRESH_PREFIXES = [
  'decision.',
  'credit.',
  'change.',
  'rollup.',
  'anchor.',
  'chain.',
  'intake.',
  'ticket.',
  'breakglass.',
  'promotion.',
  'rollback.',
  'fx.',
  'throttle.',
  'selfmod.',
  'mapping.',
  'plan.',
] as const;
const REFRESH_TYPES: ReadonlySet<string> = new Set([
  'session.liveness_changed',
  'session.launched',
  'session.ended',
  'session.nudged',
  'session.restarted',
  'session.rollover_completed',
  'task.done',
  'phase.completed',
  'project.created',
  'project.updated',
]);

export function isTowerRefreshEvent(msg: StreamMessage): boolean {
  if (msg.kind !== 'aoc') return false;
  const type = msg.event.type;
  return REFRESH_TYPES.has(type) || REFRESH_PREFIXES.some((p) => type.startsWith(p));
}

/** First refetch waits this long so a burst of events (one commit, several headers) costs one request. */
const TOWER_BURST_MS = 150;
/** At most one snapshot refetch per this interval, however busy the event stream is. */
const TOWER_MIN_INTERVAL_MS = 1000;

/**
 * Calls `reload` for matching stream events with coalescing: a burst window, then at most one call per
 * `minIntervalMs` (trailing, so the last event in a busy period is never lost). A stream re-open (events
 * possibly missed) also reloads. No timers run while the stream is quiet — this is not polling.
 */
export function useCoalescedRefresh(
  reload: () => void,
  matches: (msg: StreamMessage) => boolean,
  opts: { burstMs?: number; minIntervalMs?: number } = {},
): void {
  const burstMs = opts.burstMs ?? TOWER_BURST_MS;
  const minIntervalMs = opts.minIntervalMs ?? TOWER_MIN_INTERVAL_MS;
  const reloadRef = useLatest(reload);
  const matchesRef = useLatest(matches);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lastRun = useRef(Number.NEGATIVE_INFINITY);

  const schedule = useCallback(() => {
    if (timer.current !== undefined) return;
    const wait = Math.max(burstMs, lastRun.current + minIntervalMs - performance.now());
    timer.current = setTimeout(() => {
      timer.current = undefined;
      lastRun.current = performance.now();
      reloadRef.current();
    }, wait);
  }, [burstMs, minIntervalMs, reloadRef]);

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      timer.current = undefined;
    },
    [],
  );
  useEventStream((msg) => {
    if (matchesRef.current(msg)) schedule();
  });
  useStreamResync(schedule);
}

/** The Control Tower snapshot, kept fresh from the event stream (no polling). */
export function useTowerSnapshot(): ResourceState<TowerSnapshot> {
  const resource = useResource<TowerSnapshot>(TOWER_PATH);
  useCoalescedRefresh(resource.reload, isTowerRefreshEvent);
  return resource;
}

const isDecisionEvent = (m: StreamMessage) => m.kind === 'aoc' && m.event.type.startsWith('decision.');
const OPEN_DECISIONS = { status: 'open' } as const;

/**
 * Open decision cards by id. The queue row only carries a decision id; the card supplies the options, the
 * recommendation (what Approve applies) and whether this viewer may resolve it.
 */
export function useOpenDecisions(): {
  cards: ReadonlyMap<string, DecisionCardView> | null;
  error: unknown;
} {
  const res = useResource<DecisionListResponse>('/api/decisions', {
    query: OPEN_DECISIONS,
    refreshOn: isDecisionEvent,
  });
  const cards = useMemo(
    () => (res.data ? new Map(res.data.decisions.map((d) => [d.id, d])) : null),
    [res.data],
  );
  return { cards, error: res.error };
}

const isLaunchEvent = (m: StreamMessage) =>
  m.kind === 'aoc' && (m.event.type === 'session.launch_requested' || m.event.type === 'session.launched');

/**
 * Session → owner, for viewers who may only drive their own sessions (Builders). Approvers hold
 * `session.drive_any`, so nothing is fetched for them.
 */
export function useSessionOwners(enabled: boolean): ReadonlyMap<string, string | null> | null {
  const res = useResource<ConsoleSnapshot>('/api/console', { enabled, refreshOn: isLaunchEvent });
  return useMemo(
    () => (res.data ? new Map(res.data.sessions.map((s) => [s.sessionId, s.ownerId])) : null),
    [res.data],
  );
}
