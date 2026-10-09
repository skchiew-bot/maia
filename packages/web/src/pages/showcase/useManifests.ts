import type { ManifestPhaseDTO, SessionTimeline } from '@aoc/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '../../api/client';
import { useEventStream, useStreamResync } from '../../api/stream';
import { REFRESH_COALESCE_MS } from '../../api/useResource';
import { MANIFEST_EVENTS } from './model';

/**
 * The plan manifest of each listed session (`/api/sessions/:id/timeline`), fetched once and refetched only when
 * an event changes that session's plan or done weight — never on a timer.
 */
export function useManifests(
  sessionIds: readonly string[],
): ReadonlyMap<string, readonly ManifestPhaseDTO[]> {
  const [manifests, setManifests] = useState<ReadonlyMap<string, readonly ManifestPhaseDTO[]>>(
    () => new Map(),
  );
  const requested = useRef(new Set<string>());
  const controllers = useRef(new Map<string, AbortController>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const wanted = useRef(new Set<string>());
  wanted.current = new Set(sessionIds);

  const load = useCallback((id: string) => {
    controllers.current.get(id)?.abort();
    const ac = new AbortController();
    controllers.current.set(id, ac);
    requested.current.add(id);
    apiGet<SessionTimeline>(`/api/sessions/${encodeURIComponent(id)}/timeline`, { signal: ac.signal }).then(
      (t) => {
        if (controllers.current.get(id) === ac) controllers.current.delete(id);
        setManifests((prev) => new Map(prev).set(id, t.manifest));
      },
      () => {
        if (controllers.current.get(id) === ac) controllers.current.delete(id);
      },
    );
  }, []);

  const schedule = useCallback(
    (id: string) => {
      if (timers.current.has(id)) return;
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          load(id);
        }, REFRESH_COALESCE_MS),
      );
    },
    [load],
  );

  const key = sessionIds.join(',');
  useEffect(() => {
    for (const id of key ? key.split(',') : []) if (!requested.current.has(id)) load(id);
  }, [key, load]);

  useEffect(
    () => () => {
      for (const ac of controllers.current.values()) ac.abort();
      for (const t of timers.current.values()) clearTimeout(t);
    },
    [],
  );

  useEventStream((m) => {
    if (m.kind !== 'aoc' || !MANIFEST_EVENTS.has(m.event.type)) return;
    const id = m.event.scope.sessionId;
    if (id && wanted.current.has(id)) schedule(id);
  });

  useStreamResync(() => {
    for (const id of wanted.current) schedule(id);
  });

  return manifests;
}
