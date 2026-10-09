import { strToU8, zipSync } from 'fflate';
import {
  EVIDENCE_PACK_FORMAT,
  type Actor,
  type EvidenceControls,
  type EvidenceEventRef,
  type EvidencePackFileEntry,
  type EvidencePackManifest,
  type EvidencePackRange,
  type EvidenceVerification,
  type MappingStatus,
  type StoredEvent,
} from '@aoc/contracts';
import { canonicalJson, sha256hex, type EventStore } from '@aoc/kernel';
import { iterateEvents, lineOf, refOf, spread } from './events';
import { matchesFilter, rowIndex, type LoadedMapping } from './mapping';
import type { ResolvedRange } from './range';
import { renderReport } from './report';
import {
  buildBreakglass,
  buildChanges,
  buildCredits,
  buildFx,
  buildGates,
  buildRollbacks,
  rateCardInForce,
  rateCardVersionsUsed,
  type SectionContext,
} from './sections';
import {
  buildVerification,
  recomputeLineHash,
  type PackVerificationSource,
  type RangeLinkage,
} from './verification';

export const PACK_PRIVACY_STATEMENT =
  'events.jsonl holds chained event headers only (ids, enums, numbers, hashes). Event payloads and bodies are never exported: personal data stays behind the role boundary.';
const SAMPLES_PER_ROW = 20;

export interface MappingSnapshot {
  loaded: LoadedMapping;
  status: MappingStatus;
  stampedBy: string | null;
  stampedAt: string | null;
  statement: string;
}

export interface BuildPackInput {
  store: EventStore;
  packId: string;
  range: ResolvedRange;
  generatedAt: string;
  generatedBy: Actor;
  mapping: MappingSnapshot;
  /** The verification the pack is frozen with (audit service, or in-file only); its head is the pack's head. */
  verification: PackVerificationSource;
}

export interface BuiltPack {
  zip: Uint8Array;
  /** sha256 of the zip bytes. */
  packHash: string;
  manifest: EvidencePackManifest;
  /** verification.json as packed. */
  verification: EvidenceVerification;
}

const json = (x: unknown) => strToU8(JSON.stringify(x, null, 2) + '\n');
const fileEntry = (path: string, bytes: Uint8Array): EvidencePackFileEntry => ({
  path,
  sha256: sha256hex(bytes),
  bytes: bytes.length,
});

function publicRange(r: ResolvedRange): EvidencePackRange {
  return {
    from: r.from,
    to: r.to,
    timezone: r.timezone,
    days: r.days,
    fromTs: r.fromTs,
    toTsExclusive: r.toTsExclusive,
    complete: r.complete,
  };
}

/**
 * Build a frozen evidence pack from the log as of the current head. Reads chained headers only — never
 * payloads — so nothing behind the role boundary (personal data, prompts, file contents) can leak into it.
 */
