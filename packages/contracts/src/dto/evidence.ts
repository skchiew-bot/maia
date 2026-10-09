/**
 * Compliance mapping & evidence pack read models, request schemas and the pack file format
 * (owner: mod-evidence, §13, §14). Packs carry ids, enums, numbers and hashes only — never payloads.
 */
import { z } from 'zod';
import type { ResolutionAssurance } from '../decisions';
import type { Actor, JsonObject, Scope } from '../envelope';

export const ISO42001_STANDARD = 'ISO/IEC 42001:2023';
export const MAPPING_STATUSES = ['provisional', 'stamped'] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];
export type MappingSource = 'config' | 'builtin';

/** Shown until the compliance lead stamps the current mapping hash (R3). */
export const MAPPING_PROVISIONAL_BANNER = 'Provisional — do not cite';
export const MAPPING_PROVISIONAL_STATEMENT = 'PROVISIONAL until stamped by the compliance lead';
export function mappingStampStatement(localDate: string): string {
  return `Mapping reviewed by compliance lead on ${localDate}`;
}

export type MetaFilterValue = string | number | boolean | null;
/** Per event type: meta field → allowed values (e.g. `decision.resolved` with `kind = go_live`). */
export type MetaFilters = Record<string, Record<string, MetaFilterValue[]>>;

export interface ComplianceMappingRowDTO {
  id: string;
  aocControl: string;
  aocFeature: string;
  clause: string;
  clauseTitle: string;
  relatedClauses: string[];
  /** Descriptive evidence statements. */
  evidence: string[];
  /** Catalog event types that evidence the control. */
  eventTypes: string[];
  metaFilters: MetaFilters;
  /** Rows are provisional until the whole mapping hash is stamped. */
  status: MappingStatus;
  correctionNote: string | null;
}

export interface MappingStampDTO {
  by: string;
  at: string;
  /** Date in the configured timezone, used in the "reviewed on X" statement. */
  localDate: string;
  eventId: string;
  seq: number;
  note: string | null;
}

export interface ComplianceMappingDTO {
  standard: string;
  version: string;
  hash: string;
  notes: string;
  source: MappingSource;
  file: string | null;
  /** Why a config file was rejected or normalised. */
  warnings: string[];
  status: MappingStatus;
  stampedBy: string | null;
  stampedAt: string | null;
  stamp: MappingStampDTO | null;
  statement: string;
  /** "Provisional — do not cite" until stamped; null once stamped. */
  banner: string | null;
  publishedAt: string | null;
  rows: ComplianceMappingRowDTO[];
  viewer: { canStamp: boolean; reason: string | null };
}

const zDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const MappingStampRequestSchema = z
  .object({
    version: z.string().min(1).max(40),
    note: z.string().max(2000).optional(),
    /** Optional concurrency guard: the mapping hash the reviewer actually saw. */
    hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();
export type MappingStampRequest = z.infer<typeof MappingStampRequestSchema>;

/** Inclusive local dates in the configured timezone. */
export const EvidencePackRequestSchema = z.object({ from: zDay, to: zDay }).strict();
export type EvidencePackRequest = z.infer<typeof EvidencePackRequestSchema>;

export type EvidencePackIntegrity = 'ok' | 'tampered' | 'missing';

export interface EvidencePackSummaryDTO {
  packId: string;
  from: string;
  to: string;
  generatedAt: string;
  generatedBy: Actor;
  packHash: string;
  bytes: number;
  eventCount: number;
  headSeq: number;
  mappingVersion: string;
  mappingHash: string;
  mappingStamped: boolean;
  rateCardVersion: number;
  chainOk: boolean;
  anchorsChecked: number;
  anchorsMatched: number;
  /** Off-host verification outcome (null for packs generated before it was recorded). */
  verification: EvidenceVerificationStatus | null;
  downloadUrl: string;
}

export interface EvidencePackDetailDTO extends EvidencePackSummaryDTO {
  /** Stored zip re-hashed on request. */
  integrity: EvidencePackIntegrity;
  /** Read from the stored zip; null unless integrity is ok. */
  manifest: EvidencePackManifest | null;
}

/**
 * One pack builds at a time. POST /api/evidence/packs answers 201 with the pack when it could start at once, else
 * 202 with this job (poll `statusUrl`); 429 when the caller already has a pack pending or is over the hourly budget.
 */
export interface EvidencePackJobDTO {
  jobId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  from: string;
  to: string;
  requestedBy: string;
  requestedAt: string;
  /** 1 = builds next; null once started. */
  position: number | null;
  pack: EvidencePackSummaryDTO | null;
  error: string | null;
  statusUrl: string;
}

// ── pack file format ─────────────────────────────────────────────────────────

export const EVIDENCE_PACK_FORMAT = 'aoc-evidence-pack/1';

export interface EvidenceEventRef {
  seq: number;
  id: string;
  type: string;
  ts: string;
}

/** A chained header kept verbatim (ids, amounts, enums, hashes) with its position in the log. */
export interface EvidenceMetaEntry {
  seq: number;
  id: string;
  ts: string;
  meta: JsonObject;
}

/** One events.jsonl line: the chained header, never the payload — enough to recompute every hash offline. */
export interface EvidenceEventLine {
  seq: number;
  id: string;
  ts: string;
  type: string;
  actor: Actor;
  scope: Scope;
  meta: JsonObject;
  payloadHash: string | null;
  bodyScope: string | null;
  source: string;
  sourceTs: string | null;
  idempotencyKey: string | null;
  causationId: string | null;
  prevHash: string;
  hash: string;
}

export interface EvidencePackRange {
  from: string;
  to: string;
  timezone: string;
  days: number;
  fromTs: string;
  toTsExclusive: string;
  /** false when the range had not fully elapsed at generation time. */
  complete: boolean;
}

export interface EvidenceFxSummary {
  days: number;
  live: number;
  inherited: number;
  missing: number;
  minRate: number | null;
  maxRate: number | null;
  discrepanciesRaised: number;
  discrepanciesResolved: number;
  carryForwardAlerts: number;
}

export interface EvidencePackFileEntry {
  path: string;
  sha256: string;
  bytes: number;
}

export interface EvidencePackManifest {
  format: typeof EVIDENCE_PACK_FORMAT;
  packId: string;
  range: EvidencePackRange;
  generatedAt: string;
  generatedBy: Actor;
  chainId: string;
  head: { seq: number; hash: string };
  eventCount: number;
  rangeSeqs: { first: number | null; last: number | null };
  mapping: {
    standard: string;
    version: string;
    hash: string;
    source: MappingSource;
    rows: number;
    status: MappingStatus;
    stampedBy: string | null;
    stampedAt: string | null;
    statement: string;
  };
  /** Rate card in force on `range.to` (latest ratecard.published effective on/before it). */
  rateCard: {
    version: number;
    effectiveFrom: string;
    rateCount: number;
    eventId: string;
    seq: number;
    publishedAt: string;
  } | null;
  rateCardVersionsUsed: number[];
  fx: EvidenceFxSummary;
  verification: {
    ok: boolean;
    status: EvidenceVerificationStatus;
    chainOk: boolean;
    anchorsChecked: number;
    anchorsMatched: number;
    rangeCoveredByAnchor: boolean;
    unanchoredTailEvents: number;
  };
  privacy: string;
  files: EvidencePackFileEntry[];
}

/**
 * verified: the chain recomputes and every anchor is confirmed by its off-host record; failed: a check failed (the
 * pack documents tampering); not_verifiable: no audit service, or an off-host record could not be read or is not
 * held off-host — the pack proves nothing beyond the in-file chain, which is defeatable on its own (R2).
 */
export type EvidenceVerificationStatus = 'verified' | 'failed' | 'not_verifiable';

export type EvidenceNotVerifiableReason =
  | 'audit_service_unavailable'
  | 'audit_verify_failed'
  | 'off_host_record_unavailable'
  | 'anchors_not_off_host'
  | 'no_anchors';

/** The off-host side of one anchor, from the audit service's verify-against-anchor (§13, R2). */
export interface EvidenceAnchorExternal {
  /** found; missing from a readable anchor store; or the store could not be read. */
  record: 'found' | 'missing' | 'store_unavailable';
  /** Hash in the off-host record (null unless found). */
  hash: string | null;
  /** The recomputed chain hash equals the off-host record's hash. */
  matched: boolean;
  /** The record's own proof holds (git: commit reachable and signed as configured; RFC 3161: token valid). */
  proofOk: boolean;
  /** Held beyond this host: a git commit present on the fetched remote, or a TSA-signed token. */
  offHost: boolean;
  signed: boolean | null;
  problems: string[];
}

export interface EvidenceAnchorCheck {
  anchorId: string;
  eventSeq: number;
  eventId: string;
  anchoredAt: string;
  seq: number;
  /** What the chain's anchor.created recorded — rewritten along with the log by anyone who rewrites the log. */
  anchoredHash: string;
  recomputedHash: string | null;
  /** Confirmed off-host: the recomputed hash equals the off-host record's hash and the record's proof holds. */
  matched: boolean;
  provider: string;
  proofRef: string;
  /** Null when the pack could not be verified against the off-host anchors. */
  external: EvidenceAnchorExternal | null;
}

export interface EvidenceVerification {
  /** status === 'verified'. */
  ok: boolean;
  status: EvidenceVerificationStatus;
  notVerifiableReason: EvidenceNotVerifiableReason | null;
  /** The audit service's run (null when it was unavailable). */
  external: {
    verifiedAt: string;
    /** git anchor remote fetched and compared (null = no remote configured). */
    remoteChecked: boolean | null;
    problems: string[];
    warnings: string[];
  } | null;
  chain: {
    ok: boolean;
    chainId: string;
    headSeq: number;
    headHash: string;
    checked: number;
    firstBadSeq: number | null;
    problems: string[];
  };
  anchorsChecked: number;
  anchorsMatched: number;
  anchors: EvidenceAnchorCheck[];
  range: {
    eventCount: number;
    firstSeq: number | null;
    lastSeq: number | null;
    firstPrevHash: string | null;
    lastHash: string | null;
    hashesRecomputed: number;
    hashesMatched: number;
  };
  /** Last matching anchor strictly before the range (attests the starting point). */
  anchorBeforeRange: EvidenceAnchorCheck | null;
  /** First matching anchor at or after the range's last event (attests the whole range). */
  anchorAfterRange: EvidenceAnchorCheck | null;
  rangeCoveredByAnchor: boolean;
  unanchoredTail: {
    lastAnchoredSeq: number;
    fromSeq: number | null;
    toSeq: number | null;
    events: number;
    rangeEvents: number;
  };
  method: { eventHash: string; canonicalJson: string; genesisPrevHash: string; note: string };
}

export interface EvidenceControlRow {
  id: string;
  aocControl: string;
  aocFeature: string;
  clause: string;
  clauseTitle: string;
  relatedClauses: string[];
  status: MappingStatus;
  eventTypes: string[];
  metaFilters: MetaFilters;
  counts: Record<string, number>;
  total: number;
  /** Up to 20 events spread evenly across the range. */
  samples: EvidenceEventRef[];
  /** The row cites no event types: its evidence is documentary. */
  documentaryOnly: boolean;
  noEventsInRange: boolean;
}

export interface EvidenceControls {
  mapping: { standard: string; version: string; hash: string; status: MappingStatus; statement: string };
  range: { from: string; to: string };
  rows: EvidenceControlRow[];
  /** In-range event types no mapping row cites (coverage gaps). */
  unmappedEventTypes: Record<string, number>;
}

/** self_approved_approver_gate: a requester approved their own approver-level gate (builders may self-approve reversible work). */
export type EvidenceGateFlag = 'request_not_found' | 'passkey_not_verified' | 'self_approved_approver_gate';

export interface EvidenceGate {
  decisionId: string;
  kind: string;
  test: string | null;
  requiredRole: string | null;
  requiresPasskey: boolean | null;
  subjectType: string | null;
  subjectId: string | null;
  optionId: string;
  resolvedBy: string;
  method: string;
  passkeyVerified: boolean;
  /** §6: a button under a bearer token is attribution, a verified passkey a signature (RESOLUTION_ASSURANCE_LABEL). */
  assurance: ResolutionAssurance;
  assuranceLabel: string;
  selfApproved: boolean;
  ageMs: number;
  resolvedAt: string;
  seq: number;
  eventId: string;
  requestedSeq: number | null;
  flags: EvidenceGateFlag[];
}

export interface EvidenceGates {
  count: number;
  byKind: Record<string, number>;
  /** Resolutions per assurance: signature (passkey), attribution (bearer token), policy. */
  byAssurance: Record<ResolutionAssurance, number>;
  passkeyVerified: number;
  selfApproved: number;
  byPolicy: number;
  flagged: number;
  gates: EvidenceGate[];
}

export interface EvidenceChange {
  changeId: string;
  projectId: string | null;
  scope: string | null;
  draftedBy: string | null;
  sessionId: string | null;
  breakglassId: string | null;
  draftedAt: string | null;
  draftedInRange: boolean;
  /** As of the end of the range. */
  status: string;
  selfApprovable: boolean | null;
  selfApproved: boolean | null;
  approverId: string | null;
  decisionId: string | null;
  rollbackSha: string | null;
  pinnedSha: string | null;
  pinnedTag: string | null;
  affirmations: { total: number; edited: number; affirmedWithoutEdit: number };
  events: EvidenceEventRef[];
}

export interface EvidenceChanges {
  count: number;
  byStatus: Record<string, number>;
  affirmedWithoutEdit: number;
  changes: EvidenceChange[];
}

export type EvidenceRollbackFlag = 'executed_without_clean_verification' | 'approved_without_passkey';

export interface EvidenceRollback {
  rollbackId: string;
  projectId: string | null;
  targetRef: string | null;
  targetSha: string | null;
  changeId: string | null;
  branch: string | null;
  testsPassed: number | null;
  testsFailed: number | null;
  clean: boolean | null;
  decisionId: string | null;
  approverId: string | null;
  passkeyVerified: boolean | null;
  mainShaBefore: string | null;
  mainShaAfter: string | null;
  status: string;
  flags: EvidenceRollbackFlag[];
  events: EvidenceEventRef[];
}

export interface EvidenceRollbacks {
  count: number;
  executed: number;
  flagged: number;
  rollbacks: EvidenceRollback[];
}

export type EvidenceBreakglassFlag =
  'approved_without_passkey' | 'post_incident_overdue' | 'post_incident_open';

export interface EvidenceBreakglass {
  breakglassId: string;
  projectId: string | null;
  invokedBy: string | null;
  ref: string | null;
  sha: string | null;
  decisionId: string | null;
  invokedAt: string | null;
  approverId: string | null;
  passkeyVerified: boolean | null;
  postIncident: {
    changeId: string;
    dueAt: string;
    completedAt: string | null;
    completedWithinDue: boolean | null;
  } | null;
  flags: EvidenceBreakglassFlag[];
  events: EvidenceEventRef[];
}

export interface EvidenceBreakglassFile {
  count: number;
  flagged: number;
  incidents: EvidenceBreakglass[];
  /** promotion.completed with breakglass=true in range. */
  breakglassPromotions: EvidenceMetaEntry[];
}

export interface EvidenceCredits {
  allocations: EvidenceMetaEntry[];
  capsReached: EvidenceMetaEntry[];
  autoGrants: EvidenceMetaEntry[];
  topupRequests: EvidenceMetaEntry[];
  topupsGranted: EvidenceMetaEntry[];
  topupsDenied: EvidenceMetaEntry[];
  totals: {
    allocatedUsd: number;
    autoGrantedUsd: number;
    topupRequestedUsd: number;
    topupGrantedUsd: number;
  };
  flags: { seq: number; eventId: string; flag: 'self_granted_topup' | 'repeat_auto_grant_in_period' }[];
}

export interface EvidenceFxDay {
  date: string;
  rate: number | null;
  status: 'live' | 'inherited' | 'missing';
  sourceDate: string | null;
  extractor: string | null;
  validation: string | null;
  reason: string | null;
  /** fx.rate_recorded events for this date (the latest one is in force). */
  records: number;
  seq: number | null;
  eventId: string | null;
}

export interface EvidenceFxDiscrepancy {
  date: string;
  scraped: number;
  official: number;
  decisionId: string;
  raisedSeq: number;
  raisedEventId: string;
  resolution: { chosenRate: number; seq: number; eventId: string } | null;
}

export interface EvidenceFx {
  pair: 'USD/MYR';
  days: EvidenceFxDay[];
  discrepancies: EvidenceFxDiscrepancy[];
  carryForwardAlerts: EvidenceMetaEntry[];
  summary: EvidenceFxSummary;
}
