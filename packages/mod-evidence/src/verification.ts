import type { EvidenceAnchorCheck, EvidenceEventLine, EvidenceVerification } from '@aoc/contracts';
import { canonicalJson, sha256hex, type EventStore } from '@aoc/kernel';
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
 * Whole-chain verification plus every anchor: the hash recomputed at each anchored seq must equal the hash
 * recorded when it was anchored. The in-file chain alone is defeatable (R2) — anchors are what make it evidence.
 */
export function buildVerification(
  store: EventStore,
  headSeq: number,
  linkage: RangeLinkage,
): EvidenceVerification {
  const anchorEvents = [...iterateEvents(store, { types: ['anchor.created'], toSeq: headSeq })];
  const chain = store.verifyChain({ atSeqs: anchorEvents.map((a) => metaOf(a, 'anchor.created').seq) });
  const anchors: EvidenceAnchorCheck[] = anchorEvents.map((a) => {
    const m = metaOf(a, 'anchor.created');
    const recomputed = chain.hashesAt[m.seq] ?? null;
    return {
      anchorId: m.anchorId,
      eventSeq: a.seq,
      eventId: a.id,
      anchoredAt: a.ts,
      seq: m.seq,
      anchoredHash: m.hash,
      recomputedHash: recomputed,
      matched: recomputed !== null && recomputed === m.hash,
      provider: m.provider,
      proofRef: m.proofRef,
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
  return {
    ok: chain.ok && anchorsMatched === anchors.length && linkage.hashesMatched === linkage.hashesRecomputed,
    chain: {
      ok: chain.ok,
      chainId: chain.chainId,
      headSeq: chain.headSeq,
      headHash: chain.headHash,
      checked: chain.checked,
      firstBadSeq: chain.firstBadSeq,
      problems: chain.problems,
    },
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
      note: 'The in-file chain alone is defeatable (drop the trigger and recompute). anchoredHash is the value recorded when the head was anchored; confirm it against the off-host proof named by proofRef (§13, R2).',
    },
  };
}
