import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { isLivenessState, type LivenessState } from '../components/liveness/liveness';
import { useLatest } from '../lib/dom';

/**
 * Live updates from the daemon over Server-Sent Events (`GET /api/stream`). Two named events:
 * - `event: aoc` — a committed event-log entry `{seq, type, ts, scope, meta}` (meta is ids/enums only).
 * - `event: liveness` — a liveness state change `{sessionId, state, reason, since}`.
 * The UI changes only when one of these arrives (no polling, no idle animation).
 */

/** Ids an event is scoped to (project, session, task, …), as the daemon's envelope provides them. */
export type AocEventScope = Readonly<Record<string, string | undefined>>;

export interface AocEvent {
  /** Monotonic log sequence number. */
  seq: number;
  /** Dotted event type, e.g. `decision.requested`, `task.done`. */
  type: string;
  /** Commit time, ISO-8601. */
  ts: string;
  scope: AocEventScope;
  /** Clear-text chained metadata: ids, enums, numbers, hashes — never free text. */
  meta: Readonly<Record<string, unknown>>;
}

export interface LivenessEvent {
  sessionId: string;
  state: LivenessState;
  /** Machine reason code (e.g. `plan_limit`, `no_heartbeat`). */
  reason?: string;
  /** When the session entered this state, ISO-8601. */
  since: string;
}

export type StreamMessage = { kind: 'aoc'; event: AocEvent } | { kind: 'liveness'; event: LivenessEvent };

/**
 * Which messages a subscriber wants: a predicate, or a descriptor. `type` matches exactly or by prefix with a
 * trailing `*` (`decision.*`); `sessionId` matches liveness events and aoc events scoped to that session.
 */
export type StreamFilter =
  | ((msg: StreamMessage) => boolean)
  | {
      kind?: StreamMessage['kind'];
      type?: string | readonly string[];
      sessionId?: string;
    };

/** `connecting` before the first open, `live` while open, `reconnecting` during backoff, `offline` without SSE. */
export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

type Listener = (msg: StreamMessage) => void;

interface StreamBus {
  subscribe(listener: Listener): () => void;
  /** Called after the stream re-opens, when events may have been missed — subscribers should refetch. */
  onResync(listener: () => void): () => void;
}

const BusContext = createContext<StreamBus | null>(null);
const StatusContext = createContext<ConnectionStatus>('offline');

function typeMatches(pattern: string, type: string): boolean {
  return pattern.endsWith('*') ? type.startsWith(pattern.slice(0, -1)) : pattern === type;
}

/** Applies a StreamFilter to a message. Exported for tests and custom hooks. */
export function matchesFilter(filter: StreamFilter | undefined, msg: StreamMessage): boolean {
  if (!filter) return true;
  if (typeof filter === 'function') return filter(msg);
  if (filter.kind && filter.kind !== msg.kind) return false;
  if (filter.type) {
    if (msg.kind !== 'aoc') return false;
    const patterns = typeof filter.type === 'string' ? [filter.type] : filter.type;
    if (!patterns.some((p) => typeMatches(p, msg.event.type))) return false;
  }
  if (filter.sessionId) {
    const sid = msg.kind === 'liveness' ? msg.event.sessionId : msg.event.scope.sessionId;
    if (sid !== filter.sessionId) return false;
  }
  return true;
}

function parseAoc(data: string): AocEvent | null {
  try {
    const v = JSON.parse(data) as Partial<AocEvent>;
    if (typeof v.seq !== 'number' || typeof v.type !== 'string') return null;
    return {
      seq: v.seq,
      type: v.type,
      ts: typeof v.ts === 'string' ? v.ts : String(v.ts ?? ''),
      scope: v.scope && typeof v.scope === 'object' ? v.scope : {},
      meta: v.meta && typeof v.meta === 'object' ? v.meta : {},
    };
  } catch {
    return null;
  }
}

function parseLiveness(data: string): LivenessEvent | null {
  try {
    const v = JSON.parse(data) as Partial<LivenessEvent>;
    if (typeof v.sessionId !== 'string' || !isLivenessState(v.state)) return null;
    return {
      sessionId: v.sessionId,
      state: v.state,
      reason: typeof v.reason === 'string' ? v.reason : undefined,
      since: typeof v.since === 'string' ? v.since : '',
    };
  } catch {
    return null;
  }
}

