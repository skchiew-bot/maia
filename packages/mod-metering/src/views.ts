/**
 * DTO builders. Org-wide reads of closed days come from the frozen rollups (never recomputed, R12); open
 * days and per-user / per-task / per-session views read usage rows, whose cost was fixed at ingestion.
 */
import {
  NOTIONAL_COST_BASIS,
  NOTIONAL_COST_LABEL,
  type CostPerOutcomeDTO,
  type MeteringDailyDTO,
  type MeteringDayDTO,
  type MeteringDayStatus,
  type MeteringFxStamp,
  type MeteringGroupBy,
  type MeteringScope,
  type MeteringSessionDTO,
  type MeteringSubscriptionDTO,
  type MeteringSubscriptionVersionDTO,
  type MeteringSummaryDTO,
  type MeteringSummaryRow,
  type MeteringThrottleDTO,
  type MigrationRecommendationDTO,
  type OutcomeCostClassDTO,
  type OutcomeCostItemDTO,
  type RateCardDTO,
  type RateCardVersionDTO,
  type RateCardVersionsDTO,
} from '@aoc/contracts';
import { addDays } from '@aoc/kernel';
import { AccMap, CostAcc } from './acc';
import { DAYS_PER_MONTH, HOUR_MS, earliestEffectiveFrom, eachDay, minDate } from './dates';
import { recommendMigration, type MigrationAssumptionInput, type MigrationData } from './migration';
import {
  ALL_DAYS,
  type MeteringModel,
  type RateCardRecord,
  type RollupRecord,
  type SubscriptionRecord,
} from './model';
import { effectiveCard } from './pricing';
import { loadPricingCards } from './projector';
import { percentile, round2, round6 } from './stats';

export interface RangeQuery {
  from: string;
  to: string;
  scope: MeteringScope;
  /** Set for scope 'mine'. */
  ownerId: string | null;
}

const labels = () => ({ costBasis: NOTIONAL_COST_BASIS, costLabel: NOTIONAL_COST_LABEL });
/** Group key for closed days whose frozen breakdown body was crypto-shredded (ids never contain brackets). */
export const ERASED_KEY = '[erased]';

const FROZEN_FIELD: Partial<Record<MeteringGroupBy, 'byActor' | 'byProject' | 'byModel' | 'byProcessType'>> =
  {
    actor: 'byActor',
    project: 'byProject',
    model: 'byModel',
    processType: 'byProcessType',
  };

function dayStatus(
  date: string,
  today: string,
  first: string | null,
  rollups: Map<string, RollupRecord>,
): MeteringDayStatus {
  if (rollups.has(date)) return 'closed';
  if (date === today || (first !== null && date >= first)) return 'open';
  return 'unmetered';
}

/** Ascending by key; unknown (null) keys last. */
const byKey = (a: { key: string | null }, b: { key: string | null }): number => {
  if (a.key === b.key) return 0;
  if (a.key === null) return 1;
  if (b.key === null) return -1;
  return a.key < b.key ? -1 : 1;
};

/** Days of the range that have happened (future days are never reported). */
function rangeDays(m: MeteringModel, q: { from: string; to: string }) {
  const today = m.today();
  const last = minDate(q.to, today);
  return {
    today,
    last,
    days: eachDay(q.from, last),
    rollups: m.rollupsBetween(q.from, last),
    first: m.firstMeteredDay(),
  };
}

