/**
 * Open-decision count shown in the top-bar inbox badge, the nav and the tab title on every operator page
 * (R15: waiting decisions must be visible from anywhere, including a background tab).
 *
 * Owned by the Decisions area. Until the decisions DTO exists this reports `null` (unknown → no badge).
 * Implement it with `useResource` + `refreshOn` decision events, e.g.
 * `useResource<{ open: number }>(path, { refreshOn: (m) => m.kind === 'aoc' && m.event.type.startsWith('decision.') })`.
 */
export function useOpenDecisionCount(): number | null {
  return null;
}
