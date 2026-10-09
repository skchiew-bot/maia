import type { DecisionSummary } from '@aoc/contracts';
import type { StreamMessage } from '../../api/stream';
import { useResource } from '../../api/useResource';

/** Any decision lifecycle event (requested, resolved, withdrawn, escalated) changes the inbox. */
export function isDecisionEvent(m: StreamMessage): boolean {
  return m.kind === 'aoc' && m.event.type.startsWith('decision.');
}

/**
 * Decisions waiting on the signed-in user, for the top-bar inbox badge, the nav and the tab title on every
 * operator page (R15: waiting decisions must be visible from anywhere, including a background tab). It counts
 * only cards this user can resolve now, so a Builder is not nagged by Approver gates. `null` while unknown.
 */
export function useOpenDecisionCount(): number | null {
  const { data } = useResource<DecisionSummary>('/api/decisions/summary', { refreshOn: isDecisionEvent });
  return data ? data.resolvableByMe : null;
}