export function buildSummary(
  m: MeteringModel,
  q: RangeQuery & { groupBy: MeteringGroupBy },
): MeteringSummaryDTO {
  const { today, last, days, rollups, first } = rangeDays(m, q);
  const field = q.scope === 'org' ? FROZEN_FIELD[q.groupBy] : undefined;
  const groups = new AccMap();
  const frozenDays = new Set<string>();
  const fxMissing = new Set<string>();
  if (field) {
    for (const [date, r] of rollups) {
      frozenDays.add(date);
      if (r.fx.rate === null && r.usd > 0) fxMissing.add(date);
      if (r.breakdown) for (const entry of r.breakdown[field]) groups.at(entry.key).addFrozen(entry);
      // Breakdown crypto-shredded: the chained meta still holds the frozen day totals.
      else groups.at(ERASED_KEY).add({ ...r, unpricedModels: [], tierPricedModels: [] });
    }
  }
  const fx = new Map(days.map((d) => [d, m.fxStamp(d, rollups)]));
  for (const r of m.usageAgg({ from: q.from, to: last, group: q.groupBy, ownerId: q.ownerId })) {
    if (frozenDays.has(r.date)) continue;
    const rate = fx.get(r.date)?.rate ?? null;
    if (rate === null && r.usd > 0) fxMissing.add(r.date);
    groups.at(r.k).addUsage(r, rate);
  }
  const label = (key: string | null) =>
    key === ERASED_KEY ? ERASED_KEY : q.groupBy === 'actor' ? m.userName(key) : null;
  const rows: MeteringSummaryRow[] = [...groups].map(([key, acc]) => ({
    key,
    label: label(key),
    ...acc.toRow(),
  }));
  // People are listed by id, never ranked by spend; other dimensions are ordered by notional cost.
  rows.sort(q.groupBy === 'actor' ? byKey : (a, b) => b.notionalUsd - a.notionalUsd || byKey(a, b));

  let subscription: MeteringSummaryDTO['subscription'] = null;
  if (q.scope === 'org') {
    const subs = m.subscriptions();
    let usd = 0;
    let rm = 0;
    let rmMissing = false;
    for (const d of days) {
      const dayUsd = rollups.get(d)?.subscriptionUsd ?? m.subscriptionUsdOn(d, subs);
      const rate = fx.get(d)?.rate ?? null;
      usd += dayUsd;
      if (rate === null) rmMissing ||= dayUsd > 0;
      else rm += dayUsd * rate;
    }
    subscription = { usd: round6(usd), rm: rmMissing ? null : round6(rm) };
  }
  const statuses = days.map((d) => dayStatus(d, today, first, rollups));
  return {
    ...labels(),
    scope: q.scope,
    groupBy: q.groupBy,
    from: q.from,
    to: q.to,
    rows,
    totals: groups.total().toRow(),
    closedDays: statuses.filter((s) => s === 'closed').length,
    openDays: statuses.filter((s) => s === 'open').length,
    fxMissingDays: [...fxMissing].sort(),
    subscription,
    generatedAt: m.ctx.clock.iso(),
  };
}

export function buildDaily(m: MeteringModel, q: RangeQuery): MeteringDailyDTO {
  const { today, last, days, rollups, first } = rangeDays(m, q);
  const subs = q.scope === 'org' ? m.subscriptions() : null;
  const cards = loadPricingCards(m.db);
  const liveUsage = new Map(
    m.usageAgg({ from: q.from, to: last, group: 'none', ownerId: q.ownerId }).map((r) => [r.date, r]),
  );
  const liveThrottle = new Map<string, { idleMs: number; hits: number }>();
  for (const c of m.throttleCells({ from: q.from, to: last, ownerId: q.ownerId }).cells) {
    const t = liveThrottle.get(c.date) ?? { idleMs: 0, hits: 0 };
    t.idleMs += c.idleMs;
    t.hits += c.hits;
    liveThrottle.set(c.date, t);
  }
  const total = new CostAcc();
  let idleTotal = 0;
  let hitsTotal = 0;
  let subTotal = 0;
  const out: MeteringDayDTO[] = days.map((date) => {
    const r = rollups.get(date);
    const acc = new CostAcc();
    let fx: MeteringFxStamp;
    let throttle: { idleMs: number; hits: number };
    let sub: number | null;
    if (r && q.scope === 'org') {
      fx = r.fx;
      acc.add({
        ...r,
        unpricedModels: r.breakdown?.unpricedModels ?? [],
        tierPricedModels: r.breakdown?.tierPricedModels ?? [],
      });
      throttle = { idleMs: r.throttleIdleMs, hits: r.throttleHits };
      sub = r.subscriptionUsd;
    } else {
      fx = r ? r.fx : m.liveFx(date);
      const row = liveUsage.get(date);
      if (row) acc.addUsage(row, fx.rate);
      throttle = liveThrottle.get(date) ?? { idleMs: 0, hits: 0 };
      sub = subs ? m.subscriptionUsdOn(date, subs) : null;
    }
    total.merge(acc);
    idleTotal += throttle.idleMs;
    hitsTotal += throttle.hits;
    subTotal += sub ?? 0;
    return {
      date,
      status: dayStatus(date, today, first, rollups),
      fx,
      rateCardVersion: r?.rateCardVersion ?? effectiveCard(cards, date)?.version ?? 0,
      throttleIdleMs: Math.round(throttle.idleMs),
      throttleHits: throttle.hits,
      subscriptionUsd: sub === null ? null : round6(sub),
      closedAt: r?.closedAt ?? null,
      ...acc.toRow(),
    };
  });
  return {
    ...labels(),
    scope: q.scope,
    from: q.from,
    to: q.to,
    days: out,
    totals: {
      ...total.toRow(),
      throttleIdleMs: Math.round(idleTotal),
      throttleHits: hitsTotal,
      subscriptionUsd: subs ? round6(subTotal) : null,
    },
    lastClosedDay: m.lastClosedDay(),
    generatedAt: m.ctx.clock.iso(),
  };
}

