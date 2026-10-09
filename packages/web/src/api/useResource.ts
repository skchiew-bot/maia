import { useCallback, useEffect, useRef, useState } from 'react';
import { useLatest } from '../lib/dom';
import { apiGet, type QueryValue } from './client';
import { useEventStream, useStreamResync, type StreamMessage } from './stream';

/** Burst window: several matching events within it cause one refetch. */
export const REFRESH_COALESCE_MS = 120;

export interface UseResourceOptions {
  /**
   * Refetch when a stream message matches. This is the only refresh mechanism — there are no polling loops.
   * Bursts are coalesced into one request, and a stream re-open (missed events) also refetches.
   */
  refreshOn?: (msg: StreamMessage) => boolean;
  /** Query parameters (part of the identity: changing them refetches). */
  query?: Record<string, QueryValue>;
  /** Set false to hold off (e.g. until an id is known). Default true. */
  enabled?: boolean;
}

export interface ResourceState<T> {
  /** Last successfully loaded data; kept during refetches so views hold their frame. */
  data: T | undefined;
  /** Error from the latest attempt (cleared by the next success). */
  error: unknown;
  /** A request is in flight (initial load or refetch). */
  loading: boolean;
  /** Refetch now. */
  reload: () => void;
}

/**
 * Fetches `path` as JSON and keeps it fresh from the event stream.
 *
 * ```ts
 * const decisions = useResource<DecisionDto[]>('/api/decisions', {
 *   refreshOn: (m) => m.kind === 'aoc' && m.event.type.startsWith('decision.'),
 * });
 * ```
 * Pass `null` as the path to skip fetching.
 */
export function useResource<T>(path: string | null, options: UseResourceOptions = {}): ResourceState<T> {
  const { enabled = true, query } = options;
  const queryKey = query ? JSON.stringify(query) : '';
  const active = enabled && path !== null;

  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({
    data: undefined,
    error: undefined,
    loading: active,
  });
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const coalesce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshOn = useLatest(options.refreshOn);
  const queryRef = useLatest(query);

  const load = useCallback(() => {
    if (!active || path === null) return;
    const id = ++requestId.current;
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    apiGet<T>(path, { signal: ac.signal, query: queryRef.current }).then(
      (data) => {
        if (id === requestId.current) setState({ data, error: undefined, loading: false });
      },
      (error: unknown) => {
        if (ac.signal.aborted || id !== requestId.current) return;
        setState((s) => ({ ...s, error, loading: false }));
      },
    );
    // queryKey stands in for the query object's identity.
  }, [active, path, queryKey, queryRef]);

  // A different resource must never show the previous one's data while it loads.
  const identity = `${path ?? ''}|${queryKey}`;
  const loadedIdentity = useRef(identity);

  useEffect(() => {
    if (loadedIdentity.current !== identity) {
      loadedIdentity.current = identity;
      setState({ data: undefined, error: undefined, loading: active });
    }
    if (!active) {
      setState((s) => (s.loading ? { ...s, loading: false } : s));
      return undefined;
    }
    load();
    return () => {
      controller.current?.abort();
      clearTimeout(coalesce.current);
      coalesce.current = undefined;
    };
  }, [active, load, identity]);

  const scheduleReload = useCallback(() => {
    if (coalesce.current !== undefined) return;
    coalesce.current = setTimeout(() => {
      coalesce.current = undefined;
      load();
    }, REFRESH_COALESCE_MS);
  }, [load]);

  useEventStream((msg) => {
    if (active && refreshOn.current?.(msg)) scheduleReload();
  });

  useStreamResync(() => {
    if (active && refreshOn.current) scheduleReload();
  });

  return { ...state, reload: load };
}
