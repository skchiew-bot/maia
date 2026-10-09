/** Read models / DTOs for mod-audit (§13: anchors, verify-against-anchor, erasure, audit trail). */
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
  anchoredHash: string;
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
  reason: 'pdpa_request' | 'secret_leak' | 'retention' | 'other';
  bodiesErased: number;
  eventsInScope: number;
  eventSeq: number;
  decisionId: string | null;
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
  warnings: string[];
}
