/** Intake read models (owner: mod-intake). */
import type { PublicTicketStatus, Severity } from '../domain';

/** What the requester sees — abstracted status only (§7): never gate names, approver identity, queue depth or timeline. */
export interface PublicTicket {
  ticketId: string;
  title: string;
  description: string;
  comment: string | null;
  severity: Severity;
  status: PublicTicketStatus;
  statusLabel: string;
  submittedAt: string;
  updatedAt: string;
  attachments: { attachmentId: string; fileName: string; mime: string; bytes: number }[];
  /** True only when the requester is asked to test on UAT. */
  canSignOffUat: boolean;
}

export interface TicketDiagnosisDTO {
  sessionId: string;
  status: 'running' | 'reported' | 'stopped';
  confidence: number | null;
  rootCauseClass: string | null;
  rootCause: string | null;
  fixPlan: string | null;
  tokens: number;
  reportedAt: string | null;
}

export type TicketStage =
  | 'received'
  | 'triage'
  | 'awaiting_human'
  | 'fix_plan_gate'
  | 'building'
  | 'uat'
  | 'go_live_gate'
  | 'completed'
  | 'closed';

/** Operator view (builders/approvers). Raw media is never inlined. */
export interface InternalTicket {
  ticketId: string;
  projectId: string | null;
  requesterId: string;
  requesterName: string | null;
  title: string;
  description: string;
  comment: string | null;
  severity: Severity;
  stage: TicketStage;
  publicStatus: PublicTicketStatus;
  submittedAt: string;
  updatedAt: string;
  attachments: { attachmentId: string; fileName: string; mime: string; bytes: number; sha256: string; scan: string }[];
  diagnoses: TicketDiagnosisDTO[];
  buildSessionId: string | null;
  uatRef: string | null;
  openDecisionIds: string[];
  resolution: string | null;
}
