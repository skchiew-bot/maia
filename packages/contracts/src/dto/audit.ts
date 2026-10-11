/** Read models / DTOs for mod-audit (§13: anchors, verify-against-anchor, erasure, audit trail). */
import { z } from 'zod';
import { ERASURE_REASONS, MAX_ERASURE_SCOPES, zScopeId, type ErasureReason } from '../events/audit';
import { zId } from '../events/define';
import type { Actor, EventSource, JsonObject, JsonValue, Scope } from '../envelope';

export type AnchorProviderName = 'git' | 'rfc3161';

/** Header-only audit row (`GET /api/audit/events`). Bodies are never listed. */
export interface AuditEventHeaderDTO {
  seq: number;
  id: string;
  ts: string;
  type: string;
  actor: Actor;
  scope: Scope;
  meta: JsonObject;
  source: EventSource;
  hasBody: boolean;
  /** First 16 hex chars of the blinded payload hash (null for header-only events). */
  payloadHashPrefix: string | null;
  hash: string;
  prevHash: string;
}

export interface AuditEventPageDTO {
  events: AuditEventHeaderDTO[];
  headSeq: number;
  /** Ascending order: pass as `fromSeq` for the next page (null = end). */
  nextFromSeq: number | null;
  /** Descending order: pass as `toSeq` for the next page (null = end). */
  nextToSeq: number | null;
}

export type AuditBodyState = 'none' | 'present' | 'erased' | 'missing';

/** `GET /api/audit/events/:seq`. The payload is shown only to approvers (and ticket bodies only with ticket.media_view). */
export interface AuditEventDetailDTO extends AuditEventHeaderDTO {
  bodyScope: string | null;
  sourceTs: string | null;
  causationId: string | null;
  body: AuditBodyState;
  erased: boolean;
  /** Body re-hashed against the chained blinded hash (null when there is no readable body). */
  bodyVerified: boolean | null;
  payloadVisible: boolean;
  payloadWithheldReason: 'not_approver' | 'ticket_media' | null;
  payload: JsonValue | null;
}

export interface AnchorDTO {
  anchorId: string;
  provider: AnchorProviderName;
  seq: number;
  hash: string;
  proofRef: string;
  anchoredAt: string;
  /** seq of the anchor.created event itself. */
  eventSeq: number;
  signed: boolean | null;
  pushed: boolean | null;
}

export interface AnchorListDTO {
  anchors: AnchorDTO[];
  provider: AnchorProviderName | 'none';
  /** git provider with a remote, or RFC 3161 (third-party signed). */
  offHost: boolean;
  headSeq: number;
}

/** One anchor checked by verify: the recomputed chain hash at `seq` against the off-host record, plus its external proof. */
export interface AnchorCheckDTO {
  anchorId: string | null;
  provider: AnchorProviderName;
  seq: number;
  /** The off-host record's hash when it was found, otherwise the chain's own anchor.created hash. */
  anchoredHash: string;
  /** Hash recorded by the chain's anchor.created event (null when the chain holds no event for this anchor). */
  chainHash: string | null;
  /** The off-host record: found, missing from a readable anchor store, or the store could not be read. */
  record: 'found' | 'missing' | 'store_unavailable';
  recomputedHash: string | null;
  matched: boolean;
  proofOk: boolean;
  anchoredAt: string | null;
  proofRef: string | null;
  /** git: commit signature status (null = not applicable). */
  signed: boolean | null;
  /** git with a remote: anchor commit present on the fetched remote branch (null = not checked). */
  offHost: boolean | null;
  problems: string[];
}

export interface VerifyReportDTO {
  ok: boolean;
  /** In-file recomputation only (defeatable on its own — R2). */
  chainOk: boolean;
  /** The in-file recomputation's own first bad seq and findings (also part of firstBadSeq / problems). */
  chainFirstBadSeq: number | null;
  chainProblems: string[];
  chainId: string;
  headSeq: number;
  headHash: string;
  checked: number;
  anchors: AnchorCheckDTO[];
  firstBadSeq: number | null;
  /** Events after the last anchor. */
  unanchoredTail: number;
  lastAnchorSeq: number | null;
  lastAnchorAt: string | null;
  /** git remote fetched and compared (null = no remote configured). */
  remoteChecked: boolean | null;
  /** Failing findings (ok === problems.length === 0). */
  problems: string[];
  /** Non-failing findings (e.g. remote unreachable, anchor not yet pushed). */
  warnings: string[];
  verifiedAt: string;
  /** seq of the chain.verified event recording this run. */
  eventSeq: number | null;
}

