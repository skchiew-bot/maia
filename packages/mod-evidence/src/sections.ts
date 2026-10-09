import type {
  EvidenceBreakglass,
  EvidenceBreakglassFile,
  EvidenceChange,
  EvidenceChanges,
  EvidenceCredits,
  EvidenceFx,
  EvidenceFxDay,
  EvidenceFxDiscrepancy,
  EvidenceGate,
  EvidenceGateFlag,
  EvidenceGates,
  EvidenceMetaEntry,
  EvidencePackManifest,
  EvidenceRollback,
  EvidenceRollbacks,
  StoredEvent,
} from '@aoc/contracts';
import type { EventStore } from '@aoc/kernel';
import { entryOf, iterateEvents, metaOf, refOf, typesWithPrefix } from './events';
import { datesBetween, type ResolvedRange } from './range';

export interface SectionContext {
  store: EventStore;
  headSeq: number;
  range: ResolvedRange;
  /** Last instant inside the range (ISO), for "as of the end of the range" history queries. */
  endTsIncl: string;
  generatedAt: string;
}

const CHANGE_TYPES = typesWithPrefix('change.');
const ROLLBACK_TYPES = typesWithPrefix('rollback.');
const BREAKGLASS_TYPES = typesWithPrefix('breakglass.');

function tally(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return out;
}

/** Group in-range events by an id meta field, preserving first-seen order. */
function groupBy(events: StoredEvent[], field: string): Map<string, StoredEvent[]> {
  const out = new Map<string, StoredEvent[]>();
  for (const e of events) {
    const id = e.meta[field];
    if (typeof id !== 'string') continue;
    const list = out.get(id) ?? [];
    list.push(e);
    out.set(id, list);
  }
  return out;
}

/** Each entity's events up to the end of the range (context may predate the range). */
function historyOf(
  ctx: SectionContext,
  types: string[],
  field: string,
  ids: Set<string>,
): Map<string, StoredEvent[]> {
  const out = new Map<string, StoredEvent[]>();
  if (!ids.size) return out;
  for (const e of iterateEvents(ctx.store, { types, toSeq: ctx.headSeq, toTs: ctx.endTsIncl })) {
    const id = e.meta[field];
    if (typeof id !== 'string' || !ids.has(id)) continue;
    const list = out.get(id) ?? [];
    list.push(e);
    out.set(id, list);
  }
  return out;
}

export function buildGates(ctx: SectionContext, resolved: StoredEvent[]): EvidenceGates {
  const needed = new Set(resolved.map((e) => metaOf(e, 'decision.resolved').decisionId));
  const requested = new Map<string, StoredEvent>();
  if (needed.size) {
    for (const e of iterateEvents(ctx.store, { types: ['decision.requested'], toSeq: ctx.headSeq })) {
      const id = metaOf(e, 'decision.requested').decisionId;
      if (needed.has(id) && !requested.has(id)) requested.set(id, e);
    }
  }
  const gates: EvidenceGate[] = resolved.map((e) => {
    const m = metaOf(e, 'decision.resolved');
    const req = requested.get(m.decisionId);
    const rm = req ? metaOf(req, 'decision.requested') : null;
    const flags: EvidenceGateFlag[] = [];
    if (!rm) flags.push('request_not_found');
    if (rm?.requiresPasskey && !m.passkeyVerified) flags.push('passkey_not_verified');
    // Builders may self-approve reversible off-main work by design (§6); only approver gates are a finding.
    if (m.selfApproved && rm?.requiredRole === 'approver') flags.push('self_approved_approver_gate');
    return {
      decisionId: m.decisionId,
      kind: m.kind,
      test: rm?.test ?? null,
      requiredRole: rm?.requiredRole ?? null,
      requiresPasskey: rm?.requiresPasskey ?? null,
      subjectType: rm?.subjectType ?? null,
      subjectId: rm?.subjectId ?? null,
      optionId: m.optionId,
      resolvedBy: m.resolvedBy,
      method: m.method,
      passkeyVerified: m.passkeyVerified,
      selfApproved: m.selfApproved,
      ageMs: m.ageMs,
      resolvedAt: e.ts,
      seq: e.seq,
      eventId: e.id,
      requestedSeq: req?.seq ?? null,
      flags,
    };
  });
  return {
    count: gates.length,
    byKind: tally(gates.map((g) => g.kind)),
    passkeyVerified: gates.filter((g) => g.passkeyVerified).length,
    selfApproved: gates.filter((g) => g.selfApproved).length,
    byPolicy: gates.filter((g) => g.method === 'policy').length,
    flagged: gates.filter((g) => g.flags.length > 0).length,
    gates,
  };
}