export function buildThrottle(m: MeteringModel, q: RangeQuery): MeteringThrottleDTO {
  const { today, last, days, rollups, first } = rangeDays(m, q);
  const { cells, openSessions } = m.throttleCells({ from: q.from, to: last, ownerId: q.ownerId });
  const frozen = (d: string) => (q.scope === 'org' ? rollups.get(d) : undefined);
  type Tally = { idleMs: number; hits: number };
  const tally = <K>(map: Map<K, Tally>, key: K, idleMs: number, hits: number) => {
    const t = map.get(key) ?? { idleMs: 0, hits: 0 };
    t.idleMs += idleMs;
    t.hits += hits;
    map.set(key, t);
  };
  const liveDays = new Map<string, Tally>();
  const sessions = new Map<string, Tally & { ownerId: string | null; projectId: string | null }>();
  const owners = new Map<string | null, Tally>();
  const frozenOwnerDays = new Set<string>();
  for (const [date, r] of rollups) {
    if (!frozen(date) || !r.breakdown) continue;
    frozenOwnerDays.add(date);
    for (const e of r.breakdown.byActor)
      if (e.throttleIdleMs || e.throttleHits)
        tally(owners, e.key, e.throttleIdleMs ?? 0, e.throttleHits ?? 0);
  }
  for (const c of cells) {
    tally(liveDays, c.date, c.idleMs, c.hits);
    if (!sessions.has(c.sessionId))
      sessions.set(c.sessionId, { idleMs: 0, hits: 0, ownerId: c.ownerId, projectId: c.projectId });
    tally(sessions, c.sessionId, c.idleMs, c.hits);
    if (!frozenOwnerDays.has(c.date)) tally(owners, c.ownerId, c.idleMs, c.hits);
  }
  const hours = (ms: number) => round2(ms / HOUR_MS);
  const dayRows = days.map((date) => {
    const r = frozen(date);
    const t = r
      ? { idleMs: r.throttleIdleMs, hits: r.throttleHits }
      : (liveDays.get(date) ?? { idleMs: 0, hits: 0 });
    return {
      date,
      status: dayStatus(date, today, first, rollups),
      hits: t.hits,
      idleMs: Math.round(t.idleMs),
      idleHours: hours(t.idleMs),
    };
  });
  const idleMs = dayRows.reduce((s, d) => s + d.idleMs, 0);
  return {
    scope: q.scope,
    from: q.from,
    to: q.to,
    days: dayRows,
    bySession: [...sessions]
      .map(([sessionId, t]) => ({
        sessionId,
        ownerId: t.ownerId,
        projectId: t.projectId,
        hits: t.hits,
        idleMs: Math.round(t.idleMs),
        idleHours: hours(t.idleMs),
        throttledNow: openSessions.has(sessionId),
      }))
      .sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1)),
    byOwner: [...owners]
      .sort(([a], [b]) => byKey({ key: a }, { key: b }))
      .map(([ownerId, t]) => ({
        ownerId,
        ownerName: m.userName(ownerId),
        hits: t.hits,
        idleMs: Math.round(t.idleMs),
        idleHours: hours(t.idleMs),
      })),
    totals: {
      hits: dayRows.reduce((s, d) => s + d.hits, 0),
      idleMs,
      idleHours: hours(idleMs),
      throttledNow: openSessions.size,
    },
    generatedAt: m.ctx.clock.iso(),
  };
}

export function buildSession(m: MeteringModel, sessionId: string): MeteringSessionDTO | null {
  const rec = m.sessionRecord(sessionId);
  if (!rec) return null;
  const q = { ...ALL_DAYS, sessionId };
  const fxCache = new Map<string, number | null>();
  const fxRate = (date: string) => {
    if (!fxCache.has(date)) fxCache.set(date, m.fxStamp(date).rate);
    return fxCache.get(date)!;
  };
  const grouped = (group: 'model' | 'task' | 'none'): AccMap => {
    const map = new AccMap();
    for (const r of m.usageAgg({ ...q, group }))
      map.at(group === 'none' ? r.date : r.k).addUsage(r, fxRate(r.date));
    return map;
  };
  const rowsOf = (map: AccMap): MeteringSummaryRow[] =>
    [...map].map(([key, acc]) => ({ key, label: null, ...acc.toRow() }));
  const byDay = grouped('none');
  const t = m.sessionThrottle(sessionId);
  return {
    ...labels(),
    ...rec,
    totals: byDay.total().toRow(),
    byModel: rowsOf(grouped('model')).sort((a, b) => b.notionalUsd - a.notionalUsd || byKey(a, b)),
    byTask: rowsOf(grouped('task')).sort(byKey),
    byDay: [...byDay]
      .map(([date, acc]) => ({ date: date as string, ...acc.toRow() }))
      .sort((a, b) => (a.date < b.date ? -1 : 1)),
    throttle: {
      hits: t.hits,
      idleMs: Math.round(t.idleMs),
      idleHours: round2(t.idleMs / HOUR_MS),
      throttledNow: t.throttledNow,
    },
    generatedAt: m.ctx.clock.iso(),
  };
}

