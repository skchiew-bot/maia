/** Read models / DTOs for mod-decisions (owner: mod-decisions). Every card carries its age (§12, R15). */
import type { DecisionCard, DecisionResolveInput } from '../decisions';
import type { DecisionKind, Role } from '../domain';

export const DECISION_KIND_LABEL: Record<DecisionKind, string> = {
  agent_decision: 'Agent decision',
  protected_operation: 'Protected operation',
  fix_plan: 'Fix-plan sign-off',
  go_live: 'Go-live',
  rollback: 'Rollback',
  change_request: 'Change request',
  break_glass: 'Break-glass promotion',
  playbook_approval: 'Playbook approval',
  lesson_binding: 'Lesson binding',
  credit_topup: 'Credit top-up',
  fx_discrepancy: 'FX discrepancy',
  triage_reconciliation: 'Triage reconciliation',
  low_confidence_diagnosis: 'Low-confidence diagnosis',
  uat_signoff: 'UAT sign-off',
};

/**
 * Machine reasons a user cannot resolve a card (`canResolve`, viewer flags) or a resolve attempt was refused.
 * The passkey reasons only come from a resolve attempt: an eligible viewer of a passkey card still sees
 * `canResolve: true` and the UI prompts for the passkey because `requiresPasskey` is set.
 */
export type DecisionBlockReason =
  | 'not_open'
  | 'inactive'
  | 'not_eligible'
  | 'separation_of_duties'
  | 'role'
  | 'passkey_required'
  | 'passkey_invalid';

export interface DecisionViewer {
  canResolve: boolean;
  reason: DecisionBlockReason | null;
  /** Approver, or the person the decision was raised for, while it is open. */
  canWithdraw: boolean;
  /** Open Builder-level card: may be raised to the Approver (never routed back to the requester). */
  canEscalate: boolean;
}

/** Card as served by `/api/decisions*`: DecisionCard plus age, closure details and the viewer's options. */
export interface DecisionCardView extends DecisionCard {
  /** Open: time waiting so far. Closed: how long it waited before it closed. */
  ageMs: number;
  /** Open and past `dueAt`. */
  overdue: boolean;
  closedAt: string | null;
  /** Free text was crypto-shredded: title, question, context, labels and comments read "[erased]". */
  erased: boolean;
  escalation: { toRole: Role; reason: string; at: string } | null;
  withdrawal: { reason: string; by: string; at: string; note: string | null } | null;
  viewer: DecisionViewer;
}

/** `GET /api/decisions` query. Lists are comma-separated; empty values are ignored. */
export interface DecisionListQuery {
  /** e.g. `open` or `resolved,withdrawn,expired`. Default: every status. */
  status?: string;
  kind?: string;
  sessionId?: string;
  projectId?: string;
  subjectId?: string;
  /** `1` → only cards the viewer can resolve now. */
  mine?: '1' | '0' | 'true' | 'false';
  /** Default 200, max 500. */
  limit?: number;
}

export interface DecisionListResponse {
  generatedAt: string;
  /** Open cards first, oldest first; then closed cards, most recently closed first. */
  decisions: DecisionCardView[];
}

/** `GET /api/decisions/summary` — drives the tab badge and in-page reminders (R15). */
export interface DecisionSummary {
  generatedAt: string;
  open: number;
  resolvableByMe: number;
  oldestOpenAt: string | null;
  oldestResolvableByMeAt: string | null;
  /** Open cards per kind (kinds with none are omitted). */
  byKind: Partial<Record<DecisionKind, number>>;
}

/** `POST /api/decisions/:id/resolve`. */
export type DecisionResolveBody = DecisionResolveInput;

/** `POST /api/decisions/:id/withdraw` — `reason` is a machine label (`expired` closes the card as expired). */
export interface DecisionWithdrawBody {
  reason?: string;
  note?: string;
}

/** `POST /api/decisions/:id/escalate` — raises a Builder-level card to the Approver. */
export interface DecisionEscalateBody {
  reason?: string;
}

/** Opt-in webhook body (R15). Ids, enums and ages only — never titles, questions, options or comments (PDPA). */
export interface DecisionWebhookPayload {
  type: 'decision.new' | 'decision.aging';
  decisionId: string;
  kind: DecisionKind;
  requiredRole: Role;
  requiresPasskey: boolean;
  sessionId: string | null;
  projectId: string | null;
  createdAt: string;
  ageMs: number;
  /** Elapsed multiples of `remindAfterMinutes` for aging reminders; 0 for a new decision. */
  reminder: number;
  link: string;
  sentAt: string;
}