export function buildChanges(ctx: SectionContext, inRange: StoredEvent[]): EvidenceChanges {
  const groups = groupBy(inRange, 'changeId');
  const history = historyOf(ctx, CHANGE_TYPES, 'changeId', new Set(groups.keys()));
  const changes: EvidenceChange[] = [...groups].map(([changeId, events]) => {
    const c: EvidenceChange = {
      changeId,
      projectId: null,
      scope: null,
      draftedBy: null,
      sessionId: null,
      breakglassId: null,
      draftedAt: null,
      draftedInRange: false,
      status: 'unknown',
      selfApprovable: null,
      selfApproved: null,
      approverId: null,
      decisionId: null,
      rollbackSha: null,
      pinnedSha: null,
      pinnedTag: null,
      affirmations: { total: 0, edited: 0, affirmedWithoutEdit: 0 },
      events: events.map(refOf),
    };
    for (const e of history.get(changeId) ?? []) {
      switch (e.type) {
        case 'change.drafted': {
          const m = metaOf(e, 'change.drafted');
          Object.assign(c, {
            projectId: m.projectId,
            scope: m.scope,
            draftedBy: m.draftedBy,
            sessionId: m.sessionId,
            breakglassId: m.breakglassId,
          });
          c.draftedAt = e.ts;
          c.draftedInRange = e.ts >= ctx.range.fromTs;
          c.status = 'drafted';
          break;
        }
        case 'change.field_affirmed': {
          c.affirmations.total++;
          if (metaOf(e, 'change.field_affirmed').edited) c.affirmations.edited++;
          else c.affirmations.affirmedWithoutEdit++;
          break;
        }
        case 'change.submitted': {
          const m = metaOf(e, 'change.submitted');
          Object.assign(c, {
            selfApprovable: m.selfApprovable,
            decisionId: m.decisionId,
            rollbackSha: m.rollbackSha,
            status: 'submitted',
          });
          break;
        }
        case 'change.approved': {
          const m = metaOf(e, 'change.approved');
          Object.assign(c, {
            approverId: m.approverId,
            selfApproved: m.selfApproved,
            decisionId: m.decisionId ?? c.decisionId,
            status: 'approved',
          });
          break;
        }
        case 'change.rejected': {
          const m = metaOf(e, 'change.rejected');
          Object.assign(c, {
            approverId: m.approverId,
            decisionId: m.decisionId ?? c.decisionId,
            status: 'rejected',
          });
          break;
        }
        case 'change.started':
          c.status = 'started';
          break;
        case 'change.completed': {
          const m = metaOf(e, 'change.completed');
          Object.assign(c, { pinnedSha: m.pinnedSha, pinnedTag: m.pinnedTag, status: 'completed' });
          break;
        }
      }
    }
    return c;
  });
  return {
    count: changes.length,
    byStatus: tally(changes.map((c) => c.status)),
    affirmedWithoutEdit: changes.reduce((n, c) => n + c.affirmations.affirmedWithoutEdit, 0),
    changes,
  };
}

