/** Read models / DTOs for mod-change: change records, rollback, break-glass, promotion, provenance, governance (§8, §14). */
import type { ChangeScope } from '../domain';

export const CHANGE_FIELDS = ['impact', 'mitigation', 'rollbackPlan', 'acceptanceTest'] as const;
export type ChangeField = (typeof CHANGE_FIELDS)[number];
export const CHANGE_FIELD_LABEL: Record<ChangeField, string> = {
  impact: 'Impact analysis',
  mitigation: 'Mitigation plan',
  rollbackPlan: 'Rollback plan',
  acceptanceTest: 'Acceptance test',
};

/** Affirmed without any edit after less than this dwell → flagged as a blind one-click confirm (§14). */
export const BLIND_AFFIRM_DWELL_MS = 3000;

export const CHANGE_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'in_progress',
  'completed',
] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export interface ChangeFieldDTO {
  field: ChangeField;
  /** What the AI drafted (null when the body was crypto-shredded). */
  draft: string | null;
  /** Current value: the draft until the developer edits or affirms it. */
  value: string | null;
  affirmed: boolean;
  edited: boolean | null;
  /** Normalised edit distance between the AI draft and the affirmed value (0 = untouched, 1 = rewritten). */
  editRatio: number | null;
  dwellMs: number | null;
  /** Blind one-click confirm (affirmed without edit, dwell below BLIND_AFFIRM_DWELL_MS). */
  blind: boolean;
  affirmedBy: string | null;
  affirmedAt: string | null;
}

export interface ChangeRequestDTO {
  changeId: string;
  projectId: string;
  scope: ChangeScope;
  status: ChangeStatus;
  title: string | null;
  draftedBy: 'ai' | 'human';
  createdBy: string;
  /** Person accountable for the record (the drafter, or the break-glass invoker for post-incident records). */
  ownerId: string | null;
  createdAt: string;
  sessionId: string | null;
  breakglassId: string | null;
  /** Post-incident records only: completion deadline (24h after the break-glass approval). */
  dueAt: string | null;
  overdue: boolean;
  fields: ChangeFieldDTO[];
  affirmedCount: number;
  /** Exact tag or commit the rollback plan returns to, and the SHA it resolved to at submission. */
  rollbackRef: string | null;
  rollbackSha: string | null;
  submittedBy: string | null;
  submittedAt: string | null;
  selfApprovable: boolean | null;
  decisionId: string | null;
  approval: { approverId: string; selfApproved: boolean; at: string } | null;
  rejection: { approverId: string; at: string; comment: string | null } | null;
  sessions: { sessionId: string; startedAt: string; inheritedFrom: string | null }[];
  completedAt: string | null;
  pinnedSha: string | null;
  pinnedTag: string | null;
  /** Free text was crypto-shredded (render "[erased]"). */
  erased: boolean;
}

export const ROLLBACK_STATUSES = [
  'requested',
  'verifying',
  'awaiting_approval',
  'not_clean',
  'approved',
  'rejected',
  'executed',
  'failed',
] as const;
export type RollbackStatus = (typeof ROLLBACK_STATUSES)[number];

export interface RollbackDTO {
  rollbackId: string;
  projectId: string;
  targetRef: string;
  targetSha: string;
  changeId: string | null;
  reason: string | null;
  status: RollbackStatus;
  requestedBy: string;
  requestedAt: string;
  /** The supervisor's report from the verification branch; a decision is raised only when clean. */
  verification: {
    branch: string;
    testsPassed: number;
    testsFailed: number;
    clean: boolean;
    report: string | null;
    at: string;
  } | null;
  decisionId: string | null;
  approval: { approverId: string; passkeyVerified: boolean; at: string } | null;
  rejection: { approverId: string; at: string; comment: string | null } | null;
  execution: { mainShaBefore: string; mainShaAfter: string; at: string } | null;
  failure: { reason: string; detail: string | null; at: string } | null;
  erased: boolean;
}

export const PROMOTION_STATUSES = ['requested', 'completed', 'refused', 'rejected', 'failed'] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];
export type PromotionRefusalReason =
  | 'provenance_gap'
  | 'uat_missing'
  | 'gate_missing'
  | 'tests_failed'
  | 'not_fast_forward'
  | 'self_modification';

export interface PromotionDTO {
  promotionId: string;
  projectId: string;
  fromRef: string | null;
  fromSha: string | null;
  targetBranch: string | null;
  ticketId: string | null;
  changeId: string | null;
  breakglassId: string | null;
  /** True for the break-glass exception (provenance bypassed). */
  breakglass: boolean;
  status: PromotionStatus;
  requestedBy: string;
  requestedAt: string;
  decisionId: string | null;
  refusal: { reason: PromotionRefusalReason; orphanShas: string[]; at: string } | null;
  rejection: { approverId: string; at: string; comment: string | null } | null;
  failure: { reason: string; detail: string | null; at: string } | null;
  completion: { mainShaBefore: string; mainShaAfter: string; approverId: string | null; at: string } | null;
}

export const BREAKGLASS_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type BreakglassStatus = (typeof BREAKGLASS_STATUSES)[number];

export interface BreakglassDTO {
  breakglassId: string;
  projectId: string;
  ref: string;
  sha: string;
  invokedBy: string;
  invokedAt: string;
  justification: string | null;
  decisionId: string;
  status: BreakglassStatus;
  approval: { approverId: string; passkeyVerified: boolean; at: string } | null;
  rejection: { approverId: string; at: string; comment: string | null } | null;
  /** Mandatory post-incident change record, auto-raised on approval. */
  postIncidentChangeId: string | null;
  postIncidentStatus: ChangeStatus | null;
  dueAt: string | null;
  overdue: boolean;
  overdueFlaggedAt: string | null;
  promotion: PromotionDTO | null;
  erased: boolean;
}

export interface ProvenanceCommitDTO {
  sha: string;
  subject: string;
  traced: boolean;
  /**
   * How the commit traces to a gate, always through its AOC-Session (trailers alone are self-asserted): `change` = its
   * AOC-Change trailer names an approved change that session is linked to; `session_change` = the session is linked to
   * an approved change; `session_ticket` = the session works a ticket with an approved fix plan. Each also requires
   * the commit to be reachable from a HEAD the ledger recorded for that session.
   */
  via: 'change' | 'session_change' | 'session_ticket' | null;
  changeIds: string[];
  sessionIds: string[];
  ticketIds: string[];
  reason: string | null;
}

export interface ProvenanceDTO {
  projectId: string;
  sha: string;
  /** The default branch the range `<base>..<sha>` was computed against. */
  baseRef: string | null;
  ok: boolean;
  commits: ProvenanceCommitDTO[];
  orphanShas: string[];
  reasons: string[];
}

export interface AffirmRateRowDTO {
  userId: string;
  name: string | null;
  affirmations: number;
  affirmedWithoutEdit: number;
  /** affirmedWithoutEdit / affirmations (0..1). */
  affirmWithoutEditRate: number;
  /** Blind one-click confirms (affirmed without edit, dwell below the threshold). */
  flagged: number;
  meanEditRatio: number;
}

export interface AffirmRateDTO {
  /** Portfolio governance lens, never a ranking (§14): rows are ordered by name, not by rate. */
  rows: AffirmRateRowDTO[];
  totals: Omit<AffirmRateRowDTO, 'userId' | 'name'>;
  blindDwellMs: number;
}
