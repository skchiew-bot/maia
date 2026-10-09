import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditEventPageDTO, PasskeyDto } from '@aoc/contracts';
import { REFRESH_COALESCE_MS, apiGet, useEventStream, useStreamResync, type ResourceState } from '../../api';
import { isIdentityEvent, type UserFacts } from './model';

/**
 * Per-person facts the user list does not carry: registered passkeys and the newest audited action. One
 * request pair per person, refetched (coalesced) when an identity event arrives or the stream resyncs — never
 * on a timer.
 */
export function useUserFacts(userIds: readonly string[] | undefined): ResourceState<Map<string, UserFacts>> {
  const key = userIds ? [...userIds].sort().join(',') : null;
  const [state, setState] = useState<{
    data: Map<string, UserFacts> | undefined;
    error: unknown;
    loading: boolean;
  }>({ data: undefined, error: undefined, loading: key !== null });
  const requestId = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const coalesce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(() => {
    if (key === null) return;
    const id = ++requestId.current;
    controller.current?.abort();
    const ac = new AbortController();
    controller.current = ac;
    setState((s) => (s.loading ? s : { ...s, loading: true }));
    const ids = key ? key.split(',') : [];
    Promise.all(
      ids.map(async (userId) => {
        const [pk, events] = await Promise.all([
          apiGet<{ passkeys: PasskeyDto[] }>('/api/passkeys', { query: { userId }, signal: ac.signal }),
          apiGet<AuditEventPageDTO>('/api/audit/events', {
            query: { actorId: userId, order: 'desc', limit: 1 },
            signal: ac.signal,
          }),
        ]);
        return [userId, { passkeys: pk.passkeys, lastActionAt: events.events[0]?.ts ?? null }] as const;
      }),
    ).then(
      (entries) => {
        if (id === requestId.current) setState({ data: new Map(entries), error: undefined, loading: false });
      },
      (error: unknown) => {
        if (ac.signal.aborted || id !== requestId.current) return;
        setState((s) => ({ ...s, error, loading: false }));
      },
    );
  }, [key]);

  useEffect(() => {
    load();
    return () => {
      controller.current?.abort();
      clearTimeout(coalesce.current);
      coalesce.current = undefined;
    };
  }, [load]);

  const schedule = useCallback(() => {
    if (coalesce.current !== undefined) return;
    coalesce.current = setTimeout(() => {
      coalesce.current = undefined;
      load();
    }, REFRESH_COALESCE_MS);
  }, [load]);

  useEventStream((msg) => {
    if (msg.kind === 'aoc' && isIdentityEvent(msg.event.type)) schedule();
  });
  useStreamResync(schedule);

  return { ...state, reload: load };
}
