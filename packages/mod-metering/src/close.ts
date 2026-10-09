/** Daily close: freeze every unclosed day before today into an immutable rollup.closed (R12). */
import type { MetaOf, PayloadOf, RollupBreakdownRow } from '@aoc/contracts';
import { addDays } from '@aoc/kernel';
import { AccMap } from './acc';
import { METERING_ACTOR, type MeteringModel } from './model';
import { METERING_BODY_SCOPE } from './projector';
import { round6 } from './stats';

const FROZEN_GROUPS = [
  ['byActor', 'actor'],
  ['byProject', 'project'],
  ['byModel', 'model'],
  ['byProcessType', 'processType'],
] as const;

/** Closes [first unclosed day, yesterday]. Idempotent: closed days are skipped and each close carries an idempotency key. */
export function closeDays(m: MeteringModel): string[] {
  const today = m.today();
  const wm = m.lastClosedDay();
  const first = wm ? addDays(wm, 1) : m.firstMeteredDay();
  const closed: string[] = [];
  if (!first) return closed;
  for (let d = first; d < today; d = addDays(d, 1)) {
    if (m.rollup(d)) continue;
    closeDay(m, d);
    closed.push(d);
  }
  return closed;
}

export function closeDay(m: MeteringModel, date: string): void {
  const fx = m.liveFx(date);
  const usage = (group: 'none' | (typeof FROZEN_GROUPS)[number][1]): AccMap => {
    const map = new AccMap();
    for (const r of m.usageAgg({ from: date, to: date, group })) map.at(r.k).addUsage(r, fx.rate);
    return map;
  };
  const total = usage('none').total();
  const groups = Object.fromEntries(FROZEN_GROUPS.map(([field, group]) => [field, usage(group)])) as Record<
    (typeof FROZEN_GROUPS)[number][0],
    AccMap
  >;

  const throttle = m.throttleCells({ from: date, to: date });
  const idleByOwner = new Map<string | null, { idleMs: number; hits: number }>();
  let idleMs = 0;
  let hits = 0;
  for (const c of throttle.cells) {
    idleMs += c.idleMs;
    hits += c.hits;
    const o = idleByOwner.get(c.ownerId) ?? { idleMs: 0, hits: 0 };
    o.idleMs += c.idleMs;
    o.hits += c.hits;
    idleByOwner.set(c.ownerId, o);
  }
  for (const owner of idleByOwner.keys()) groups.byActor.at(owner);

  const breakdown = (field: (typeof FROZEN_GROUPS)[number][0]): RollupBreakdownRow[] =>
    [...groups[field].entries()]
      .map(([key, acc]) => {
        const row = acc.toBreakdown(key);
        const t = field === 'byActor' ? idleByOwner.get(key) : undefined;
        return t ? { ...row, throttleIdleMs: Math.round(t.idleMs), throttleHits: t.hits } : row;
      })
      .sort((a, b) => ((a.key ?? '') < (b.key ?? '') ? -1 : (a.key ?? '') > (b.key ?? '') ? 1 : 0));

  const row = total.toRow();
  const meta: MetaOf<'rollup.closed'> = {
    date,
    usdNotional: row.notionalUsd,
    rmNotional: fx.rate === null ? 0 : round6(total.usd * fx.rate),
    fxRate: fx.rate ?? 0,
    fxStatus: fx.status,
    fxSourceDate: fx.sourceDate,
    fxSession: fx.session,
    rateCardVersion: m.cardOn(date)?.version ?? 0,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    cacheWrite5mTokens: row.cacheWrite5mTokens,
    cacheWrite1hTokens: row.cacheWrite1hTokens,
    messages: row.messages,
    unpricedTokens: row.unpricedTokens,
    throttleIdleMs: Math.round(idleMs),
    throttleHits: hits,
    subscriptionUsd: round6(m.subscriptionUsdOn(date)),
    closedAt: m.ctx.clock.iso(),
  };
  const payload: PayloadOf<'rollup.closed'> = {
    byActor: breakdown('byActor'),
    byProject: breakdown('byProject'),
    byModel: breakdown('byModel'),
    byProcessType: breakdown('byProcessType'),
    unpricedModels: row.unpricedModels,
    tierPricedModels: row.tierPricedModels,
  };
  m.ctx.store.append({
    type: 'rollup.closed',
    actor: METERING_ACTOR,
    meta,
    payload,
    source: 'scheduler',
    idempotencyKey: `metering:rollup:${date}`,
    bodyScope: METERING_BODY_SCOPE,
  });
}
