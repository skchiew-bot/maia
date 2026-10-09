/** Integrity: chain verification, off-host anchoring, break-glass exposure, provenance, mapping and platform health. */
import type { TowerIntegrity } from '@aoc/contracts';
import type { IntegrityFacts } from './attention';
import { all, inProject, iso, one, type ReadCtx } from './read';
import { DAY } from './zoned';

interface StateRow {
  verified_ms: number | null;
  chain_ok: number | null;
  first_bad_seq: number | null;
  broken_since_ms: number | null;
  anchor_ms: number | null;
  anchor_seq: number | null;
  anchor_failed_ms: number | null;
  anchor_fail_reason: string | null;
  mapping_version: string | null;
  mapping_hash: string | null;
}

export function buildIntegrity(r: ReadCtx): { integrity: TowerIntegrity; facts: IntegrityFacts } {
  const s = one<StateRow>(r, 'SELECT * FROM twr_state WHERE id = 1');
  const chainOk = s?.verified_ms != null ? s.chain_ok === 1 : null;
  const anchorMs = s?.anchor_ms ?? null;
  const unanchoredEvents = Math.max(0, r.store.head().seq - (s?.anchor_seq ?? 0));
  const first = r.store.get(1);
  const degraded = r.store
    .projectionHealth()
    .filter((h) => h.status === 'degraded')
    .map((h) => ({ name: h.name, failedSeq: h.failedSeq }));

  const [where, args] = inProject(r, 'b.project_id');
  // Open: invoked and its post-incident change not completed, unless the emergency was rejected, withdrawn or
  // expired (a resolved decision with no approval is a rejection too).
  const breakglass = all<{ overdue_ms: number | null }>(
    r,
    `SELECT b.overdue_ms FROM twr_breakglass b
     LEFT JOIN twr_decisions d ON d.decision_id = b.decision_id
     LEFT JOIN twr_changes c ON c.change_id = b.change_id
     WHERE c.completed_ms IS NULL AND b.rejected_ms IS NULL AND COALESCE(d.status, 'open') NOT IN ('withdrawn', 'expired')
       AND NOT (COALESCE(d.status, 'open') = 'resolved' AND b.approved_ms IS NULL)${where}`,
    ...args,
  );
  const [aw, aa] = inProject(r, 'project_id');
  const count7d = (type: string) =>
    one<{ n: number }>(
      r,
      `SELECT COUNT(*) AS n FROM twr_audit_log WHERE type = ? AND ts_ms >= ?${aw}`,
      type,
      r.now - 7 * DAY,
      ...aa,
    )!.n;

  let mappingStatus: TowerIntegrity['mappingStatus'] = 'unknown';
  if (s?.mapping_version) {
    const stamped = one(
      r,
      'SELECT 1 FROM twr_mapping_stamps WHERE version = ? AND hash = ?',
      s.mapping_version,
      s.mapping_hash ?? '',
    );
    mappingStatus = stamped ? 'stamped' : 'provisional';
  }

  return {
    integrity: {
      chainOk,
      lastVerifiedAt: s?.verified_ms != null ? iso(s.verified_ms) : null,
      lastAnchorAt: anchorMs !== null ? iso(anchorMs) : null,
      anchorAgeMs: anchorMs !== null ? Math.max(0, r.now - anchorMs) : null,
      unanchoredEvents,
      breakglassOpen: breakglass.length,
      postIncidentOverdue: breakglass.filter((b) => b.overdue_ms !== null).length,
      provenanceRefusals7d: count7d('promotion.refused'),
      selfModBlocks7d: count7d('selfmod.blocked'),
      mappingStatus,
      degradedProjections: degraded.length,
      reactorFailures24h: reactorFailures(r),
    },
    facts: {
      chainOk,
      brokenSinceMs: s?.broken_since_ms ?? null,
      firstBadSeq: s?.first_bad_seq ?? null,
      anchorMs,
      anchorFailedMs: s?.anchor_failed_ms ?? null,
      anchorFailReason: s?.anchor_fail_reason ?? null,
      unanchoredEvents,
      firstEventMs: first ? Date.parse(first.ts) : null,
      degraded,
    },
  };
}

/** Kernel bookkeeping table (read-only); absent when the store runs without the module host. */
function reactorFailures(r: ReadCtx): number {
  try {
    return one<{ n: number }>(
      r,
      'SELECT COUNT(*) AS n FROM reactor_failures WHERE at >= ?',
      iso(r.now - DAY),
    )!.n;
  } catch {
    return 0;
  }
}