export function buildEvidencePack(input: BuildPackInput): BuiltPack {
  const { store, range, mapping } = input;
  const verified = input.verification.report ?? input.verification.inFile;
  const head = { seq: verified.headSeq, hash: verified.headHash, chainId: verified.chainId };
  const endTsIncl = new Date(range.endMs - 1).toISOString();
  const ctx: SectionContext = { store, headSeq: head.seq, range, endTsIncl, generatedAt: input.generatedAt };
  const beforeTs = new Date(range.startMs - 1).toISOString();
  const lastSeqBefore = store.list({ toTs: beforeTs, toSeq: head.seq, order: 'desc', limit: 1 })[0]?.seq ?? 0;

  const rows = mapping.loaded.mapping.rows;
  const index = rowIndex(rows);
  const perRow = rows.map((r) => ({
    counts: Object.fromEntries(r.eventTypes.map((t) => [t, 0])) as Record<string, number>,
    total: 0,
    refs: [] as EvidenceEventRef[],
  }));
  const unmapped: Record<string, number> = {};
  const lines: string[] = [];
  const linkage: RangeLinkage = {
    eventCount: 0,
    firstSeq: null,
    lastSeq: null,
    firstPrevHash: null,
    lastHash: null,
    hashesRecomputed: 0,
    hashesMatched: 0,
    lastSeqBefore,
    seqs: [],
  };
  const resolved: StoredEvent[] = [];
  const changes: StoredEvent[] = [];
  const rollbacks: StoredEvent[] = [];
  const breakglass: StoredEvent[] = [];
  const breakglassPromotions: StoredEvent[] = [];
  const credits: StoredEvent[] = [];
  const carryAlerts: StoredEvent[] = [];

  for (const e of iterateEvents(store, { fromTs: range.fromTs, toTs: endTsIncl, toSeq: head.seq })) {
    const line = lineOf(e);
    lines.push(canonicalJson(line));
    linkage.eventCount++;
    linkage.seqs.push(e.seq);
    if (linkage.firstSeq === null) {
      linkage.firstSeq = e.seq;
      linkage.firstPrevHash = e.prevHash;
    }
    linkage.lastSeq = e.seq;
    linkage.lastHash = e.hash;
    linkage.hashesRecomputed++;
    if (recomputeLineHash(head.chainId, line) === e.hash) linkage.hashesMatched++;

    const ref = refOf(e);
    let cited = false;
    for (const hit of index.get(e.type) ?? []) {
      if (!matchesFilter(hit.filter, e.meta)) continue;
      cited = true;
      const acc = perRow[hit.row]!;
      acc.counts[e.type] = (acc.counts[e.type] ?? 0) + 1;
      acc.total++;
      acc.refs.push(ref);
    }
    if (!cited) unmapped[e.type] = (unmapped[e.type] ?? 0) + 1;

    if (e.type === 'decision.resolved') resolved.push(e);
    else if (e.type.startsWith('change.')) changes.push(e);
    else if (e.type.startsWith('rollback.')) rollbacks.push(e);
    else if (e.type.startsWith('breakglass.')) breakglass.push(e);
    else if (e.type.startsWith('credit.')) credits.push(e);
    else if (e.type === 'fx.carry_forward_alert') carryAlerts.push(e);
    else if (e.type === 'promotion.completed' && e.meta.breakglass === true) breakglassPromotions.push(e);
  }

  const verification = buildVerification(store, head.seq, linkage, input.verification);
  const gatesFile = buildGates(ctx, resolved);
  const changesFile = buildChanges(ctx, changes);
  const rollbacksFile = buildRollbacks(ctx, rollbacks);
  const breakglassFile = buildBreakglass(ctx, breakglass, breakglassPromotions);
  const creditsFile = buildCredits(credits);
  const fxFile = buildFx(ctx, carryAlerts);
  const rateCard = rateCardInForce(ctx);
  const m = mapping.loaded.mapping;
  const controls: EvidenceControls = {
    mapping: {
      standard: m.standard,
      version: m.version,
      hash: mapping.loaded.hash,
      status: mapping.status,
      statement: mapping.statement,
    },
    range: { from: range.from, to: range.to },
    rows: rows.map((r, i) => {
      const acc = perRow[i]!;
      return {
        id: r.id,
        aocControl: r.aocControl,
        aocFeature: r.aocFeature,
        clause: r.clause,
        clauseTitle: r.clauseTitle,
        relatedClauses: r.relatedClauses,
        status: mapping.status,
        eventTypes: r.eventTypes,
        metaFilters: r.metaFilters,
        counts: acc.counts,
        total: acc.total,
        samples: spread(acc.refs, SAMPLES_PER_ROW),
        documentaryOnly: r.eventTypes.length === 0,
        noEventsInRange: acc.total === 0,
      };
    }),
    unmappedEventTypes: unmapped,
  };

  const data: [string, Uint8Array][] = [
    ['events.jsonl', strToU8(lines.length ? lines.join('\n') + '\n' : '')],
    ['verification.json', json(verification)],
    ['controls.json', json(controls)],
    ['gates.json', json(gatesFile)],
    ['changes.json', json(changesFile)],
    ['rollbacks.json', json(rollbacksFile)],
    ['breakglass.json', json(breakglassFile)],
    ['credits.json', json(creditsFile)],
    ['fx.json', json(fxFile)],
  ];
  const dataFiles = data.map(([path, bytes]) => fileEntry(path, bytes));
  const base: Omit<EvidencePackManifest, 'files'> = {
    format: EVIDENCE_PACK_FORMAT,
    packId: input.packId,
    range: publicRange(range),
    generatedAt: input.generatedAt,
    generatedBy: input.generatedBy,
    chainId: head.chainId,
    head: { seq: head.seq, hash: head.hash },
    eventCount: linkage.eventCount,
    rangeSeqs: { first: linkage.firstSeq, last: linkage.lastSeq },
    mapping: {
      standard: m.standard,
      version: m.version,
      hash: mapping.loaded.hash,
      source: mapping.loaded.source,
      rows: rows.length,
      status: mapping.status,
      stampedBy: mapping.stampedBy,
      stampedAt: mapping.stampedAt,
      statement: mapping.statement,
    },
    rateCard,
    rateCardVersionsUsed: rateCardVersionsUsed(ctx),
    fx: fxFile.summary,
    verification: {
      ok: verification.ok,
      status: verification.status,
      chainOk: verification.chain.ok,
      anchorsChecked: verification.anchorsChecked,
      anchorsMatched: verification.anchorsMatched,
      rangeCoveredByAnchor: verification.rangeCoveredByAnchor,
      unanchoredTailEvents: verification.unanchoredTail.events,
    },
    privacy: PACK_PRIVACY_STATEMENT,
  };
  const html = strToU8(
    renderReport({
      manifest: base,
      dataFiles,
      verification,
      controls,
      gates: gatesFile,
      changes: changesFile,
      rollbacks: rollbacksFile,
      breakglass: breakglassFile,
      credits: creditsFile,
      fx: fxFile,
    }),
  );
  const manifest: EvidencePackManifest = { ...base, files: [...dataFiles, fileEntry('index.html', html)] };
  const zip = zipSync(
    { 'manifest.json': json(manifest), ...Object.fromEntries(data), 'index.html': html },
    { level: 6, mtime: new Date(input.generatedAt) },
  );
  return { zip, packHash: sha256hex(zip), manifest, verification };
}