export function buildRollbacks(ctx: SectionContext, inRange: StoredEvent[]): EvidenceRollbacks {
  const groups = groupBy(inRange, 'rollbackId');
  const history = historyOf(ctx, ROLLBACK_TYPES, 'rollbackId', new Set(groups.keys()));
  const rollbacks: EvidenceRollback[] = [...groups].map(([rollbackId, events]) => {
    const r: EvidenceRollback = {
      rollbackId,
      projectId: null,
      targetRef: null,
      targetSha: null,
      changeId: null,
      branch: null,
      testsPassed: null,
      testsFailed: null,
      clean: null,
      decisionId: null,
      approverId: null,
      passkeyVerified: null,
      mainShaBefore: null,
      mainShaAfter: null,
      status: 'unknown',
      flags: [],
      events: events.map(refOf),
    };
    let approved = false;
    let executed = false;
    for (const e of history.get(rollbackId) ?? []) {
      switch (e.type) {
        case 'rollback.requested': {
          const m = metaOf(e, 'rollback.requested');
          Object.assign(r, {
            projectId: m.projectId,
            targetRef: m.targetRef,
            targetSha: m.targetSha,
            changeId: m.changeId,
            status: 'requested',
          });
          break;
        }
        case 'rollback.verification_started':
          Object.assign(r, {
            branch: metaOf(e, 'rollback.verification_started').branch,
            status: 'verifying',
          });
          break;
        case 'rollback.verified': {
          const m = metaOf(e, 'rollback.verified');
          Object.assign(r, {
            branch: m.branch,
            testsPassed: m.testsPassed,
            testsFailed: m.testsFailed,
            clean: m.clean,
            decisionId: m.decisionId ?? r.decisionId,
            status: m.clean ? 'verified' : 'verification_failed',
          });
          break;
        }
        case 'rollback.approved': {
          const m = metaOf(e, 'rollback.approved');
          Object.assign(r, {
            decisionId: m.decisionId,
            approverId: m.approverId,
            passkeyVerified: m.passkeyVerified,
            status: 'approved',
          });
          approved = true;
          break;
        }
        case 'rollback.rejected': {
          const m = metaOf(e, 'rollback.rejected');
          Object.assign(r, {
            decisionId: m.decisionId ?? r.decisionId,
            approverId: m.approverId,
            status: 'rejected',
          });
          break;
        }
        case 'rollback.executed': {
          const m = metaOf(e, 'rollback.executed');
          Object.assign(r, {
            mainShaBefore: m.mainShaBefore,
            mainShaAfter: m.mainShaAfter,
            status: 'executed',
          });
          executed = true;
          break;
        }
        case 'rollback.failed':
          // Approved but never executed: the default branch was left unchanged.
          r.status = 'failed';
          break;
      }
    }
    if (executed && r.clean !== true) r.flags.push('executed_without_clean_verification');
    if (approved && r.passkeyVerified === false) r.flags.push('approved_without_passkey');
    return r;
  });
  return {
    count: rollbacks.length,
    executed: rollbacks.filter((r) => r.status === 'executed').length,
    flagged: rollbacks.filter((r) => r.flags.length > 0).length,
    rollbacks,
  };
}

