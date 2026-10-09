import { useCallback, useState } from 'react';
import type { DecisionCardView, PasskeyDto } from '@aoc/contracts';
import { apiPost } from '../../api/client';
import { useResource } from '../../api/useResource';
import { useToast } from '../../components/Toast';
import { assuranceLabel, outcomeLabel } from './model';
import { describePasskeyError, registerPasskey, resolveWithPasskey, type PasskeyProblem } from './passkey';

export interface PasskeyState {
  /** Whether the signed-in user has a registered passkey; null while unknown or not needed. */
  hasPasskey: boolean | null;
  reload: () => void;
}

/** The viewer's own passkeys (`GET /api/passkeys`), loaded only when a passkey-gated card could need them. */
export function usePasskeys(enabled: boolean): PasskeyState {
  const r = useResource<{ passkeys: PasskeyDto[] }>(enabled ? '/api/passkeys' : null, {
    refreshOn: (m) => m.kind === 'aoc' && m.event.type.startsWith('passkey.'),
  });
  return { hasPasskey: r.data ? r.data.passkeys.length > 0 : null, reload: r.reload };
}

export type BusyAction =
  { kind: 'resolve'; optionId: string } | { kind: 'register' } | { kind: 'withdraw' } | { kind: 'escalate' };

export interface DecisionActions {
  busy: BusyAction | null;
  problem: PasskeyProblem | null;
  /** Card hash the last passkey signature committed to. */
  signedHash: string | null;
  resolve(card: DecisionCardView, optionId: string, comment: string | null): Promise<DecisionCardView | null>;
  register(): Promise<boolean>;
  withdraw(card: DecisionCardView, reason: string, note: string | null): Promise<DecisionCardView | null>;
  escalate(card: DecisionCardView): Promise<DecisionCardView | null>;
  clearProblem(): void;
}

const path = (card: DecisionCardView, action: string) =>
  `/api/decisions/${encodeURIComponent(card.id)}/${action}`;

/**
 * Resolve (button or passkey), register a passkey, withdraw or escalate. Errors become a plain-language problem
 * for the caller to show; success is announced and handed back so the caller can move selection on.
 */
export function useDecisionActions(
  onChanged?: (card: DecisionCardView) => void,
  passkeys?: PasskeyState,
): DecisionActions {
  const toast = useToast();
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [problem, setProblem] = useState<PasskeyProblem | null>(null);
  const [signedHash, setSignedHash] = useState<string | null>(null);

  const run = useCallback(async <T>(action: BusyAction, work: () => Promise<T>): Promise<T | null> => {
    setBusy(action);
    setProblem(null);
    try {
      return await work();
    } catch (err) {
      setProblem(describePasskeyError(err));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  const resolve = useCallback(
    (card: DecisionCardView, optionId: string, comment: string | null) =>
      run({ kind: 'resolve', optionId }, async () => {
        let updated: DecisionCardView;
        if (card.requiresPasskey) {
          const signed = await resolveWithPasskey(card.id, optionId, comment);
          updated = signed.card;
          setSignedHash(signed.cardHash);
        } else {
          updated = await apiPost<DecisionCardView>(path(card, 'resolve'), { optionId, comment });
        }
        toast.notify({
          tone: 'ok',
          title: `Decided: ${outcomeLabel(updated)}`,
          body: `${updated.title}${updated.resolution ? ` · ${assuranceLabel(updated.resolution)}` : ''}`,
        });
        onChanged?.(updated);
        return updated;
      }),
    [run, toast, onChanged],
  );

  const register = useCallback(async () => {
    const ok = await run({ kind: 'register' }, async () => {
      await registerPasskey('AOC console');
      toast.notify({
        tone: 'ok',
        title: 'Passkey registered',
        body: 'You can now sign go-live, rollback and break-glass decisions.',
      });
      return true;
    });
    passkeys?.reload();
    return ok === true;
  }, [run, toast, passkeys]);

  const withdraw = useCallback(
    (card: DecisionCardView, reason: string, note: string | null) =>
      run({ kind: 'withdraw' }, async () => {
        const updated = await apiPost<DecisionCardView>(path(card, 'withdraw'), {
          reason,
          ...(note ? { note } : {}),
        });
        toast.notify({ tone: 'info', title: 'Decision withdrawn', body: updated.title });
        onChanged?.(updated);
        return updated;
      }),
    [run, toast, onChanged],
  );

  const escalate = useCallback(
    (card: DecisionCardView) =>
      run({ kind: 'escalate' }, async () => {
        const updated = await apiPost<DecisionCardView>(path(card, 'escalate'), { reason: 'manual' });
        toast.notify({ tone: 'info', title: 'Escalated to the Approver', body: updated.title });
        onChanged?.(updated);
        return updated;
      }),
    [run, toast, onChanged],
  );

  return {
    busy,
    problem,
    signedHash,
    resolve,
    register,
    withdraw,
    escalate,
    clearProblem: () => setProblem(null),
  };
}
