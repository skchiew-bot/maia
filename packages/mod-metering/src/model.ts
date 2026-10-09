/** Metering read model over the mtr_* projection, plus the events metering itself appends. */
import type { DatabaseSync } from 'node:sqlite';
import type {
  Actor,
  MeteringFxStamp,
  MeteringGroupBy,
  ModelTier,
  PayloadOf,
  RateCardRate,
} from '@aoc/contracts';
import { addDays, canonicalJson, localDate, sha256hex, type ModuleContext } from '@aoc/kernel';
import type { UsageAggRow } from './acc';
import { daysInMonth, localDayStartMs, splitByLocalDay } from './dates';
import { effectiveCard, type PricingCard } from './pricing';
import { lastClosedDay, loadPricingCards, METERING_BODY_SCOPE } from './projector';

export const METERING_ACTOR: Actor = { kind: 'system', id: 'metering' };
/** Date bounds spanning every booked day (session lifetime queries). */
export const ALL_DAYS = { from: '0000-01-01', to: '9999-12-31' } as const;

export interface RateCardRecord {
  version: number;
  effectiveFrom: string;
  rates: RateCardRate[] | null;
  tierFallback: Partial<Record<ModelTier, string>>;
  note: string | null;
  ratesHash: string;
  publishedAt: string;
  publishedBy: string;
}

export interface SubscriptionRecord {
  seq: number;
  effectiveFrom: string;
  plan: string;
  seats: number;
  monthlyUsdPerSeat: number;
  updatedAt: string;
  updatedBy: string;
}

export interface RollupRecord {
  date: string;
  closedAt: string;
  usd: number;
  /** null when FX was missing at close. */
  rm: number | null;
  fx: MeteringFxStamp;
  rateCardVersion: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  messages: number;
  unpricedTokens: number;
  throttleIdleMs: number;
  throttleHits: number;
  subscriptionUsd: number;
  /** Frozen breakdowns; null when the body was crypto-shredded. */
  breakdown: PayloadOf<'rollup.closed'> | null;
}

/** Throttle hits / idle per (local date, session). */
export interface ThrottleCell {
  date: string;
  sessionId: string;
  ownerId: string | null;
  projectId: string | null;
  idleMs: number;
  hits: number;
}

export interface SessionRecord {
  sessionId: string;
  ownerId: string | null;
  projectId: string | null;
  processType: string | null;
  ticketId: string | null;
}

const GROUP_EXPR: Record<MeteringGroupBy | 'none', string> = {
  actor: 'owner_id',
  project: 'project_id',
  model: 'model',
  processType: 'process_type',
  session: 'session_id',
  task: "CASE WHEN task_id IS NULL THEN NULL ELSE COALESCE(task_project_id, project_id, '') || '/' || task_id END",
  none: 'NULL',
};

interface RollupDbRow {
  date: string;
  closed_at: string;
  usd: number;
  rm: number;
  fx_rate: number;
  fx_status: MeteringFxStamp['status'];
  fx_source_date: string | null;
  rate_card_version: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
  messages: number;
  unpriced_tokens: number;
  throttle_idle_ms: number;
  throttle_hits: number;
  subscription_usd: number;
  breakdown_json: string | null;
}

function toRollup(r: RollupDbRow): RollupRecord {
  const missing = r.fx_status === 'missing';
  return {
    date: r.date,
    closedAt: r.closed_at,
    usd: r.usd,
    rm: missing ? null : r.rm,
    fx: { rate: missing ? null : r.fx_rate, status: r.fx_status, sourceDate: r.fx_source_date },
    rateCardVersion: r.rate_card_version,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheWrite5mTokens: r.cache_write_5m_tokens,
    cacheWrite1hTokens: r.cache_write_1h_tokens,
    messages: r.messages,
    unpricedTokens: r.unpriced_tokens,
    throttleIdleMs: r.throttle_idle_ms,
    throttleHits: r.throttle_hits,
    subscriptionUsd: r.subscription_usd,
    breakdown: r.breakdown_json ? (JSON.parse(r.breakdown_json) as PayloadOf<'rollup.closed'>) : null,
  };
}

