import type {
  AnchorCheckDTO,
  EvidenceAnchorCheck,
  EvidenceAnchorExternal,
  EvidenceEventLine,
  EvidenceNotVerifiableReason,
  EvidenceVerification,
  EvidenceVerificationStatus,
  VerifyReportDTO,
} from '@aoc/contracts';
import { canonicalJson, sha256hex, type ChainVerifyResult, type EventStore } from '@aoc/kernel';
import { iterateEvents, metaOf } from './events';

/** The kernel's event-hash recipe, recomputed from an exported line so packs are verifiable offline. */
export function recomputeLineHash(chainId: string, l: EvidenceEventLine): string {
  return sha256hex(
    canonicalJson({
      v: 1,
      chainId,
      seq: l.seq,
      id: l.id,
      ts: l.ts,
      type: l.type,
      actor: l.actor,
      scope: l.scope,
      meta: l.meta,
      payloadHash: l.payloadHash,
      bodyScope: l.bodyScope,
      source: l.source,
      sourceTs: l.sourceTs,
      idempotencyKey: l.idempotencyKey,
      causationId: l.causationId,
      prevHash: l.prevHash,
    }),
  );
}

export interface RangeLinkage {
  eventCount: number;
  firstSeq: number | null;
  lastSeq: number | null;
  firstPrevHash: string | null;
  lastHash: string | null;
  hashesRecomputed: number;
  hashesMatched: number;
  /** Highest seq written before the range started (0 when none). */
  lastSeqBefore: number;
  /** Seqs of the range's events, ascending. */
  seqs: number[];
}

/**
 * What a pack is verified with: the audit service's verify-against-anchor (the off-host records and proofs), or —
 * when that is unavailable — only the in-file recomputation, which makes the pack not verifiable (R2).
 */
export type PackVerificationSource =
  | { report: VerifyReportDTO }
  | { report: null; reason: 'audit_service_unavailable' | 'audit_verify_failed'; inFile: ChainVerifyResult };

function externalOf(c: AnchorCheckDTO, report: VerifyReportDTO): EvidenceAnchorExternal {
  const found = c.record === 'found';
  return {
    record: c.record,
    hash: found ? c.anchoredHash : null,
    matched: found && c.matched,
    proofOk: found && c.proofOk,
    // A TSA-signed token stands on its own; a git anchor counts only once seen on the fetched off-host remote.
    offHost: found && (c.provider === 'rfc3161' || (report.remoteChecked === true && c.offHost === true)),
    signed: c.signed,
    problems: c.problems,
  };
}

function statusOf(
  source: PackVerificationSource,
  chainOk: boolean,
  rangeOk: boolean,
): { status: EvidenceVerificationStatus; reason: EvidenceNotVerifiableReason | null } {
  if (!chainOk || !rangeOk) return { status: 'failed', reason: null };
  const report = source.report;
  if (!report) return { status: 'not_verifiable', reason: source.reason };
  const found = report.anchors.filter((c) => c.record === 'found');
  // Any disagreement documents tampering, whether or not the rest could be checked.
  if (report.anchors.some((c) => c.record === 'missing') || found.some((c) => !c.matched || !c.proofOk))
    return { status: 'failed', reason: null };
  if (report.anchors.some((c) => c.record === 'store_unavailable'))
    return { status: 'not_verifiable', reason: 'off_host_record_unavailable' };
  if (!report.anchors.length) return { status: 'not_verifiable', reason: 'no_anchors' };
  if (report.remoteChecked === false && report.anchors.some((c) => c.provider === 'git'))
    return { status: 'not_verifiable', reason: 'off_host_record_unavailable' };
  if (report.anchors.some((c) => !externalOf(c, report).offHost))
    return { status: 'not_verifiable', reason: 'anchors_not_off_host' };
  return report.ok ? { status: 'verified', reason: null } : { status: 'failed', reason: null };
}

/**
 * Whole-chain verification plus every anchor, confirmed against its off-host record by the audit service: a forgery
 * that rewrites the log and its anchor.created rows still disagrees with the records held off-host. The in-chain
 * anchors are listed with their external result; the pack is verified only when every one is confirmed off-host.
 */