function outcomeClass(kind: OutcomeCostClassDTO['kind'], items: OutcomeCostItemDTO[]): OutcomeCostClassDTO {
  const costs = items.map((i) => i.notionalUsd);
  const total = costs.reduce((s, c) => s + c, 0);
  const r = (v: number | null) => (v === null ? null : round6(v));
  return {
    kind,
    stats: {
      count: costs.length,
      totalUsd: round6(total),
      meanUsd: costs.length ? round6(total / costs.length) : null,
      medianUsd: r(percentile(costs, 0.5)),
      p90Usd: r(percentile(costs, 0.9)),
      minUsd: costs.length ? round6(Math.min(...costs)) : null,
      maxUsd: costs.length ? round6(Math.max(...costs)) : null,
    },
    items,
  };
}

/** Portfolio lens only: spend per outcome, never per person (§14) — no actor/owner field is ever produced here. */
export function buildCostPerOutcome(m: MeteringModel, q: { from: string; to: string }): CostPerOutcomeDTO {
  const items: Record<'ticket' | 'change' | 'phase', OutcomeCostItemDTO[]> = {
    ticket: [],
    change: [],
    phase: [],
  };
  for (const o of m.outcomes(q.from, q.to)) {
    if (o.kind === 'phase') {
      const projectId = o.projectId ?? '';
      const u = m.phaseUsage(projectId, o.refId.slice(projectId.length + 1));
      items.phase.push({
        refId: o.refId,
        projectId: o.projectId,
        completedAt: o.completedAt,
        notionalUsd: round6(u.usd),
        sessions: u.sessions,
        unpriced: u.unpriced,
      });
      continue;
    }
    let usd = 0;
    let unpriced = false;
    const projects = new Set<string>();
    const links = m.linkedSessions(o.kind, o.refId);
    for (const l of links) {
      const s = m.sessionUsage(l.sessionId);
      usd += s.usd * l.share;
      unpriced ||= s.unpriced;
      if (s.projectId) projects.add(s.projectId);
    }
    items[o.kind].push({
      refId: o.refId,
      projectId: projects.size === 1 ? [...projects][0]! : null,
      completedAt: o.completedAt,
      notionalUsd: round6(usd),
      sessions: links.length,
      unpriced,
    });
  }
  return {
    ...labels(),
    lens: 'portfolio',
    notice: 'Portfolio lens only — spend per outcome, never a ranking of individuals.',
    from: q.from,
    to: q.to,
    ticketsFixed: outcomeClass('ticket_fixed', items.ticket),
    changesShipped: outcomeClass('change_shipped', items.change),
    phasesCompleted: outcomeClass('phase_completed', items.phase),
    method: {
      attribution:
        'Tickets: lifetime notional spend of sessions launched for, triaging or building the ticket. Changes: sessions that drafted, started or built the change. ' +
        'A session linked to several tickets (or changes) is split evenly between them. Phases: usage attributed to the phase’s tasks plus unattributed usage of sessions launched into the phase.',
      window:
        'Outcomes completed (ticket closed as fixed, change completed, phase completed) on a local date within from..to; their spend may predate the window.',
      percentile: 'Median and p90 by linear interpolation between closest ranks (type 7).',
    },
    generatedAt: m.ctx.clock.iso(),
  };
}