/** Effective-dated pick: greatest effectiveFrom ≤ date, newest entry on a tie. */
function effectiveSubscription(subs: SubscriptionRecord[], date: string): SubscriptionRecord | null {
  let best: SubscriptionRecord | null = null;
  for (const s of subs) {
    if (s.effectiveFrom > date) continue;
    if (
      !best ||
      s.effectiveFrom > best.effectiveFrom ||
      (s.effectiveFrom === best.effectiveFrom && s.seq > best.seq)
    )
      best = s;
  }
  return best;
}

export class MeteringModel {
  constructor(readonly ctx: ModuleContext) {}

  get db(): DatabaseSync {
    return this.ctx.db;
  }
  get tz(): string {
    return this.ctx.config.timezone;
  }
  now(): number {
    return this.ctx.clock.now();
  }
  today(): string {
    return localDate(this.now(), this.tz);
  }

  // ── rate cards ───────────────────────────────────────────────────────────
  rateCards(): RateCardRecord[] {
    const rows = this.db.prepare('SELECT * FROM mtr_ratecards ORDER BY version').all() as unknown as {
      version: number;
      effective_from: string;
      rates_json: string | null;
      tier_fallback_json: string | null;
      note: string | null;
      rates_hash: string;
      published_at: string;
      published_by: string;
    }[];
    return rows.map((r) => ({
      version: r.version,
      effectiveFrom: r.effective_from,
      rates: r.rates_json ? (JSON.parse(r.rates_json) as RateCardRate[]) : null,
      tierFallback: r.tier_fallback_json
        ? (JSON.parse(r.tier_fallback_json) as Partial<Record<ModelTier, string>>)
        : {},
      note: r.note,
      ratesHash: r.rates_hash,
      publishedAt: r.published_at,
      publishedBy: r.published_by,
    }));
  }

  cardOn(date: string): PricingCard | null {
    return effectiveCard(loadPricingCards(this.db), date);
  }

  hasPublishedRateCard(): boolean {
    return this.ctx.store.list({ types: ['ratecard.published'], limit: 1 }).length > 0;
  }

