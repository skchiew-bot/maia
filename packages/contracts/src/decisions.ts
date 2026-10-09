/** Decision routing policy (§6, §8, §10, §11): who may resolve which decision, and when a passkey is required. */
import type { ChangeScope, DecisionKind, DecisionStatus, Role } from './domain';
import type { DecisionTest } from './mcp';

/**
 * Tests 1, 2, 5 are enforceable at the tool boundary; 3, 4 are self-reported (§2.4). Builders self-approve only
 * reversible off-main work (§6), so an irreversible choice (3) bounces to the Approver like main/production/data.
 */
export const DECISION_TEST_INFO: Record<DecisionTest, { no: number; label: string; enforcement: 'tool_boundary' | 'self_reported'; bouncesToApprover: boolean }> = {
  main: { no: 1, label: 'Touches main / protected branch', enforcement: 'tool_boundary', bouncesToApprover: true },
  production: { no: 2, label: 'Touches production / deploy', enforcement: 'tool_boundary', bouncesToApprover: true },
  irreversible: { no: 3, label: 'Irreversible or architectural choice', enforcement: 'self_reported', bouncesToApprover: true },
  ambiguity: { no: 4, label: 'Spec ambiguity / low confidence', enforcement: 'self_reported', bouncesToApprover: false },
  data: { no: 5, label: 'Touches data (migrations, deletes, PII)', enforcement: 'tool_boundary', bouncesToApprover: true },
};

export const PASSKEY_KINDS: ReadonlySet<DecisionKind> = new Set<DecisionKind>(['go_live', 'rollback', 'break_glass']);

export interface DecisionRoutingInput {
  kind: DecisionKind;
  test?: DecisionTest | null;
  changeScope?: ChangeScope | null;
}

/** Minimum role that may resolve. Approver can always resolve what a Builder can (except requester-only UAT). */
export function requiredRoleFor(i: DecisionRoutingInput): Role {
  switch (i.kind) {
    case 'agent_decision':
      return i.test && DECISION_TEST_INFO[i.test].bouncesToApprover ? 'approver' : 'builder';
    case 'change_request':
      return i.changeScope === 'reversible_off_main' ? 'builder' : 'approver';
    case 'triage_reconciliation':
    case 'low_confidence_diagnosis':
      return 'builder';
    case 'uat_signoff':
      return 'requester';
    default:
      return 'approver';
  }
}

export function requiresPasskey(kind: DecisionKind): boolean {
  return PASSKEY_KINDS.has(kind);
}

export function roleSatisfies(actual: Role, required: Role): boolean {
  if (required === 'requester') return actual === 'requester';
  if (required === 'builder') return actual === 'builder' || actual === 'approver';
  return actual === 'approver';
}

export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
}

/** Read model / DTO for a decision card (console inbox, session page, API). */
export interface DecisionCard {
  id: string;
  kind: DecisionKind;
  status: DecisionStatus;
  test: DecisionTest | null;
  title: string;
  question: string;
  options: DecisionOption[];
  recommendation: { optionId: string; rationale: string } | null;
  context: string | null;
  requiredRole: Role;
  requiresPasskey: boolean;
  requesterId: string;
  excludedApproverIds: string[];
  eligibleUserIds: string[] | null;
  subjectType: string;
  subjectId: string;
  sessionId: string | null;
  projectId: string | null;
  createdAt: string;
  dueAt: string | null;
  resolution: null | {
    optionId: string;
    resolvedBy: string;
    resolvedAt: string;
    method: 'button' | 'passkey' | 'policy';
    passkeyVerified: boolean;
    selfApproved: boolean;
    comment: string | null;
  };
  /** Filled by the API for the current viewer. */
  viewer?: { canResolve: boolean; reason: string | null };
}

export interface DecisionRequestInput {
  kind: DecisionKind;
  test?: DecisionTest | null;
  changeScope?: ChangeScope | null;
  title: string;
  question: string;
  options: DecisionOption[];
  recommendation?: { optionId: string; rationale: string } | null;
  context?: string | null;
  subjectType: string;
  subjectId: string;
  sessionId?: string | null;
  projectId?: string | null;
  /**
   * Who raised it — excluded from approving it (SoD). Agent-raised cards (request_decision, guard-raised
   * protected operations) use `session:<sessionId>`: the agent is the requester, so its owner may answer
   * Builder-level tests, and an owner approving their own session's gate is recorded as selfApproved.
   */
  requesterId: string;
  excludedApproverIds?: string[];
  eligibleUserIds?: string[] | null;
  dueAt?: string | null;
  /** Override computed role (only to escalate, never to lower). */
  requiredRole?: Role;
}

export interface DecisionResolveInput {
  optionId: string;
  comment?: string | null;
  /** WebAuthn assertion (JSON from @simplewebauthn/browser) when the kind requires a passkey. */
  passkeyAssertion?: unknown;
}
