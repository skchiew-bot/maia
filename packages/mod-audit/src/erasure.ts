import {
  newId,
  type Actor,
  type ErasureReason,
  type ErasureRequestDTO,
  type ErasureRequestInput,
  type User,
} from '@aoc/contracts';
import { HttpError, type ModuleContext } from '@aoc/kernel';

export const APPROVE_ERASURE = 'approve';
export const REJECT_ERASURE = 'reject';

const REASON_WORDS: Record<ErasureReason, string> = {
  pdpa_request: 'a PDPA request from the data subject',
  secret_leak: 'a secret leaked into a body',
  retention: 'the retention period ended',
  other: 'another reason (see below)',
};

interface RequestRow {
  request_id: string;
  decision_id: string;
  reason: ErasureReason;
  requester_id: string;
}

function eventsIn(ctx: ModuleContext, scopeId: string): number {
  return (ctx.db.prepare('SELECT COUNT(*) AS n FROM events WHERE body_scope = ?').get(scopeId) as { n: number }).n;
}

/**
 * Asks for named scopes to be crypto-shredded (O-28): an `erasure_request` decision card for the Approver, which the
 * requester can never resolve, and an `erasure.requested` event that fixes which scopes and why.
 */
export function requestErasure(ctx: ModuleContext, user: User, input: ErasureRequestInput): ErasureRequestDTO {
  const decisions = ctx.services.maybe('decisions');
  if (!decisions) throw new HttpError(503, 'decisions_unavailable', 'The decision service is not available');
  const requestId = newId('erasureRequest', ctx.clock.now());
  const eventsInScope = Object.fromEntries(input.scopeIds.map((s) => [s, eventsIn(ctx, s)]));
  const actor: Actor = { kind: 'human', id: user.id };
  const card = decisions.request(
    {
      kind: 'erasure_request',
      title: 'Erasure request',
      question: `Approve crypto-shredding ${input.scopeIds.length === 1 ? 'one body scope' : `${input.scopeIds.length} body scopes`} for ${REASON_WORDS[input.reason]}? It cannot be undone.`,
      options: [
        { id: APPROVE_ERASURE, label: 'Approve erasure', description: 'An Approver may then erase exactly these scopes, once each' },
        { id: REJECT_ERASURE, label: 'Reject' },
      ],
      context: [
        `Requested by ${user.name}.`,
        `Scopes (events in each now): ${input.scopeIds.map((s) => `${s} (${eventsInScope[s]})`).join(', ')}.`,
        `Rationale: ${input.rationale}`,
      ].join('\n'),
      subjectType: 'erasure_request',
      subjectId: requestId,
      // The card quotes the rationale: same scope as the request's event.
      bodyScope: requestId,
      // Separation of duties (§6): whoever asks never approves, escalated or not.
      requesterId: user.id,
      excludedApproverIds: [user.id],
      requiredRole: 'approver',
    },
    actor,
  );
  const e = ctx.store.append({
    type: 'erasure.requested',
    actor,
    meta: { requestId, decisionId: card.id, scopeIds: input.scopeIds, reason: input.reason },
    payload: { rationale: input.rationale },
    source: 'api',
    // The rationale may name the data subject: its own scope, so the request can itself be erased.
    bodyScope: requestId,
  });
  return {
    requestId,
    decisionId: card.id,
    scopeIds: input.scopeIds,
    reason: input.reason,
    requesterId: user.id,
    createdAt: e.ts,
    eventsInScope,
  };
}

/**
 * The checks an erasure must pass (O-28): the decision is an approved erasure request that lists the scope, the
 * reason (when given) is the request's, the eraser is not the requester, and the scope was not erased under this
 * request before, so an old approval cannot shred what was written to the scope since. Returns the request's reason.
 */
export function authoriseErasure(
  ctx: ModuleContext,
  user: User,
  input: { scopeId: string; decisionId: string; reason?: ErasureReason },
): ErasureReason {
  const card = ctx.services.maybe('decisions')?.get(input.decisionId) ?? null;
  if (!card) throw new HttpError(422, 'unknown_decision', 'decisionId does not reference a known decision');
  const request = ctx.db
    .prepare('SELECT request_id, decision_id, reason, requester_id FROM aud_erasure_requests WHERE decision_id = ?')
    .get(input.decisionId) as RequestRow | undefined;
  if (card.kind !== 'erasure_request' || !request)
    throw new HttpError(422, 'not_an_erasure_request', 'The decision is not an erasure request');
  if (card.status !== 'resolved' || card.resolution?.optionId !== APPROVE_ERASURE)
    throw new HttpError(409, 'erasure_not_approved', 'The erasure request is not approved');
  const listed = ctx.db
    .prepare('SELECT 1 FROM aud_erasure_request_scopes WHERE request_id = ? AND scope_id = ?')
    .get(request.request_id, input.scopeId);
  if (!listed) throw new HttpError(409, 'scope_not_approved', 'The approved request does not name this scope');
  if (input.reason && input.reason !== request.reason)
    throw new HttpError(409, 'reason_mismatch', `The request was approved for ${request.reason}`);
  if (request.requester_id === user.id)
    throw new HttpError(403, 'requester_cannot_erase', 'Whoever requested an erasure does not carry it out');
  const done = ctx.db
    .prepare('SELECT event_seq FROM aud_erasures WHERE decision_id = ? AND scope_id = ?')
    .get(input.decisionId, input.scopeId) as { event_seq: number } | undefined;
  if (done)
    throw new HttpError(409, 'already_erased', 'This scope was already erased under this request; raise a new one', {
      eventSeq: done.event_seq,
    });
  return request.reason;
}
