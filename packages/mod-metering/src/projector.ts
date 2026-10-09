/**
 * Metering projection (mtr_* tables). Deterministic from the log: pricing reads only rate cards and
 * rollups projected earlier in the same log, so a rebuild reproduces every cost.
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  EventType,
  JsonValue,
  MetaOf,
  PayloadOf,
  RateCardRate,
  Scope,
  SessionDirectory,
  StoredEvent,
} from '@aoc/contracts';
import { addDays, localDate, type Projector } from '@aoc/kernel';
import { effectiveCard, priceUsage, type PricingCard } from './pricing';

/** Body-store scope for metering payloads (rate cards, rollup breakdowns): kept apart from 'global'. */
export const METERING_BODY_SCOPE = 'metering';
/** Usage whose source day is closed, or older than this, is booked on the day it arrived (flagged late). */
export const MAX_BACKDATE_DAYS = 35;

export interface ProjectorDeps {
  tz(): string;
  /** Owner / project fallback for sessions the log has not described (observed sessions). */
  directory(): SessionDirectory | null;
}

const TABLES = [
  'mtr_ratecards',
  'mtr_subscriptions',
  'mtr_sessions',
  'mtr_session_links',
  'mtr_usage',
  'mtr_throttles',
  'mtr_throttle_hits',
  'mtr_rollups',
  'mtr_outcomes',
];

const DDL = [
  `CREATE TABLE IF NOT EXISTS mtr_ratecards (
    version INTEGER PRIMARY KEY, seq INTEGER NOT NULL, effective_from TEXT NOT NULL,
    rates_json TEXT, tier_fallback_json TEXT, note TEXT, rates_hash TEXT NOT NULL,
    published_at TEXT NOT NULL, published_by TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mtr_subscriptions (
    seq INTEGER PRIMARY KEY, effective_from TEXT NOT NULL, plan TEXT NOT NULL, seats INTEGER NOT NULL,
    monthly_usd_per_seat REAL NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mtr_sessions (
    session_id TEXT PRIMARY KEY, owner_id TEXT, project_id TEXT, process_type TEXT, model TEXT,
    ticket_id TEXT, phase_id TEXT, parent_session_id TEXT, mode TEXT NOT NULL, launched_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS mtr_session_links (
    session_id TEXT NOT NULL, kind TEXT NOT NULL, ref_id TEXT NOT NULL, linked_at TEXT NOT NULL,
    PRIMARY KEY (session_id, kind, ref_id))`,
  `CREATE INDEX IF NOT EXISTS mtr_session_links_ref ON mtr_session_links(kind, ref_id)`,
  `CREATE TABLE IF NOT EXISTS mtr_usage (
    seq INTEGER PRIMARY KEY, session_id TEXT NOT NULL, owner_id TEXT, project_id TEXT, process_type TEXT,
    launch_phase_id TEXT, model TEXT NOT NULL, date TEXT NOT NULL, source_date TEXT NOT NULL,
    late INTEGER NOT NULL, recorded_at TEXT NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
    cache_write_5m_tokens INTEGER NOT NULL, cache_write_1h_tokens INTEGER NOT NULL, messages INTEGER NOT NULL,
    cost_usd REAL NOT NULL, rate_card_version INTEGER NOT NULL, rate_model TEXT, priced_by TEXT NOT NULL,
    task_id TEXT, task_project_id TEXT, phase_id TEXT, attributed_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS mtr_usage_date ON mtr_usage(date)`,
  `CREATE INDEX IF NOT EXISTS mtr_usage_session ON mtr_usage(session_id, task_id)`,
  `CREATE INDEX IF NOT EXISTS mtr_usage_owner ON mtr_usage(owner_id, date)`,
  `CREATE TABLE IF NOT EXISTS mtr_throttles (
    id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, owner_id TEXT, project_id TEXT,
    start_ms INTEGER NOT NULL, reset_at TEXT, end_ms INTEGER, closed_by TEXT)`,
  `CREATE INDEX IF NOT EXISTS mtr_throttles_session ON mtr_throttles(session_id, id)`,
  `CREATE TABLE IF NOT EXISTS mtr_throttle_hits (
    seq INTEGER PRIMARY KEY, session_id TEXT NOT NULL, owner_id TEXT, project_id TEXT, at_ms INTEGER NOT NULL, date TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS mtr_throttle_hits_date ON mtr_throttle_hits(date)`,
  `CREATE TABLE IF NOT EXISTS mtr_rollups (
    date TEXT PRIMARY KEY, seq INTEGER NOT NULL, closed_at TEXT NOT NULL, usd REAL NOT NULL, rm REAL NOT NULL,
    fx_rate REAL NOT NULL, fx_status TEXT NOT NULL, fx_source_date TEXT, fx_session TEXT, rate_card_version INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL, cache_write_5m_tokens INTEGER NOT NULL, cache_write_1h_tokens INTEGER NOT NULL,
    messages INTEGER NOT NULL, unpriced_tokens INTEGER NOT NULL, throttle_idle_ms INTEGER NOT NULL,
    throttle_hits INTEGER NOT NULL, subscription_usd REAL NOT NULL, breakdown_json TEXT)`,
  `CREATE TABLE IF NOT EXISTS mtr_outcomes (
    kind TEXT NOT NULL, ref_id TEXT NOT NULL, project_id TEXT, completed_at TEXT NOT NULL, date TEXT NOT NULL,
    seq INTEGER NOT NULL, PRIMARY KEY (kind, ref_id))`,
  `CREATE INDEX IF NOT EXISTS mtr_outcomes_date ON mtr_outcomes(date)`,
];