export function buildBreakglass(
  ctx: SectionContext,
  inRange: StoredEvent[],
  promotions: StoredEvent[],
): EvidenceBreakglassFile {
  const groups = groupBy(inRange, 'breakglassId');
  const history = historyOf(ctx, BREAKGLASS_TYPES, 'breakglassId', new Set(groups.keys()));
  const incidents: EvidenceBreakglass[] = [...groups].map(([breakglassId, events]) => {
    const b: EvidenceBreakglass = {
      breakglassId,
      projectId: null,
      invokedBy: null,
      ref: null,
      sha: null,
      decisionId: null,
      invokedAt: null,
      approverId: null,
      passkeyVerified: null,
      postIncident: null,
      flags: [],
      events: events.map(refOf),
    };
    for (const e of history.get(breakglassId) ?? []) {
      if (e.type === 'breakglass.invoked') {
        const m = metaOf(e, 'breakglass.invoked');
        Object.assign(b, {
          projectId: m.projectId,
          invokedBy: m.invokedBy,
          ref: m.ref,
          sha: m.sha,
          decisionId: m.decisionId,
          invokedAt: e.ts,
        });
      } else if (e.type === 'breakglass.approved') {
        const m = metaOf(e, 'breakglass.approved');
        Object.assign(b, {
          approverId: m.approverId,
          passkeyVerified: m.passkeyVerified,
          decisionId: m.decisionId,
        });
        b.postIncident = {
          changeId: m.postIncidentChangeId,
          dueAt: m.dueAt,
          completedAt: null,
          completedWithinDue: null,
        };
      }
    }
    return b;
  });
  // The mandatory post-incident change may complete after the range: report its state as of generation.
  const pending = new Map(incidents.filter((b) => b.postIncident).map((b) => [b.postIncident!.changeId, b]));
  if (pending.size) {
    for (const e of iterateEvents(ctx.store, { types: ['change.completed'], toSeq: ctx.headSeq })) {
      const b = pending.get(metaOf(e, 'change.completed').changeId);
      if (b?.postIncident && b.postIncident.completedAt === null) {
        b.postIncident.completedAt = e.ts;
        b.postIncident.completedWithinDue = Date.parse(e.ts) <= Date.parse(b.postIncident.dueAt);
      }
    }
  }
  for (const b of incidents) {
    const pi = b.postIncident;
    const overdue =
      history.get(b.breakglassId)?.some((e) => e.type === 'breakglass.post_incident_overdue') ||
      pi?.completedWithinDue === false ||
      (pi !== null && pi.completedAt === null && Date.parse(pi.dueAt) < Date.parse(ctx.generatedAt));
    if (b.passkeyVerified === false) b.flags.push('approved_without_passkey');
    if (overdue) b.flags.push('post_incident_overdue');
    if (pi && pi.completedAt === null) b.flags.push('post_incident_open');
  }
  return {
    count: incidents.length,
    flagged: incidents.filter((b) => b.flags.length > 0).length,
    incidents,
    breakglassPromotions: promotions.map(entryOf),
  };
}

export function buildCredits(inRange: StoredEvent[]): EvidenceCredits {
  const of = (type: string) => inRange.filter((e) => e.type === type).map(entryOf);
  const sum = (entries: EvidenceMetaEntry[]) =>
    round2(entries.reduce((n, x) => n + Number(x.meta.amountUsd ?? 0), 0));
  const c: EvidenceCredits = {
    allocations: of('credit.allocated'),
    capsReached: of('credit.cap_reached'),
    autoGrants: of('credit.auto_granted'),
    topupRequests: of('credit.topup_requested'),
    topupsGranted: of('credit.topup_granted'),
    topupsDenied: of('credit.topup_denied'),
    totals: { allocatedUsd: 0, autoGrantedUsd: 0, topupRequestedUsd: 0, topupGrantedUsd: 0 },
    flags: [],
  };
  c.totals = {
    allocatedUsd: sum(c.allocations),
    autoGrantedUsd: sum(c.autoGrants),
    topupRequestedUsd: sum(c.topupRequests),
    topupGrantedUsd: sum(c.topupsGranted),
  };
  for (const g of c.topupsGranted) {
    // Top-ups go to a human approver, never the requester (§10).
    if (g.meta.approverId === g.meta.userId)
      c.flags.push({ seq: g.seq, eventId: g.id, flag: 'self_granted_topup' });
  }
  const seen = new Set<string>();
  for (const g of c.autoGrants) {
    const key = `${String(g.meta.userId)}|${String(g.meta.period)}`;
    if (seen.has(key)) c.flags.push({ seq: g.seq, eventId: g.id, flag: 'repeat_auto_grant_in_period' });
    seen.add(key);
  }
  return c;
}