/** Exponential backoff with ±20% jitter: 1s, 2s, 4s … capped at 30s. */
export function backoffDelay(
  attempt: number,
  initialMs = 1000,
  maxMs = 30_000,
  random = Math.random,
): number {
  const base = Math.min(maxMs, initialMs * 2 ** attempt);
  return Math.round(base * (0.8 + random() * 0.4));
}

export interface EventStreamProviderProps {
  children: ReactNode;
  /** Stream endpoint. Default `/api/stream`. */
  url?: string;
  /** EventSource implementation (tests inject a fake). Defaults to the browser's. */
  eventSource?: typeof EventSource;
}

/**
 * Owns the single EventSource for the operator console. On error it closes the source and reconnects with
 * backoff; after any re-open it asks subscribers to resync, because events during the gap were missed.
 */
export function EventStreamProvider({
  children,
  url = '/api/stream',
  eventSource,
}: EventStreamProviderProps) {
  const listeners = useRef(new Set<Listener>());
  const resyncListeners = useRef(new Set<() => void>());
  const [status, setStatus] = useState<ConnectionStatus>('connecting');

  const bus = useMemo<StreamBus>(
    () => ({
      subscribe(listener) {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener);
      },
      onResync(listener) {
        resyncListeners.current.add(listener);
        return () => resyncListeners.current.delete(listener);
      },
    }),
    [],
  );

  useEffect(() => {
    const Impl = eventSource ?? (typeof EventSource === 'undefined' ? undefined : EventSource);
    if (!Impl) {
      setStatus('offline');
      return undefined;
    }
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let opened = false;
    let disposed = false;

    const dispatch = (msg: StreamMessage) => {
      for (const l of [...listeners.current]) {
        try {
          l(msg);
        } catch (err) {
          console.error('Stream listener failed', err);
        }
      }
    };

    const connect = () => {
      const es = new Impl(url, { withCredentials: true });
      source = es;
      es.onopen = () => {
        const resync = opened || attempt > 0;
        opened = true;
        attempt = 0;
        setStatus('live');
        if (resync) for (const l of [...resyncListeners.current]) l();
      };
      es.addEventListener('aoc', (e) => {
        const event = parseAoc((e as MessageEvent<string>).data);
        if (event) dispatch({ kind: 'aoc', event });
      });
      es.addEventListener('liveness', (e) => {
        const event = parseLiveness((e as MessageEvent<string>).data);
        if (event) dispatch({ kind: 'liveness', event });
      });
      es.onerror = () => {
        es.close();
        if (source === es) source = null;
        if (disposed) return;
        setStatus('reconnecting');
        clearTimeout(timer);
        timer = setTimeout(connect, backoffDelay(attempt));
        attempt += 1;
      };
    };

    setStatus('connecting');
    connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      source?.close();
    };
  }, [url, eventSource]);

  return createElement(
    BusContext.Provider,
    { value: bus },
    createElement(StatusContext.Provider, { value: status }, children),
  );
}

/**
 * Calls `handler` for every stream message that passes `filter`. The latest handler/filter are always used,
 * so inline closures are fine. Outside an EventStreamProvider (e.g. the requester portal) it does nothing.
 */
export function useEventStream(handler: (msg: StreamMessage) => void, filter?: StreamFilter): void {
  const bus = useContext(BusContext);
  const handlerRef = useLatest(handler);
  const filterRef = useLatest(filter);
  useEffect(() => {
    if (!bus) return undefined;
    return bus.subscribe((msg) => {
      if (matchesFilter(filterRef.current, msg)) handlerRef.current(msg);
    });
  }, [bus, handlerRef, filterRef]);
}

/** Runs `callback` whenever the stream re-opens after a gap (missed events → refetch). */
export function useStreamResync(callback: () => void): void {
  const bus = useContext(BusContext);
  const cb = useLatest(callback);
  useEffect(() => {
    if (!bus) return undefined;
    return bus.onResync(() => cb.current());
  }, [bus, cb]);
}

/** Connection status for the top bar ("Live" / "Reconnecting…"). `offline` outside a provider. */
export function useStreamStatus(): ConnectionStatus {
  return useContext(StatusContext);
}
