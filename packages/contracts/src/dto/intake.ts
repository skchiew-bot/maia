/** Intake read models (owner: mod-intake). */
import type { AocConfig } from '../config';
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

/**
 * `GET /portal/api/limits` — what an intake accepts, so the portal can check text and files before uploading.
 * The server still enforces every rule: content is identified by its magic bytes, never by name or declared type.
 */
export interface IntakeLimits {
  maxAttachments: number;
  /** Per-file cap by detected kind (documents share the image cap). */
  maxBytes: { image: number; video: number; document: number };
  /** Combined size of all files in one request. */
  maxTotalBytes: number;
  titleLength: { min: number; max: number };
  descriptionLength: { min: number; max: number };
  /** Declared types that match an accepted signature, with their usual file extensions. */
  accepted: { mime: string; kind: 'image' | 'video' | 'document'; extensions: string[] }[];
}

/** Form fields and multipart framing that ride along with the files of one intake request. */
export const INTAKE_ENVELOPE_BYTES = 1024 * 1024;

/**
 * Combined size of all files one intake request may carry: one maximum-size video. The single source of truth for
 * what `GET /portal/api/limits` publishes as `maxTotalBytes` and for every request-body cap on the upload route (the
 * kernel's and aocd's), so the number the portal shows is the number the server enforces.
 */
export function intakeTotalBytes(intake: Pick<AocConfig['intake'], 'maxVideoBytes'>): number {
  return intake.maxVideoBytes;
}

/** Largest request body the intake upload accepts: the total allowance plus the form envelope. */
export function intakeRequestBytes(intake: Pick<AocConfig['intake'], 'maxVideoBytes'>): number {
  return intakeTotalBytes(intake) + INTAKE_ENVELOPE_BYTES;
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
