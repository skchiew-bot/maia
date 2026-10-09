import { useCallback, useEffect, useRef, useState } from 'react';
import type { TowerSnapshot } from '@aoc/contracts';
import { apiPost, useEventStream } from '../../api';
import { useLatest } from '../../lib/dom';

export type ActionVerb = 'approve' | 'deny' | 'nudge' | 'restart';

/**
 * Optimistic life of an inline action:
 * `sending` (request in flight) → `sent` (API accepted it) → `confirmed` (its event reached the stream) →
 * gone once a snapshot no longer lists the item. `failed` keeps the row actionable and shows why.
 */
export type ActionPhase = 'sending' | 'sent' | 'confirmed' | 'failed';

export interface PendingAction {
  verb: ActionVerb;
  phase: ActionPhase;
  /** Decision option applied by approve / deny. */
  optionLabel?: string;
  error?: unknown;
  /** Log sequence of the event that confirmed the action (absent when reconciled by a refetch instead). */
  seq?: number;
  /** Confirmed long enough ago that the next snapshot is the truth, even if it still lists the item. */
  settled?: boolean;
}

/** The decision option an action applies; the label is unknown when only the server's option id is known. */
export interface OptionRef {
  id: string;
  label: string | null;
}

interface Watch {
  types: readonly string[];
  key: 'decisionId' | 'sessionId';
  id: string;
}

/** No confirming event this long after the API accepted (stream down?): reconcile with one refetch. */
export const CONFIRM_TIMEOUT_MS = 8000;
/**
 * A confirmed item may legitimately stay listed for a moment (a restarted session is still "dead" until its
 * new turn starts). After this long the snapshot wins again and the row is actionable.
 */
export const SETTLE_MS = 20_000;

export interface AttentionActions {
  pending: Readonly<Record<string, PendingAction>>;
  approve: (itemId: string, decisionId: string, option: OptionRef, comment: string) => void;
  deny: (itemId: string, decisionId: string, option: OptionRef, comment: string) => void;
  nudge: (itemId: string, sessionId: string, text: string) => void;
  restart: (itemId: string, sessionId: string) => void;
  /** Clears a failed action so the row returns to its normal state. */
  dismiss: (itemId: string) => void;
}

const enc = encodeURIComponent;
const DECISION_CLOSED = ['decision.resolved'] as const;

/**
 * Inline queue actions against the real APIs (mod-decisions resolve, supervisor nudge/restart) with optimistic
 * UI that reconciles on the stream: the matching event confirms the action, and the next snapshot without the
 * item removes the row. `reload` refetches the snapshot when no event arrives.
 */