export function buildVerification(
  store: EventStore,
  headSeq: number,
  linkage: RangeLinkage,
  source: PackVerificationSource,
): EvidenceVerification {
  const anchorEvents = [...iterateEvents(store, { types: ['anchor.created'], toSeq: headSeq })];
  const report = source.report;
  const chain = report
    ? {
        ok: report.chainOk,
        chainId: report.chainId,
        headSeq: report.headSeq,
        headHash: report.headHash,
        checked: report.checked,
        firstBadSeq: report.chainFirstBadSeq,
        problems: report.chainProblems,
      }
    : {
        ok: source.inFile.ok,
        chainId: source.inFile.chainId,
        headSeq: source.inFile.headSeq,
        headHash: source.inFile.headHash,
        checked: source.inFile.checked,
        firstBadSeq: source.inFile.firstBadSeq,
        problems: source.inFile.problems,
      };
  const anchors: EvidenceAnchorCheck[] = anchorEvents.map((a) => {
    const m = metaOf(a, 'anchor.created');
    const check = report?.anchors.find((c) => c.provider === m.provider && c.seq === m.seq) ?? null;
    const external = check && report ? externalOf(check, report) : null;
    return {
      anchorId: m.anchorId,
      eventSeq: a.seq,
      eventId: a.id,
      anchoredAt: a.ts,
      seq: m.seq,
      anchoredHash: m.hash,
      recomputedHash: check ? check.recomputedHash : report ? null : (source.inFile.hashesAt[m.seq] ?? null),
      matched: external !== null && external.matched && external.proofOk && external.offHost,
      provider: m.provider,
      proofRef: m.proofRef,
      external,
    };
  });
  const matched = anchors.filter((a) => a.matched).sort((a, b) => a.seq - b.seq);
  let before: EvidenceAnchorCheck | null = null;
  let after: EvidenceAnchorCheck | null = null;
  if (linkage.firstSeq !== null && linkage.lastSeq !== null) {
    before = matched.filter((a) => a.seq < linkage.firstSeq!).at(-1) ?? null;
    after = matched.find((a) => a.seq >= linkage.lastSeq!) ?? null;
  } else {
    before = matched.filter((a) => a.seq <= linkage.lastSeqBefore).at(-1) ?? null;
    after = matched.find((a) => a.seq > linkage.lastSeqBefore) ?? null;
  }
  const lastAnchoredSeq = matched.at(-1)?.seq ?? 0;
  const tail = Math.max(0, headSeq - lastAnchoredSeq);
  const rangeTail = linkage.seqs.filter((s) => s > lastAnchoredSeq).length;
  const anchorsMatched = anchors.filter((a) => a.matched).length;
  const { status, reason } = statusOf(source, chain.ok, linkage.hashesMatched === linkage.hashesRecomputed);
  return {
    ok: status === 'verified',
    status,
    notVerifiableReason: reason,
    external: report
      ? {
          verifiedAt: report.verifiedAt,
          remoteChecked: report.remoteChecked,
          problems: report.problems,
          warnings: report.warnings,
        }
      : null,
    chain,
    anchorsChecked: anchors.length,
    anchorsMatched,
    anchors,
    range: {
      eventCount: linkage.eventCount,
      firstSeq: linkage.firstSeq,
      lastSeq: linkage.lastSeq,
      firstPrevHash: linkage.firstPrevHash,
      lastHash: linkage.lastHash,
      hashesRecomputed: linkage.hashesRecomputed,
      hashesMatched: linkage.hashesMatched,
    },
    anchorBeforeRange: before,
    anchorAfterRange: after,
    rangeCoveredByAnchor: linkage.eventCount === 0 || after !== null,
    unanchoredTail: {
      lastAnchoredSeq,
      fromSeq: tail ? lastAnchoredSeq + 1 : null,
      toSeq: tail ? headSeq : null,
      events: tail,
      rangeEvents: rangeTail,
    },
    method: {
      eventHash:
        'sha256(canonicalJson({v:1, chainId, seq, id, ts, type, actor, scope, meta, payloadHash, bodyScope, source, sourceTs, idempotencyKey, causationId, prevHash}))',
      canonicalJson:
        'JSON with object keys sorted recursively, no whitespace, undefined members dropped (RFC 8785 style)',
      genesisPrevHash: "sha256('aoc-genesis:' + chainId) is the prevHash of seq 1",
      note: 'The in-file chain alone is defeatable (drop the trigger and recompute). Each anchor was checked against its off-host record (git commit on the anchor remote, or RFC 3161 token) by the audit service: external.hash is that record; anchoredHash is what the chain itself recorded (§13, R2).',
    },
  };
}
