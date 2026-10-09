import type {
  Actor,
  DecisionCard,
  DecisionKind,
  DecisionRequestInput,
  DecisionService,
  MetaOf,
  StoredEvent,
} from '@aoc/contracts';

/**
 * The human-required Approver gate a distilled proposal passes before it binds (§11: one bad lesson or
 * playbook corrupts the fleet).
 */
export interface ApproverGate {
  kind: DecisionKind;
  /** The option that binds the proposal; every other resolution rejects it. */
  approveOptionId: string;
}

export interface ApprovalProposal<R> {
  decisions: DecisionService;
  gate: ApproverGate;
  /** The card; kind and role come from the gate. */
  request: Omit<DecisionRequestInput, 'kind' | 'requiredRole'>;
  /** Who proposes: a person, or the distillation job's system actor. */
  actor: Actor;
  /** Appends the proposal event against the raised card. */
  record: (card: DecisionCard) => R;
  /** Withdraws the card when recording fails. */
  withdrawAs: Actor;
}

/**
 * Raise the gate's decision for the Approver, then record the proposal against it. A failed record
 * withdraws the card, so nobody is asked to approve a proposal that does not exist.
 */
export function proposeForApproval<R>(p: ApprovalProposal<R>): { card: DecisionCard; recorded: R } {
  if (!p.request.options.some((o) => o.id === p.gate.approveOptionId))
    throw new Error(`${p.gate.kind} cards must offer the '${p.gate.approveOptionId}' option`);
  const card = p.decisions.request({ ...p.request, kind: p.gate.kind, requiredRole: 'approver' }, p.actor);
  try {
    return { card, recorded: p.record(card) };
  } catch (err) {
    try {
      p.decisions.withdraw(card.id, 'proposal_failed', p.withdrawAs);
    } catch {
      // The recording failure is the error worth reporting.
    }
    throw err;
  }
}

export type GateVerdict = 'approved' | 'rejected' | 'withdrawn';

/**
 * How a decision event settles a proposal waiting at this gate, or null when it is not this gate's
 * event. Binding needs a person: a policy (machine) resolution, or any non-human actor, never approves,
 * whatever option it picked. decision.withdrawn carries no kind, so callers match it by decision id.
 */
export function gateVerdict(gate: ApproverGate, e: StoredEvent): GateVerdict | null {
  if (e.type === 'decision.withdrawn') return 'withdrawn';
  if (e.type !== 'decision.resolved') return null;
  const m = e.meta as MetaOf<'decision.resolved'>;
  if (m.kind !== gate.kind) return null;
  const byPerson = m.method !== 'policy' && e.actor.kind === 'human';
  return byPerson && m.optionId === gate.approveOptionId ? 'approved' : 'rejected';
}
