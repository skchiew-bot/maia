import type { ProcessType, SessionInfo } from '@aoc/contracts';

/** At most this many source ids travel with a proposal (event meta and card). */
export const MAX_PROVENANCE_IDS = 20;

/**
 * T-15 / O-17: a session that read untrusted input, so whatever it wrote may carry injected instructions. Read-only
 * sessions and triage process types are the ones that read requester text (intake tickets) and raw repository
 * content for diagnosis. Build sessions on a ticket work from the human-approved fix plan, not the ticket text.
 */
export function readsUntrustedInput(session: SessionInfo | null, type: ProcessType | null): boolean {
  return session?.readOnly === true || type?.readOnly === true || type?.class === 'triage';
}

/** Distinct ids, newest last, at most `MAX_PROVENANCE_IDS` (the most recent ones). */
export function provenanceIds(ids: readonly (string | null | undefined)[]): string[] {
  const seen = [...new Set(ids.filter((v): v is string => !!v))];
  return seen.slice(-MAX_PROVENANCE_IDS);
}

/** One line for a card: the ids, shortened when there are many. */
export function idList(ids: readonly string[], total = ids.length): string {
  if (!ids.length) return 'none';
  const shown = ids.slice(0, 10).join(', ');
  return total > 10 ? `${shown} and ${total - 10} more` : shown;
}