const HANDLES = [
  'ratecard.published',
  'subscription.updated',
  'rollup.closed',
  'session.launch_requested',
  'session.observed',
  'session.rollover_completed',
  'session.ended',
  'usage.recorded',
  'task.done',
  'throttle.hit',
  'throttle.cleared',
  'ticket.triage_started',
  'ticket.build_started',
  'ticket.closed',
  'change.drafted',
  'change.started',
  'change.completed',
  'phase.completed',
] as const;

interface RateCardDbRow {
  version: number;
  effective_from: string;
  rates_json: string | null;
  tier_fallback_json: string | null;
}

export function loadPricingCards(db: DatabaseSync): PricingCard[] {
  const rows = db
    .prepare(
      'SELECT version, effective_from, rates_json, tier_fallback_json FROM mtr_ratecards ORDER BY version',
    )
    .all() as unknown as RateCardDbRow[];
  return rows.map((r) => ({
    version: r.version,
    effectiveFrom: r.effective_from,
    rates: r.rates_json ? (JSON.parse(r.rates_json) as RateCardRate[]) : null,
    tierFallback: r.tier_fallback_json ? (JSON.parse(r.tier_fallback_json) as Record<string, string>) : {},
  }));
}

export function lastClosedDay(db: DatabaseSync): string | null {
  return (db.prepare('SELECT MAX(date) AS d FROM mtr_rollups').get() as { d: string | null }).d;
}

const metaOf = <T extends EventType>(e: StoredEvent, _type: T): MetaOf<T> => e.meta as unknown as MetaOf<T>;
const sourceMs = (e: StoredEvent): number => {
  const t = Date.parse(e.sourceTs ?? e.ts);
  return Number.isFinite(t) ? t : Date.parse(e.ts);
};

/**
 * The owner the supervisor recorded at launch (null: nobody). Events written before launch_requested carried ownerId
 * have the launching human, else (a rollover successor) the parent session's owner.
 */
function launchOwner(db: DatabaseSync, e: StoredEvent, m: MetaOf<'session.launch_requested'>): string | null {
  if (m.ownerId !== undefined) return m.ownerId;
  if (e.actor.kind === 'human') return e.actor.id;
  if (!m.parentSessionId) return null;
  const parent = db.prepare('SELECT owner_id FROM mtr_sessions WHERE session_id = ?').get(m.parentSessionId) as
    | { owner_id: string | null }
    | undefined;
  return parent?.owner_id ?? null;
}

