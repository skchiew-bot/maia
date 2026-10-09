import type { DecisionCard, User } from '@aoc/contracts';
import { HttpError } from '@aoc/kernel';

export type SodCard = Pick<DecisionCard, 'kind' | 'requesterId' | 'excludedApproverIds'>;

/**
 * Separation of duties (§6, §10): a request never routes back to its requester, and explicitly excluded
 * users never resolve it. UAT sign-off is the requester testing their own fix, so only explicit
 * exclusions apply to it.
 */
export function separationOfDutiesViolation(
  card: SodCard,
  user: Pick<User, 'id'>,
): 'requester' | 'excluded' | null {
  if (card.kind !== 'uat_signoff' && card.requesterId === user.id) return 'requester';
  if (card.excludedApproverIds.includes(user.id)) return 'excluded';
  return null;
}

/** Throws 403 separation_of_duties when `user` may not resolve `card`. */
export function assertNotRequester(card: SodCard, user: Pick<User, 'id'>): void {
  const violation = separationOfDutiesViolation(card, user);
  if (!violation) return;
  throw new HttpError(
    403,
    'separation_of_duties',
    violation === 'requester'
      ? 'The requester cannot resolve their own request'
      : 'This user is excluded from resolving this decision',
    { violation },
  );
}