  publishRateCard(
    input: {
      effectiveFrom: string;
      rates: RateCardRate[];
      tierFallback: Partial<Record<ModelTier, string>>;
      note?: string | null;
    },
    actor: Actor,
    source: 'api' | 'system',
  ): number {
    const last = this.db.prepare('SELECT MAX(version) AS v FROM mtr_ratecards').get() as { v: number | null };
    const version = (last.v ?? 0) + 1;
    const rates = input.rates.map((r) => ({
      model: r.model,
      inputPerMTok: r.inputPerMTok,
      outputPerMTok: r.outputPerMTok,
      cacheReadPerMTok: r.cacheReadPerMTok,
      cacheWrite5mPerMTok: r.cacheWrite5mPerMTok,
      cacheWrite1hPerMTok: r.cacheWrite1hPerMTok,
    }));
    const ratesHash = sha256hex(
      canonicalJson([...rates].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0))),
    );
    this.ctx.store.append({
      type: 'ratecard.published',
      actor,
      meta: { version, effectiveFrom: input.effectiveFrom, rateCount: rates.length, ratesHash },
      payload: { rates, tierFallback: input.tierFallback, ...(input.note ? { note: input.note } : {}) },
      source,
      bodyScope: METERING_BODY_SCOPE,
      // The seeded v1 must never be published twice, even if the projection is being rebuilt.
      idempotencyKey: source === 'system' && version === 1 ? 'metering:ratecard:v1' : undefined,
    });
    return version;
  }

  // ── subscription (actual spend, shown apart from notional cost) ──────────
  subscriptions(): SubscriptionRecord[] {
    const rows = this.db.prepare('SELECT * FROM mtr_subscriptions ORDER BY seq').all() as unknown as {
      seq: number;
      effective_from: string;
      plan: string;
      seats: number;
      monthly_usd_per_seat: number;
      updated_at: string;
      updated_by: string;
    }[];
    return rows.map((r) => ({
      seq: r.seq,
      effectiveFrom: r.effective_from,
      plan: r.plan,
      seats: r.seats,
      monthlyUsdPerSeat: r.monthly_usd_per_seat,
      updatedAt: r.updated_at,
      updatedBy: r.updated_by,
    }));
  }

  subscriptionOn(date: string, subs: SubscriptionRecord[] = this.subscriptions()): SubscriptionRecord | null {
    return effectiveSubscription(subs, date);
  }

  /** Monthly subscription prorated over the days of that month. */
  subscriptionUsdOn(date: string, subs: SubscriptionRecord[] = this.subscriptions()): number {
    const s = effectiveSubscription(subs, date);
    return s ? (s.seats * s.monthlyUsdPerSeat) / daysInMonth(date) : 0;
  }

  updateSubscription(
    input: { plan: string; seats: number; monthlyUsdPerSeat: number; effectiveFrom: string },
    actor: Actor,
    source: 'api' | 'system',
    idempotencyKey?: string,
  ): void {
    this.ctx.store.append({
      type: 'subscription.updated',
      actor,
      meta: { ...input },
      source,
      idempotencyKey,
    });
  }

  // ── rollups ──────────────────────────────────────────────────────────────
  lastClosedDay(): string | null {
    return lastClosedDay(this.db);
  }

  rollup(date: string): RollupRecord | null {
    const r = this.db.prepare('SELECT * FROM mtr_rollups WHERE date = ?').get(date) as
      RollupDbRow | undefined;
    return r ? toRollup(r) : null;
  }

  rollupsBetween(from: string, to: string): Map<string, RollupRecord> {
    const rows = this.db
      .prepare('SELECT * FROM mtr_rollups WHERE date >= ? AND date <= ? ORDER BY date')
      .all(from, to) as unknown as RollupDbRow[];
    return new Map(rows.map((r) => [r.date, toRollup(r)]));
  }

  /** First day metering covers: the day the first rate card was published, or earlier booked usage. */
  firstMeteredDay(): string | null {
    const card = this.db.prepare('SELECT MIN(published_at) AS t FROM mtr_ratecards').get() as {
      t: string | null;
    };
    const usage = this.db.prepare('SELECT MIN(date) AS d FROM mtr_usage').get() as { d: string | null };
    const days = [card.t ? localDate(Date.parse(card.t), this.tz) : null, usage.d].filter(
      (d): d is string => d !== null,
    );
    return days.length ? days.reduce((a, b) => (a < b ? a : b)) : null;
  }

  // ── FX ───────────────────────────────────────────────────────────────────
  /** Today's view of a date's USD→MYR from the fx service (absent service or no rate → missing). */
  liveFx(date: string): MeteringFxStamp {
    let r: { rate: number; status: 'live' | 'inherited'; sourceDate: string } | null = null;
    try {
      r = this.ctx.services.maybe('fx')?.rateFor(date) ?? null;
    } catch (err) {
      this.ctx.log.warn('fx lookup failed', { date, err: String(err) });
    }
    return r && Number.isFinite(r.rate) && r.rate > 0
      ? { rate: r.rate, status: r.status, sourceDate: r.sourceDate }
      : { rate: null, status: 'missing', sourceDate: null };
  }

  /** Closed days keep the FX stamped at close; open days ask the fx service. */
  fxStamp(date: string, rollups?: Map<string, RollupRecord>): MeteringFxStamp {
    const r = rollups ? rollups.get(date) : this.rollup(date);
    return r ? r.fx : this.liveFx(date);
  }

  userName(id: string | null): string | null {
    if (!id) return null;
    try {
      return this.ctx.services.maybe('identity')?.getUser(id)?.name ?? null;
    } catch {
      return null;
    }
  }

  // ── usage ────────────────────────────────────────────────────────────────
  usageAgg(q: {
    from: string;
    to: string;
    group: MeteringGroupBy | 'none';
    ownerId?: string | null;
    sessionId?: string | null;
  }): UsageAggRow[] {
    const where = ['date >= ?', 'date <= ?'];
    const args: string[] = [q.from, q.to];
    if (q.ownerId) (where.push('owner_id = ?'), args.push(q.ownerId));
    if (q.sessionId) (where.push('session_id = ?'), args.push(q.sessionId));
    const sql = `SELECT date, ${GROUP_EXPR[q.group]} AS k,
        SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read,
        SUM(cache_write_5m_tokens) AS cw5m, SUM(cache_write_1h_tokens) AS cw1h, SUM(messages) AS messages, SUM(cost_usd) AS usd,
        SUM(CASE WHEN priced_by = 'unpriced' THEN input_tokens + output_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens ELSE 0 END) AS unpriced_tokens,
        GROUP_CONCAT(CASE WHEN priced_by = 'unpriced' THEN model END, char(31)) AS unpriced_models,
        GROUP_CONCAT(CASE WHEN priced_by = 'tier' THEN model END, char(31)) AS tier_models
      FROM mtr_usage WHERE ${where.join(' AND ')} GROUP BY date, k ORDER BY date`;
    return this.db.prepare(sql).all(...args) as unknown as UsageAggRow[];
  }

  sessionCostUsd(sessionId: string): number {
    return (
      this.db
        .prepare('SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM mtr_usage WHERE session_id = ?')
        .get(sessionId) as { usd: number }
    ).usd;
  }

  sessionRecord(sessionId: string): SessionRecord | null {
    const row = this.db
      .prepare('SELECT owner_id, project_id, process_type, ticket_id FROM mtr_sessions WHERE session_id = ?')
      .get(sessionId) as
      | {
          owner_id: string | null;
          project_id: string | null;
          process_type: string | null;
          ticket_id: string | null;
        }
      | undefined;
    const used = this.db
      .prepare(
        'SELECT owner_id, project_id, process_type FROM mtr_usage WHERE session_id = ? ORDER BY seq DESC LIMIT 1',
      )
      .get(sessionId) as
      { owner_id: string | null; project_id: string | null; process_type: string | null } | undefined;
    const info = this.ctx.services.maybe('sessions')?.get(sessionId) ?? null;
    if (!row && !used && !info) return null;
    const ticket = this.db
      .prepare(
        "SELECT ref_id FROM mtr_session_links WHERE session_id = ? AND kind = 'ticket' ORDER BY linked_at LIMIT 1",
      )
      .get(sessionId) as { ref_id: string } | undefined;
    return {
      sessionId,
      ownerId: row?.owner_id ?? used?.owner_id ?? info?.ownerId ?? null,
      projectId: row?.project_id ?? used?.project_id ?? info?.projectId ?? null,
      processType: row?.process_type ?? used?.process_type ?? info?.processType ?? null,
      ticketId: row?.ticket_id ?? ticket?.ref_id ?? info?.ticketId ?? null,
    };
  }

  // ── throttle ─────────────────────────────────────────────────────────────
  /** Idle per local day from throttle intervals (open throttles count up to now) plus hits per day. */
  throttleCells(q: { from: string; to: string; ownerId?: string | null; sessionId?: string | null }): {
    cells: ThrottleCell[];
    openSessions: Set<string>;
  } {
    const now = this.now();
    const startMs = localDayStartMs(q.from, this.tz);
    const endMs = Math.min(localDayStartMs(addDays(q.to, 1), this.tz), now);
    const filters: string[] = [];
    const args: string[] = [];
    if (q.ownerId) (filters.push('owner_id = ?'), args.push(q.ownerId));
    if (q.sessionId) (filters.push('session_id = ?'), args.push(q.sessionId));
    const extra = filters.map((f) => ` AND ${f}`).join('');
    const cells = new Map<string, ThrottleCell>();
    const cell = (
      date: string,
      sessionId: string,
      ownerId: string | null,
      projectId: string | null,
    ): ThrottleCell => {
      const key = `${date}|${sessionId}`;
      let c = cells.get(key);
      if (!c) cells.set(key, (c = { date, sessionId, ownerId, projectId, idleMs: 0, hits: 0 }));
      return c;
    };
    const intervals = this.db
      .prepare(
        `SELECT session_id, owner_id, project_id, start_ms, end_ms FROM mtr_throttles WHERE start_ms < ? AND (end_ms IS NULL OR end_ms > ?)${extra}`,
      )
      .all(endMs, startMs, ...args) as unknown as {
      session_id: string;
      owner_id: string | null;
      project_id: string | null;
      start_ms: number;
      end_ms: number | null;
    }[];
    for (const t of intervals) {
      const s = Math.max(t.start_ms, startMs);
      const e = Math.min(t.end_ms ?? now, endMs);
      if (e <= s) continue;
      for (const [date, ms] of splitByLocalDay(s, e, this.tz))
        cell(date, t.session_id, t.owner_id, t.project_id).idleMs += ms;
    }
    const hits = this.db
      .prepare(
        `SELECT date, session_id, owner_id, project_id, COUNT(*) AS n FROM mtr_throttle_hits WHERE date >= ? AND date <= ?${extra} GROUP BY date, session_id`,
      )
      .all(q.from, q.to, ...args) as unknown as {
      date: string;
      session_id: string;
      owner_id: string | null;
      project_id: string | null;
      n: number;
    }[];
    for (const h of hits) cell(h.date, h.session_id, h.owner_id, h.project_id).hits += h.n;
    const open = this.db
      .prepare(`SELECT DISTINCT session_id FROM mtr_throttles WHERE end_ms IS NULL${extra}`)
      .all(...args) as unknown as { session_id: string }[];
    return { cells: [...cells.values()], openSessions: new Set(open.map((o) => o.session_id)) };
  }

  /** Lifetime throttle totals of one session. */
  sessionThrottle(sessionId: string): { hits: number; idleMs: number; throttledNow: boolean } {
    const now = this.now();
    const rows = this.db
      .prepare('SELECT start_ms, end_ms FROM mtr_throttles WHERE session_id = ?')
      .all(sessionId) as unknown as { start_ms: number; end_ms: number | null }[];
    const hits = (
      this.db.prepare('SELECT COUNT(*) AS n FROM mtr_throttle_hits WHERE session_id = ?').get(sessionId) as {
        n: number;
      }
    ).n;
    return {
      hits,
      idleMs: rows.reduce((sum, r) => sum + Math.max(0, Math.min(r.end_ms ?? now, now) - r.start_ms), 0),
      throttledNow: rows.some((r) => r.end_ms === null),
    };
  }

  // ── outcomes (portfolio lens) ────────────────────────────────────────────
  outcomes(
    from: string,
    to: string,
  ): { kind: 'ticket' | 'change' | 'phase'; refId: string; projectId: string | null; completedAt: string }[] {
    return (
      this.db
        .prepare(
          'SELECT kind, ref_id, project_id, completed_at FROM mtr_outcomes WHERE date >= ? AND date <= ? ORDER BY completed_at, ref_id',
        )
        .all(from, to) as unknown as {
        kind: 'ticket' | 'change' | 'phase';
        ref_id: string;
        project_id: string | null;
        completed_at: string;
      }[]
    ).map((r) => ({ kind: r.kind, refId: r.ref_id, projectId: r.project_id, completedAt: r.completed_at }));
  }

  /** Sessions linked to a ticket/change, each with its share (1 / number of same-kind outcomes it is linked to). */
  linkedSessions(kind: 'ticket' | 'change', refId: string): { sessionId: string; share: number }[] {
    return this.db
      .prepare(
        `SELECT l.session_id AS sessionId, 1.0 / (SELECT COUNT(*) FROM mtr_session_links x WHERE x.session_id = l.session_id AND x.kind = l.kind) AS share
         FROM mtr_session_links l WHERE l.kind = ? AND l.ref_id = ?`,
      )
      .all(kind, refId) as unknown as { sessionId: string; share: number }[];
  }

  sessionUsage(sessionId: string): { usd: number; unpriced: boolean; projectId: string | null } {
    const r = this.db
      .prepare(
        "SELECT COALESCE(SUM(cost_usd), 0) AS usd, SUM(priced_by = 'unpriced') AS unpriced, MAX(project_id) AS project FROM mtr_usage WHERE session_id = ?",
      )
      .get(sessionId) as { usd: number; unpriced: number | null; project: string | null };
    return { usd: r.usd, unpriced: (r.unpriced ?? 0) > 0, projectId: r.project };
  }

  /** Phase spend: usage attributed to the phase's tasks, plus unattributed usage of sessions launched into the phase. */
  phaseUsage(projectId: string, phaseId: string): { usd: number; unpriced: boolean; sessions: number } {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS usd, SUM(priced_by = 'unpriced') AS unpriced, COUNT(DISTINCT session_id) AS sessions FROM mtr_usage
         WHERE COALESCE(task_project_id, project_id) = ? AND COALESCE(phase_id, launch_phase_id) = ?`,
      )
      .get(projectId, phaseId) as { usd: number; unpriced: number | null; sessions: number };
    return { usd: r.usd, unpriced: (r.unpriced ?? 0) > 0, sessions: r.sessions };
  }
}