/** Daily USD/MYR rates for every date in range (latest record per date is in force), discrepancies and alerts. */
export function buildFx(ctx: SectionContext, carryAlerts: StoredEvent[]): EvidenceFx {
  const { from, to } = ctx.range;
  const inRange = (d: string) => d >= from && d <= to;
  const byDate = new Map<string, StoredEvent[]>();
  for (const e of iterateEvents(ctx.store, { types: ['fx.rate_recorded'], toSeq: ctx.headSeq })) {
    const d = metaOf(e, 'fx.rate_recorded').date;
    if (!inRange(d)) continue;
    const list = byDate.get(d) ?? [];
    list.push(e);
    byDate.set(d, list);
  }
  const days: EvidenceFxDay[] = datesBetween(from, to).map((date) => {
    const recs = byDate.get(date) ?? [];
    const last = recs.at(-1);
    if (!last) {
      return {
        date,
        rate: null,
        status: 'missing',
        sourceDate: null,
        extractor: null,
        validation: null,
        reason: null,
        records: 0,
        seq: null,
        eventId: null,
      };
    }
    const m = metaOf(last, 'fx.rate_recorded');
    return {
      date,
      rate: m.rate,
      status: m.status,
      sourceDate: m.sourceDate,
      extractor: m.extractor,
      validation: m.validation,
      reason: m.reason,
      records: recs.length,
      seq: last.seq,
      eventId: last.id,
    };
  });
  const discrepancies: EvidenceFxDiscrepancy[] = [];
  const byDecision = new Map<string, EvidenceFxDiscrepancy>();
  for (const e of iterateEvents(ctx.store, {
    types: ['fx.discrepancy_raised', 'fx.discrepancy_resolved'],
    toSeq: ctx.headSeq,
  })) {
    if (e.type === 'fx.discrepancy_raised') {
      const m = metaOf(e, 'fx.discrepancy_raised');
      if (!inRange(m.date)) continue;
      const d: EvidenceFxDiscrepancy = {
        date: m.date,
        scraped: m.scraped,
        official: m.official,
        decisionId: m.decisionId,
        raisedSeq: e.seq,
        raisedEventId: e.id,
        resolution: null,
      };
      discrepancies.push(d);
      byDecision.set(m.decisionId, d);
    } else {
      const m = metaOf(e, 'fx.discrepancy_resolved');
      const d = byDecision.get(m.decisionId);
      if (d) d.resolution = { chosenRate: m.chosenRate, seq: e.seq, eventId: e.id };
    }
  }
  const rates = days.flatMap((d) => (d.rate === null ? [] : [d.rate]));
  return {
    pair: 'USD/MYR',
    days,
    discrepancies,
    carryForwardAlerts: carryAlerts.map(entryOf),
    summary: {
      days: days.length,
      live: days.filter((d) => d.status === 'live').length,
      inherited: days.filter((d) => d.status === 'inherited').length,
      missing: days.filter((d) => d.status === 'missing').length,
      minRate: rates.length ? Math.min(...rates) : null,
      maxRate: rates.length ? Math.max(...rates) : null,
      discrepanciesRaised: discrepancies.length,
      discrepanciesResolved: discrepancies.filter((d) => d.resolution).length,
      carryForwardAlerts: carryAlerts.length,
    },
  };
}

/** Rate card in force on `to`: the latest published by the end of the range and effective on or before `to`. */
export function rateCardInForce(ctx: SectionContext): EvidencePackManifest['rateCard'] {
  let best: { e: StoredEvent; effectiveFrom: string; version: number; rateCount: number } | null = null;
  for (const e of iterateEvents(ctx.store, {
    types: ['ratecard.published'],
    toSeq: ctx.headSeq,
    toTs: ctx.endTsIncl,
  })) {
    const m = metaOf(e, 'ratecard.published');
    if (m.effectiveFrom > ctx.range.to) continue;
    if (
      !best ||
      m.effectiveFrom > best.effectiveFrom ||
      (m.effectiveFrom === best.effectiveFrom && m.version >= best.version)
    ) {
      best = { e, effectiveFrom: m.effectiveFrom, version: m.version, rateCount: m.rateCount };
    }
  }
  if (!best) return null;
  return {
    version: best.version,
    effectiveFrom: best.effectiveFrom,
    rateCount: best.rateCount,
    eventId: best.e.id,
    seq: best.e.seq,
    publishedAt: best.e.ts,
  };
}

/** Rate-card versions the daily rollups for dates in range were frozen with. */
export function rateCardVersionsUsed(ctx: SectionContext): number[] {
  const versions = new Set<number>();
  for (const e of iterateEvents(ctx.store, { types: ['rollup.closed'], toSeq: ctx.headSeq })) {
    const m = metaOf(e, 'rollup.closed');
    if (m.date >= ctx.range.from && m.date <= ctx.range.to) versions.add(m.rateCardVersion);
  }
  return [...versions].sort((a, b) => a - b);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