export interface AnchorResultDTO {
  ok: true;
  anchor: AnchorDTO;
  /** Set when the anchor was made but could not be pushed off-host. */
  pushError: string | null;
}

export interface EraseResultDTO {
  scopeId: string;
  reason: ErasureReason;
  bodiesErased: number;
  eventsInScope: number;
  eventSeq: number;
  /** The approved erasure request's decision (O-28). */
  decisionId: string;
}

/** `POST /api/audit/erase`: one scope, under an approved erasure request (O-28). */
export const EraseInputSchema = z
  .object({
    scopeId: zScopeId,
    /** The approved `erasure_request` decision that lists this scope. */
    decisionId: zId,
    /** Optional: when given, it must be the request's reason. */
    reason: z.enum(ERASURE_REASONS).optional(),
  })
  .strict();
export type EraseInput = z.infer<typeof EraseInputSchema>;

/** `POST /api/audit/erasure-requests`: ask the Approver to approve crypto-shredding these scopes (O-28). */
export const ErasureRequestInputSchema = z
  .object({
    scopeIds: z
      .array(zScopeId)
      .min(1)
      .max(MAX_ERASURE_SCOPES)
      .refine((ids) => new Set(ids).size === ids.length, 'each scope once'),
    reason: z.enum(ERASURE_REASONS),
    /** Why, and the impact assessed (key custody §6). Shown to the Approver on the card. */
    rationale: z.string().trim().min(1).max(4000),
  })
  .strict();
export type ErasureRequestInput = z.infer<typeof ErasureRequestInputSchema>;

export interface ErasureRequestDTO {
  requestId: string;
  decisionId: string;
  scopeIds: string[];
  reason: ErasureReason;
  requesterId: string;
  createdAt: string;
  /** Events in each scope when the request was made: what an approval would shred. */
  eventsInScope: Record<string, number>;
}

/** One `backup.completed` (G-21). The backup directory itself is configuration and is not exposed. */
export interface BackupDTO {
  backupId: string;
  /** When the backup was recorded. */
  at: string;
  file: string;
  /** Size and SHA-256 of the encrypted file (check an off-host copy without the key). */
  bytes: number;
  sha256: string;
  /** Fingerprint of the backup key that decrypts it. */
  keyId: string;
  headSeq: number;
  headHash: string;
  /** Off-host copy command result (null = none configured). */
  copied: boolean | null;
  eventSeq: number;
}

/** `GET /api/audit/backups`, newest first. */
export interface BackupListDTO {
  /** audit.backupKeyFile is set: the daily job runs. */
  configured: boolean;
  atLocalTime: string;
  retentionDays: number;
  copyConfigured: boolean;
  backups: BackupDTO[];
}

/** `POST /api/audit/backup`. */
export interface BackupRunDTO {
  ok: true;
  backup: BackupDTO;
  /** Set when the backup was written but the off-host copy command failed. */
  copyError: string | null;
}

export interface AuditHealthDTO {
  generatedAt: string;
  chainId: string;
  headSeq: number;
  provider: AnchorProviderName | 'none';
  offHost: boolean;
  lastAnchor: {
    anchorId: string;
    provider: AnchorProviderName;
    seq: number;
    at: string;
    ageMs: number;
  } | null;
  anchorStale: boolean;
  staleAfterMs: number;
  unanchoredTail: number;
  lastAnchorFailure: { at: string; provider: AnchorProviderName; reason: string } | null;
  lastVerification: { at: string; ok: boolean; firstBadSeq: number | null; eventSeq: number } | null;
  projections: { name: string; status: string; lastError: string | null; failedSeq: number | null }[];
  reactorFailures: { total: number; recent: { reactor: string; seq: number; error: string; at: string }[] };
  jobs: {
    name: string;
    lastRunAt: string | null;
    lastLocalDate: string | null;
    lastStatus: string | null;
    lastError: string | null;
  }[];
  selfmodBlocked: { total: number; last24h: number };
  /** Encrypted backups (G-21, R6). */
  backup: {
    configured: boolean;
    last: (BackupDTO & { ageMs: number }) | null;
    lastFailure: { at: string; stage: string; reason: string } | null;
    /** Configured and none within the stale window (same window as anchors). */
    stale: boolean;
  };
  warnings: string[];
}