export function migrationData(m: MeteringModel): MigrationData {
  const today = m.today();
  const daily = buildDaily(m, {
    from: addDays(today, -90),
    to: addDays(today, -1),
    scope: 'org',
    ownerId: null,
  });
  const first = m.firstMeteredDay();
  const runRate = (windowDays: number, pick: (d: MeteringDayDTO) => number) => {
    const window = daily.days.filter((d) => d.date >= addDays(today, -windowDays));
    const coveredDays = first ? window.filter((d) => d.date >= first).length : 0;
    const total = window.reduce((s, d) => s + pick(d), 0);
    return {
      windowDays,
      coveredDays,
      total: round2(total),
      monthly: coveredDays ? round2((total / coveredDays) * DAYS_PER_MONTH) : 0,
    };
  };
  const sub = m.subscriptionOn(today);
  return {
    notionalUsd30d: runRate(30, (d) => d.notionalUsd),
    notionalUsd90d: runRate(90, (d) => d.notionalUsd),
    throttleIdleHours30d: runRate(30, (d) => d.throttleIdleMs / HOUR_MS),
    throttleIdleHours90d: runRate(90, (d) => d.throttleIdleMs / HOUR_MS),
    subscriptionMonthlyUsd: sub ? round2(sub.seats * sub.monthlyUsdPerSeat) : 0,
    subscriptionSeats: sub?.seats ?? 0,
  };
}

export function buildMigration(
  m: MeteringModel,
  data: MigrationData,
  input: MigrationAssumptionInput,
): MigrationRecommendationDTO {
  const today = m.today();
  const fx = m.liveFx(today);
  return {
    ...labels(),
    asOf: today,
    inputs: data,
    fx,
    ...recommendMigration(data, input, fx.rate),
    generatedAt: m.ctx.clock.iso(),
  };
}

function cardStatus(
  card: RateCardRecord,
  cards: RateCardRecord[],
  today: string,
): RateCardVersionDTO['status'] {
  if (effectiveCard(cards, today)?.version === card.version) return 'active';
  if (card.effectiveFrom > today && effectiveCard(cards, card.effectiveFrom)?.version === card.version)
    return 'scheduled';
  return 'superseded';
}

function rateCardVersionDto(
  card: RateCardRecord,
  cards: RateCardRecord[],
  today: string,
): RateCardVersionDTO {
  return {
    version: card.version,
    effectiveFrom: card.effectiveFrom,
    status: cardStatus(card, cards, today),
    currency: 'USD',
    rates: card.rates ?? [],
    tierFallback: card.tierFallback,
    note: card.note,
    ratesHash: card.ratesHash,
    publishedAt: card.publishedAt,
    publishedBy: card.publishedBy,
    erased: card.rates === null,
  };
}

export function buildRateCard(m: MeteringModel): RateCardDTO {
  const today = m.today();
  const cards = m.rateCards();
  const versions = cards.map((c) => rateCardVersionDto(c, cards, today));
  const lastClosed = m.lastClosedDay();
  return {
    ...labels(),
    today,
    active: versions.find((v) => v.status === 'active') ?? null,
    scheduled: versions
      .filter((v) => v.status === 'scheduled')
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1)),
    lastClosedDay: lastClosed,
    earliestEffectiveFrom: earliestEffectiveFrom(today, lastClosed),
  };
}

export function buildRateCardVersions(m: MeteringModel): RateCardVersionsDTO {
  const today = m.today();
  const cards = m.rateCards();
  return { versions: cards.map((c) => rateCardVersionDto(c, cards, today)).reverse() };
}

export function rateCardVersion(m: MeteringModel, version: number): RateCardVersionDTO | null {
  return buildRateCardVersions(m).versions.find((v) => v.version === version) ?? null;
}

export function buildSubscription(m: MeteringModel): MeteringSubscriptionDTO {
  const today = m.today();
  const subs = m.subscriptions();
  const active = m.subscriptionOn(today, subs);
  const dto = (s: SubscriptionRecord): MeteringSubscriptionVersionDTO => ({
    plan: s.plan,
    seats: s.seats,
    monthlyUsdPerSeat: s.monthlyUsdPerSeat,
    monthlyUsd: round6(s.seats * s.monthlyUsdPerSeat),
    effectiveFrom: s.effectiveFrom,
    status:
      s.seq === active?.seq
        ? 'active'
        : s.effectiveFrom > today && m.subscriptionOn(s.effectiveFrom, subs)?.seq === s.seq
          ? 'scheduled'
          : 'superseded',
    updatedAt: s.updatedAt,
    updatedBy: s.updatedBy,
  });
  const all = subs.map(dto);
  return {
    basis: 'actual_subscription',
    note: 'Actual plan spend (prorated per day), shown separately from the notional API-equivalent cost.',
    today,
    active: active ? dto(active) : null,
    dailyUsdToday: round6(m.subscriptionUsdOn(today, subs)),
    scheduled: all.filter((s) => s.status === 'scheduled'),
    history: [...all].reverse(),
  };
}
