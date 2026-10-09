/** Shared domain enumerations (lead-owned). */

/** Liveness states in PRECEDENCE order (§4): Waiting on you > Throttled > Dead > Stalled > Thinking > Working. */
export const LIVENESS_STATES = ['waiting_on_you', 'throttled', 'dead', 'stalled', 'thinking', 'working'] as const;
export type LivenessState = (typeof LIVENESS_STATES)[number];
export const LIVENESS_LABEL: Record<LivenessState, string> = {
  waiting_on_you: 'Waiting on you',
  throttled: 'Throttled',
  dead: 'Dead',
  stalled: 'Stalled',
  thinking: 'Thinking',
  working: 'Working',
};

/** Session lifecycle (independent of liveness; liveness is derived from lifecycle + signals). */
export const SESSION_LIFECYCLE = [
  'launching', // launch requested, process starting
  'running', // a turn is in progress (process alive)
  'idle', // turn ended without decision while plan incomplete → needs operator
  'waiting_decision', // open human-required decision
  'blocked', // credit cap / writer lock / no manifest → waiting on a human action
  'throttled', // plan limit hit; resumes at reset
  'ended', // completed normally
  'failed', // crashed / killed unexpectedly
  'retired', // rolled over into a successor session
] as const;
export type SessionLifecycle = (typeof SESSION_LIFECYCLE)[number];

export const SESSION_MODES = ['managed', 'observed'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const MODEL_TIERS = ['opus', 'sonnet', 'haiku', 'fable'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];
export const MODEL_ID_BY_TIER: Record<ModelTier, string> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
};
export function modelTierOf(model: string): ModelTier | 'unknown' {
  const m = model.toLowerCase();
  for (const t of MODEL_TIERS) if (m.includes(t)) return t;
  return 'unknown';
}

/** discovery = novel work on the strongest model (credits never downgrade it); execution = follows an approved playbook. */
export const PROCESS_CLASSES = ['discovery', 'execution', 'triage', 'maintenance'] as const;
export type ProcessClass = (typeof PROCESS_CLASSES)[number];

export const ROLES = ['approver', 'builder', 'requester'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = { approver: 'Approver', builder: 'Builder', requester: 'Requester' };

export const DECISION_KINDS = [
  'agent_decision', // raised by an agent via request_decision (test 1–5)
  'protected_operation', // a hook turned a blocked attempt (push to main, deploy, data op) into a card
  'fix_plan', // intake: fix-plan sign-off gate
  'go_live', // promotion to main / production (passkey)
  'rollback', // gated rollback after verification (passkey)
  'change_request', // post-MVP change record approval
  'break_glass', // emergency promotion (passkey) — most audited event
  'playbook_approval',
  'lesson_binding',
  'credit_topup',
  'fx_discrepancy',
  'triage_reconciliation', // parallel triage agents disagree (R17)
  'low_confidence_diagnosis', // bounce low-confidence root cause to a human
  'uat_signoff', // requester tests on UAT
] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export const DECISION_STATUSES = ['open', 'resolved', 'withdrawn', 'expired'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** Change scope drives who may approve: Builders self-approve reversible off-main work; main/production/data bounce to the Approver (§6). */
export const CHANGE_SCOPES = ['reversible_off_main', 'main', 'production', 'data'] as const;
export type ChangeScope = (typeof CHANGE_SCOPES)[number];

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** What the requester sees (§7): never gate names, approver identity, queue depth or an implied timeline. */
export const PUBLIC_TICKET_STATUSES = [
  'received',
  'being_worked_on',
  'ready_for_testing',
  'completed',
  'closed',
] as const;
export type PublicTicketStatus = (typeof PUBLIC_TICKET_STATUSES)[number];
export const PUBLIC_TICKET_STATUS_LABEL: Record<PublicTicketStatus, string> = {
  received: 'Received',
  being_worked_on: 'Being worked on',
  ready_for_testing: 'Ready for your testing',
  completed: 'Completed',
  closed: 'Closed',
};

export const ROOT_CAUSE_DIMENSIONS = [
  'spec',
  'context',
  'tooling',
  'codebase',
  'guardrail',
  'model_capability',
  'environment',
  'unknown',
] as const;
export type RootCauseDimension = (typeof ROOT_CAUSE_DIMENSIONS)[number];

export const OFFENCE_STATES = ['detected', 'root_caused', 'fix_applied', 'verified_closed', 'reopened'] as const;
export type OffenceState = (typeof OFFENCE_STATES)[number];

export const ID_PREFIX = {
  user: 'usr',
  token: 'tok',
  project: 'prj',
  thread: 'thr',
  session: 'ses',
  decision: 'dec',
  change: 'chg',
  rollback: 'rbk',
  breakglass: 'brk',
  promotion: 'prm',
  ticket: 'tkt',
  attachment: 'att',
  error: 'err',
  offence: 'off',
  lesson: 'les',
  rootCauseClass: 'rcc',
  playbook: 'pbk',
  anchor: 'anc',
  backup: 'bkp',
  evidencePack: 'evp',
  topup: 'tpu',
  event: 'evt',
} as const;
export type IdKind = keyof typeof ID_PREFIX;