export function useAttentionActions(snapshot: TowerSnapshot | undefined, reload: () => void): AttentionActions {
  const pendingRef = useRef<Record<string, PendingAction>>({});
  const [pending, setPending] = useState<Readonly<Record<string, PendingAction>>>(pendingRef.current);
  const watches = useRef(new Map<string, Watch>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reloadRef = useLatest(reload);
  const mounted = useRef(true);

  const write = useCallback((id: string, next: PendingAction | undefined) => {
    const copy = { ...pendingRef.current };
    if (next) copy[id] = next;
    else delete copy[id];
    pendingRef.current = copy;
    setPending(copy);
  }, []);

  const clearTimer = useCallback((id: string) => {
    clearTimeout(timers.current.get(id));
    timers.current.delete(id);
  }, []);

  const setTimer = useCallback(
    (id: string, ms: number, fn: () => void) => {
      clearTimer(id);
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          if (mounted.current) fn();
        }, ms),
      );
    },
    [clearTimer],
  );

  const confirm = useCallback(
    (id: string, seq?: number) => {
      watches.current.delete(id);
      const p = pendingRef.current[id];
      if (!p || (p.phase !== 'sending' && p.phase !== 'sent')) return;
      write(id, { ...p, phase: 'confirmed', seq });
      setTimer(id, SETTLE_MS, () => {
        const q = pendingRef.current[id];
        if (q?.phase === 'confirmed') write(id, { ...q, settled: true });
        reloadRef.current();
      });
    },
    [reloadRef, setTimer, write],
  );

  useEffect(() => {
    mounted.current = true;
    const owned = timers.current;
    return () => {
      mounted.current = false;
      for (const t of owned.values()) clearTimeout(t);
      owned.clear();
    };
  }, []);

  useEventStream((msg) => {
    if (msg.kind !== 'aoc' || watches.current.size === 0) return;
    for (const [id, w] of [...watches.current]) {
      if (w.types.includes(msg.event.type) && msg.event.meta[w.key] === w.id) confirm(id, msg.event.seq);
    }
  });

  // Reconcile with every new snapshot: an item that is gone is done (or its error moot); a settled one shows the
  // truth again.
  useEffect(() => {
    if (!snapshot) return;
    const present = new Set(snapshot.attention.map((i) => i.id));
    for (const [id, p] of Object.entries(pendingRef.current)) {
      if (p.phase === 'sending') continue;
      if (p.phase === 'failed' ? !present.has(id) : !present.has(id) || p.settled) {
        watches.current.delete(id);
        clearTimer(id);
        write(id, undefined);
      }
    }
  }, [snapshot, clearTimer, write]);

  const run = useCallback(
    (itemId: string, verb: ActionVerb, watch: Watch, request: () => Promise<unknown>, optionLabel?: string) => {
      const current = pendingRef.current[itemId];
      if (current && current.phase !== 'failed') return;
      write(itemId, { verb, phase: 'sending', optionLabel });
      watches.current.set(itemId, watch);
      request().then(
        () => {
          if (!mounted.current) return;
          const p = pendingRef.current[itemId];
          if (p?.phase !== 'sending') return;
          write(itemId, { ...p, phase: 'sent' });
          setTimer(itemId, CONFIRM_TIMEOUT_MS, () => {
            if (pendingRef.current[itemId]?.phase === 'sent') confirm(itemId);
            reloadRef.current();
          });
        },
        (error: unknown) => {
          if (!mounted.current) return;
          watches.current.delete(itemId);
          // The log already shows it happened (the event beat the response): the log wins.
          if (pendingRef.current[itemId]?.phase === 'confirmed') return;
          write(itemId, { verb, phase: 'failed', error, optionLabel });
        },
      );
    },
    [confirm, reloadRef, setTimer, write],
  );

  const resolveWith = useCallback(
    (verb: 'approve' | 'deny', itemId: string, decisionId: string, option: OptionRef, comment: string) =>
      run(
        itemId,
        verb,
        { types: DECISION_CLOSED, key: 'decisionId', id: decisionId },
        () =>
          apiPost(`/api/decisions/${enc(decisionId)}/resolve`, {
            optionId: option.id,
            comment: comment.trim() ? comment.trim() : null,
          }),
        option.label ?? undefined,
      ),
    [run],
  );

  const approve = useCallback(
    (itemId: string, decisionId: string, option: OptionRef, comment: string) =>
      resolveWith('approve', itemId, decisionId, option, comment),
    [resolveWith],
  );
  const deny = useCallback(
    (itemId: string, decisionId: string, option: OptionRef, comment: string) =>
      resolveWith('deny', itemId, decisionId, option, comment),
    [resolveWith],
  );

  const nudge = useCallback(
    (itemId: string, sessionId: string, text: string) =>
      run(itemId, 'nudge', { types: ['session.nudged'], key: 'sessionId', id: sessionId }, () =>
        apiPost(`/api/sessions/${enc(sessionId)}/nudge`, { text: text.trim() }),
      ),
    [run],
  );

  const restart = useCallback(
    (itemId: string, sessionId: string) =>
      run(itemId, 'restart', { types: ['session.restarted'], key: 'sessionId', id: sessionId }, () =>
        apiPost(`/api/sessions/${enc(sessionId)}/restart`),
      ),
    [run],
  );

  const dismiss = useCallback(
    (itemId: string) => {
      if (pendingRef.current[itemId]?.phase === 'failed') write(itemId, undefined);
    },
    [write],
  );

  return { pending, approve, deny, nudge, restart, dismiss };
}