interface SessionAttrs {
  ownerId: string | null;
  projectId: string | null;
  processType: string | null;
  phaseId: string | null;
}

export function createMeteringProjector(deps: ProjectorDeps): Projector {
  function sessionAttrs(db: DatabaseSync, sessionId: string, scope: Scope): SessionAttrs {
    const row = db
      .prepare('SELECT mode, owner_id, project_id, process_type, phase_id FROM mtr_sessions WHERE session_id = ?')
      .get(sessionId) as
      | {
          mode: string;
          owner_id: string | null;
          project_id: string | null;
          process_type: string | null;
          phase_id: string | null;
        }
      | undefined;
    const out: SessionAttrs = {
      ownerId: row?.owner_id ?? null,
      projectId: row?.project_id ?? null,
      processType: row?.process_type ?? null,
      phaseId: row?.phase_id ?? null,
    };
    // A launch the log recorded settles who owns the session (nobody included): the directory, another module's
    // state at the time of the lookup, only describes sessions the log does not (observed ones).
    if (row?.mode !== 'managed' && (!out.ownerId || !out.projectId || !out.processType)) {
      let info: ReturnType<SessionDirectory['get']> = null;
      try {
        info = deps.directory()?.get(sessionId) ?? null;
      } catch {
        info = null;
      }
      out.ownerId ??= info?.ownerId ?? null;
      out.projectId ??= info?.projectId ?? null;
      out.processType ??= info?.processType ?? null;
    }
    out.projectId ??= scope.projectId ?? null;
    return out;
  }

  /** Late-described sessions: fill attribution the earlier rows could not know (never touches cost). */
  function backfill(db: DatabaseSync, sessionId: string): void {
    const s = sessionAttrs(db, sessionId, {});
    db.prepare(
      `UPDATE mtr_usage SET owner_id = COALESCE(owner_id, ?), project_id = COALESCE(project_id, ?),
        process_type = COALESCE(process_type, ?), launch_phase_id = COALESCE(launch_phase_id, ?) WHERE session_id = ?`,
    ).run(s.ownerId, s.projectId, s.processType, s.phaseId, sessionId);
    for (const t of ['mtr_throttles', 'mtr_throttle_hits']) {
      db.prepare(
        `UPDATE ${t} SET owner_id = COALESCE(owner_id, ?), project_id = COALESCE(project_id, ?) WHERE session_id = ?`,
      ).run(s.ownerId, s.projectId, sessionId);
    }
  }

  function link(
    db: DatabaseSync,
    sessionId: string,
    kind: 'ticket' | 'change',
    refId: string,
    at: string,
  ): void {
    db.prepare(
      'INSERT OR IGNORE INTO mtr_session_links (session_id, kind, ref_id, linked_at) VALUES (?,?,?,?)',
    ).run(sessionId, kind, refId, at);
  }

  function outcome(
    db: DatabaseSync,
    e: StoredEvent,
    kind: 'ticket' | 'change' | 'phase',
    refId: string,
    projectId: string | null,
  ): void {
    db.prepare(
      'INSERT OR IGNORE INTO mtr_outcomes (kind, ref_id, project_id, completed_at, date, seq) VALUES (?,?,?,?,?,?)',
    ).run(kind, refId, projectId, e.ts, localDate(Date.parse(e.ts), deps.tz()), e.seq);
  }

  /** Usage recorded while no card covered its (still open) day gets priced once a covering card exists. */
  function priceUncovered(db: DatabaseSync): void {
    const wm = lastClosedDay(db);
    const rows = db
      .prepare(
        `SELECT seq, model, date, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens
         FROM mtr_usage WHERE rate_card_version = 0 AND date > ?`,
      )
      .all(wm ?? '') as unknown as {
      seq: number;
      model: string;
      date: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_5m_tokens: number;
      cache_write_1h_tokens: number;
    }[];
    if (!rows.length) return;
    const cards = loadPricingCards(db);
    const update = db.prepare(
      'UPDATE mtr_usage SET cost_usd = ?, rate_card_version = ?, rate_model = ?, priced_by = ? WHERE seq = ?',
    );
    for (const r of rows) {
      const card = effectiveCard(cards, r.date);
      if (!card) continue;
      const p = priceUsage(
        r.model,
        {
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          cacheReadTokens: r.cache_read_tokens,
          cacheWrite5mTokens: r.cache_write_5m_tokens,
          cacheWrite1hTokens: r.cache_write_1h_tokens,
        },
        card,
      );
      update.run(p.costUsd, p.rateCardVersion, p.rateModel, p.pricedBy, r.seq);
    }
  }

  function onUsage(db: DatabaseSync, e: StoredEvent): void {
    const m = metaOf(e, 'usage.recorded');
    const tz = deps.tz();
    const ingestDay = localDate(Date.parse(e.ts), tz);
    const lastAt = Date.parse(m.lastAt);
    const sourceDay = Number.isFinite(lastAt) ? localDate(lastAt, tz) : ingestDay;
    const wm = lastClosedDay(db);
    let date = sourceDay > ingestDay ? ingestDay : sourceDay;
    let late = 0;
    if ((wm && date <= wm) || date < addDays(ingestDay, -MAX_BACKDATE_DAYS)) {
      date = ingestDay;
      late = 1;
    }
    if (wm && date <= wm) date = addDays(wm, 1);
    const s = sessionAttrs(db, m.sessionId, e.scope);
    const p = priceUsage(m.model, m, effectiveCard(loadPricingCards(db), date));
    db.prepare(
      `INSERT OR IGNORE INTO mtr_usage (seq, session_id, owner_id, project_id, process_type, launch_phase_id, model, date, source_date, late,
        recorded_at, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens, messages,
        cost_usd, rate_card_version, rate_model, priced_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      e.seq,
      m.sessionId,
      s.ownerId,
      s.projectId,
      s.processType,
      s.phaseId,
      m.model,
      date,
      sourceDay,
      late,
      e.ts,
      m.inputTokens,
      m.outputTokens,
      m.cacheReadTokens,
      m.cacheWrite5mTokens,
      m.cacheWrite1hTokens,
      m.messages,
      p.costUsd,
      p.rateCardVersion,
      p.rateModel,
      p.pricedBy,
    );
  }

  function onThrottleHit(db: DatabaseSync, e: StoredEvent): void {
    const m = metaOf(e, 'throttle.hit');
    const at = sourceMs(e);
    const s = sessionAttrs(db, m.sessionId, e.scope);
    db.prepare(
      'INSERT OR IGNORE INTO mtr_throttle_hits (seq, session_id, owner_id, project_id, at_ms, date) VALUES (?,?,?,?,?,?)',
    ).run(e.seq, m.sessionId, s.ownerId, s.projectId, at, localDate(at, deps.tz()));
    const open = db
      .prepare('SELECT id FROM mtr_throttles WHERE session_id = ? AND end_ms IS NULL')
      .get(m.sessionId);
    if (open) return; // a repeat hit while throttled counts as a hit, not a second idle interval
    db.prepare(
      'INSERT INTO mtr_throttles (id, session_id, owner_id, project_id, start_ms, reset_at) VALUES (?,?,?,?,?,?)',
    ).run(e.seq, m.sessionId, s.ownerId, s.projectId, at, m.resetAt);
  }

  /** idleMs from the sessions module is authoritative for the interval length. */
  function onThrottleCleared(db: DatabaseSync, e: StoredEvent): void {
    const m = metaOf(e, 'throttle.cleared');
    const at = sourceMs(e);
    const last = db
      .prepare(
        'SELECT id, start_ms, end_ms, closed_by FROM mtr_throttles WHERE session_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(m.sessionId) as
      { id: number; start_ms: number; end_ms: number | null; closed_by: string | null } | undefined;
    if (last && (last.end_ms === null || last.closed_by === 'session_ended')) {
      db.prepare("UPDATE mtr_throttles SET end_ms = ?, closed_by = 'cleared' WHERE id = ?").run(
        last.start_ms + m.idleMs,
        last.id,
      );
      return;
    }
    // No open throttle: a clear overlapping the last interval is a repeat, not new idle time.
    if (m.idleMs <= 0 || (last?.end_ms != null && last.end_ms > at - m.idleMs)) return;
    const s = sessionAttrs(db, m.sessionId, e.scope);
    db.prepare(
      "INSERT INTO mtr_throttles (id, session_id, owner_id, project_id, start_ms, end_ms, closed_by) VALUES (?,?,?,?,?,?,'cleared')",
    ).run(e.seq, m.sessionId, s.ownerId, s.projectId, at - m.idleMs, at);
  }

  return {
    name: 'metering',
    tables: TABLES,
    ddl: DDL,
    handles: HANDLES,
    // 1: a session's owner is the one its launch recorded, and a managed session never asks the sessions directory.
    version: 1,
    apply({ db }, e: StoredEvent, payload: JsonValue | null) {
      switch (e.type) {
        case 'ratecard.published': {
          const m = metaOf(e, 'ratecard.published');
          const p = payload as PayloadOf<'ratecard.published'> | null;
          db.prepare(
            `INSERT OR IGNORE INTO mtr_ratecards (version, seq, effective_from, rates_json, tier_fallback_json, note, rates_hash, published_at, published_by)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          ).run(
            m.version,
            e.seq,
            m.effectiveFrom,
            p ? JSON.stringify(p.rates) : null,
            p?.tierFallback ? JSON.stringify(p.tierFallback) : null,
            p?.note ?? null,
            m.ratesHash,
            e.ts,
            e.actor.id,
          );
          priceUncovered(db);
          return;
        }
        case 'subscription.updated': {
          const m = metaOf(e, 'subscription.updated');
          db.prepare(
            'INSERT OR IGNORE INTO mtr_subscriptions (seq, effective_from, plan, seats, monthly_usd_per_seat, updated_at, updated_by) VALUES (?,?,?,?,?,?,?)',
          ).run(e.seq, m.effectiveFrom, m.plan, m.seats, m.monthlyUsdPerSeat, e.ts, e.actor.id);
          return;
        }
        case 'rollup.closed': {
          const m = metaOf(e, 'rollup.closed');
          db.prepare(
            `INSERT OR IGNORE INTO mtr_rollups (date, seq, closed_at, usd, rm, fx_rate, fx_status, fx_source_date, fx_session, rate_card_version,
              input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
              messages, unpriced_tokens, throttle_idle_ms, throttle_hits, subscription_usd, breakdown_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            m.date,
            e.seq,
            m.closedAt,
            m.usdNotional,
            m.rmNotional,
            m.fxRate,
            m.fxStatus,
            m.fxSourceDate,
            m.fxSession ?? null,
            m.rateCardVersion,
            m.inputTokens,
            m.outputTokens,
            m.cacheReadTokens,
            m.cacheWriteTokens,
            m.cacheWrite5mTokens,
            m.cacheWrite1hTokens,
            m.messages,
            m.unpricedTokens,
            m.throttleIdleMs,
            m.throttleHits,
            m.subscriptionUsd,
            payload === null ? null : JSON.stringify(payload),
          );
          return;
        }
        case 'session.launch_requested': {
          const m = metaOf(e, 'session.launch_requested');
          const owner = launchOwner(db, e, m);
          db.prepare(
            `INSERT INTO mtr_sessions (session_id, owner_id, project_id, process_type, model, ticket_id, phase_id, parent_session_id, mode, launched_at)
             VALUES (?,?,?,?,?,?,?,?,'managed',?)
             ON CONFLICT(session_id) DO UPDATE SET owner_id = COALESCE(mtr_sessions.owner_id, excluded.owner_id),
               project_id = excluded.project_id, process_type = excluded.process_type, model = excluded.model,
               ticket_id = excluded.ticket_id, phase_id = excluded.phase_id, parent_session_id = excluded.parent_session_id, mode = 'managed'`,
          ).run(
            m.sessionId,
            owner,
            m.projectId,
            m.processType,
            m.model,
            m.ticketId,
            m.phaseId,
            m.parentSessionId,
            e.ts,
          );
          if (m.ticketId) link(db, m.sessionId, 'ticket', m.ticketId, e.ts);
          backfill(db, m.sessionId);
          return;
        }
        case 'session.observed': {
          const m = metaOf(e, 'session.observed');
          db.prepare(
            `INSERT INTO mtr_sessions (session_id, project_id, mode, launched_at) VALUES (?,?,'observed',?)
             ON CONFLICT(session_id) DO UPDATE SET project_id = COALESCE(mtr_sessions.project_id, excluded.project_id)`,
          ).run(m.sessionId, m.projectId, e.ts);
          backfill(db, m.sessionId);
          return;
        }
        case 'session.rollover_completed': {
          const m = metaOf(e, 'session.rollover_completed');
          const from = db
            .prepare('SELECT owner_id FROM mtr_sessions WHERE session_id = ?')
            .get(m.fromSessionId) as { owner_id: string | null } | undefined;
          if (from?.owner_id) {
            db.prepare('UPDATE mtr_sessions SET owner_id = COALESCE(owner_id, ?) WHERE session_id = ?').run(
              from.owner_id,
              m.toSessionId,
            );
            backfill(db, m.toSessionId);
          }
          return;
        }
        case 'session.ended': {
          // An ended session cannot stay throttled: stop the idle clock (a later throttle.cleared still wins).
          const m = metaOf(e, 'session.ended');
          db.prepare(
            "UPDATE mtr_throttles SET end_ms = MAX(start_ms, ?), closed_by = 'session_ended' WHERE session_id = ? AND end_ms IS NULL",
          ).run(sourceMs(e), m.sessionId);
          return;
        }
        case 'usage.recorded':
          return onUsage(db, e);
        case 'task.done': {
          // Per-task attribution: usage not yet attributed goes to the task closed next. Cost is never touched.
          const m = metaOf(e, 'task.done');
          db.prepare(
            'UPDATE mtr_usage SET task_id = ?, task_project_id = ?, phase_id = ?, attributed_at = ? WHERE session_id = ? AND task_id IS NULL',
          ).run(m.taskId, m.projectId, m.phaseId, e.ts, m.sessionId);
          return;
        }
        case 'throttle.hit':
          return onThrottleHit(db, e);
        case 'throttle.cleared':
          return onThrottleCleared(db, e);
        case 'ticket.triage_started': {
          const m = metaOf(e, 'ticket.triage_started');
          for (const sid of m.sessionIds) link(db, sid, 'ticket', m.ticketId, e.ts);
          return;
        }
        case 'ticket.build_started': {
          const m = metaOf(e, 'ticket.build_started');
          link(db, m.sessionId, 'ticket', m.ticketId, e.ts);
          if (m.changeId) link(db, m.sessionId, 'change', m.changeId, e.ts);
          return;
        }
        case 'change.drafted': {
          const m = metaOf(e, 'change.drafted');
          if (m.sessionId) link(db, m.sessionId, 'change', m.changeId, e.ts);
          return;
        }
        case 'change.started': {
          const m = metaOf(e, 'change.started');
          link(db, m.sessionId, 'change', m.changeId, e.ts);
          return;
        }
        case 'ticket.closed': {
          const m = metaOf(e, 'ticket.closed');
          if (m.resolution === 'fixed') outcome(db, e, 'ticket', m.ticketId, null);
          return;
        }
        case 'change.completed':
          return outcome(db, e, 'change', metaOf(e, 'change.completed').changeId, null);
        case 'phase.completed': {
          const m = metaOf(e, 'phase.completed');
          return outcome(db, e, 'phase', `${m.projectId}/${m.phaseId}`, m.projectId);
        }
      }
    },
    onErase(db, scopeId) {
      if (scopeId === METERING_BODY_SCOPE) db.prepare('UPDATE mtr_ratecards SET note = NULL').run();
    },
  };
}
