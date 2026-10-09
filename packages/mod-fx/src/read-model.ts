/** FX projections (tables fx_*) and queries. Rebuildable from the log; payload-derived columns degrade to NULL when erased. */
import type { DatabaseSync } from 'node:sqlite';
import type {
  FxDiscrepancyChoice,
  FxDiscrepancyDTO,
  FxExtractor,
  FxRateDTO,
  FxRateStatus,
  FxReason,
  FxSession,
  FxValidation,
  MetaOf,
  PayloadOf,
} from '@aoc/contracts';
import { addDays, type Projector } from '@aoc/kernel';
import { isFlagged, weekdaysIn } from './rules';

/** Encryption scope of every fx event body (erasing it scrubs the payload-derived columns below). */
export const FX_BODY_SCOPE = 'fx';

const DDL = [
  `CREATE TABLE IF NOT EXISTS fx_rates (
    date TEXT PRIMARY KEY,
    rate REAL NOT NULL,
    status TEXT NOT NULL,
    source_date TEXT NOT NULL,
    extractor TEXT NOT NULL,
    validation TEXT NOT NULL,
    reason TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    recorded_by TEXT NOT NULL,
    seq INTEGER NOT NULL,
    revisions INTEGER NOT NULL,
    bnm_session TEXT,
    source_url TEXT, raw_excerpt TEXT, evidence TEXT, notes TEXT, session TEXT,
    official REAL, official_date TEXT, problems TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS fx_rates_status ON fx_rates(status, date)`,
  `CREATE TABLE IF NOT EXISTS fx_discrepancies (
    decision_id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    scraped REAL NOT NULL,
    official REAL NOT NULL,
    scraped_date TEXT, official_date TEXT, extractor TEXT, bnm_session TEXT,
    status TEXT NOT NULL,
    raised_at TEXT NOT NULL,
    resolved_at TEXT, chosen_rate REAL, choice TEXT, applied INTEGER,
    detail TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS fx_discrepancies_date ON fx_discrepancies(date, status)`,
  `CREATE TABLE IF NOT EXISTS fx_alerts (since TEXT PRIMARY KEY, consecutive_days INTEGER NOT NULL, date TEXT, raised_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS fx_closed_days (date TEXT PRIMARY KEY, closed_at TEXT NOT NULL)`,
];

export const fxProjector: Projector = {
  name: 'fx',
  tables: ['fx_rates', 'fx_discrepancies', 'fx_alerts', 'fx_closed_days'],
  ddl: DDL,
  handles: [
    'fx.rate_recorded',
    'fx.discrepancy_raised',
    'fx.discrepancy_resolved',
    'fx.carry_forward_alert',
    'rollup.closed',
  ],
  apply({ db }, e, payload) {
    switch (e.type) {
      case 'fx.rate_recorded': {
        const m = e.meta as MetaOf<'fx.rate_recorded'>;
        const p = (payload ?? {}) as NonNullable<PayloadOf<'fx.rate_recorded'>>;
        db.prepare(
          `INSERT INTO fx_rates (date, rate, status, source_date, extractor, validation, reason, recorded_at, recorded_by, seq, revisions,
             bnm_session, source_url, raw_excerpt, evidence, notes, session, official, official_date, problems)
           VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(date) DO UPDATE SET rate=excluded.rate, status=excluded.status, source_date=excluded.source_date,
             extractor=excluded.extractor, validation=excluded.validation, reason=excluded.reason, recorded_at=excluded.recorded_at,
             recorded_by=excluded.recorded_by, seq=excluded.seq, revisions=fx_rates.revisions + 1, bnm_session=excluded.bnm_session,
             source_url=excluded.source_url, raw_excerpt=excluded.raw_excerpt, evidence=excluded.evidence, notes=excluded.notes,
             session=excluded.session, official=excluded.official, official_date=excluded.official_date, problems=excluded.problems`,
        ).run(
          m.date,
          m.rate,
          m.status,
          m.sourceDate,
          m.extractor,
          m.validation,
          m.reason,
          e.ts,
          e.actor.id,
          e.seq,
          m.session ?? null,
          p.sourceUrl ?? null,
          p.rawExcerpt ?? null,
          p.evidence ?? null,
          p.notes ?? null,
          p.session ?? null,
          p.official ?? null,
          p.officialDate ?? null,
          p.problems?.length ? JSON.stringify(p.problems) : null,
        );
        return;
      }
      case 'fx.discrepancy_raised': {
        const m = e.meta as MetaOf<'fx.discrepancy_raised'>;
        const p = (payload ?? {}) as NonNullable<PayloadOf<'fx.discrepancy_raised'>>;
        db.prepare(
          `INSERT OR IGNORE INTO fx_discrepancies (decision_id, date, scraped, official, scraped_date, official_date, extractor, bnm_session, status, raised_at, detail)
           VALUES (?,?,?,?,?,?,?,?,'open',?,?)`,
        ).run(
          m.decisionId,
          m.date,
          m.scraped,
          m.official,
          m.scrapedDate ?? null,
          m.officialDate ?? null,
          m.extractor ?? null,
          m.session ?? null,
          e.ts,
          p.detail ?? null,
        );
        return;
      }
      case 'fx.discrepancy_resolved': {
        const m = e.meta as MetaOf<'fx.discrepancy_resolved'>;
        db.prepare(
          `UPDATE fx_discrepancies SET status='resolved', resolved_at=?, chosen_rate=?, choice=?, applied=? WHERE decision_id=?`,
        ).run(
          e.ts,
          m.chosenRate,
          m.choice ?? null,
          m.applied === undefined ? null : m.applied ? 1 : 0,
          m.decisionId,
        );
        return;
      }
      case 'fx.carry_forward_alert': {
        const m = e.meta as MetaOf<'fx.carry_forward_alert'>;
        db.prepare(
          `INSERT OR IGNORE INTO fx_alerts (since, consecutive_days, date, raised_at) VALUES (?,?,?,?)`,
        ).run(m.since, m.consecutiveDays, m.date ?? null, e.ts);
        return;
      }
      case 'rollup.closed': {
        const m = e.meta as MetaOf<'rollup.closed'>;
        db.prepare(`INSERT OR IGNORE INTO fx_closed_days (date, closed_at) VALUES (?,?)`).run(m.date, e.ts);
        return;
      }
    }
  },
  onErase(db, scopeId) {
    if (scopeId !== FX_BODY_SCOPE) return;
    db.exec(
      `UPDATE fx_rates SET source_url=NULL, raw_excerpt=NULL, evidence=NULL, notes=NULL, session=NULL, official=NULL, official_date=NULL, problems=NULL`,
    );
    db.exec(`UPDATE fx_discrepancies SET detail=NULL`);
  },
};

export interface FxRateRow {
  date: string;
  rate: number;
  status: FxRateStatus;
  sourceDate: string;
  extractor: FxExtractor;
  validation: FxValidation;
  reason: FxReason;
  recordedAt: string;
  recordedBy: string;
  revisions: number;
  bnmSession: FxSession | null;
  sourceUrl: string | null;
  rawExcerpt: string | null;
  evidence: string | null;
  notes: string | null;
  session: string | null;
  official: number | null;
  officialDate: string | null;
  problems: string[];
}

export interface FxDiscrepancyRow {
  decisionId: string;
  date: string;
  scraped: number;
  official: number;
  scrapedDate: string | null;
  officialDate: string | null;
  extractor: 'haiku' | 'sonnet' | null;
  bnmSession: FxSession | null;
  status: 'open' | 'resolved';
  raisedAt: string;
  resolvedAt: string | null;
  chosenRate: number | null;
  choice: FxDiscrepancyChoice | null;
  applied: boolean | null;
}

type SqlRow = Record<string, string | number | null>;

export class FxReadModel {
  constructor(private readonly db: DatabaseSync) {}

  record(date: string): FxRateRow | null {
    return this.rate(`SELECT * FROM fx_rates WHERE date = ?`, date);
  }

  /** The rate in effect on `date`: its own record, else the latest prior one. */
  latestOnOrBefore(date: string): FxRateRow | null {
    return this.rate(`SELECT * FROM fx_rates WHERE date <= ? ORDER BY date DESC LIMIT 1`, date);
  }

  /** "Yesterday's rate": the latest record before `date`. */
  latestBefore(date: string): FxRateRow | null {
    return this.rate(`SELECT * FROM fx_rates WHERE date < ? ORDER BY date DESC LIMIT 1`, date);
  }

  lastLive(): FxRateRow | null {
    return this.rate(`SELECT * FROM fx_rates WHERE status = 'live' ORDER BY date DESC LIMIT 1`);
  }

  /**
   * Weekdays without a live rate up to the latest record on or before `date`: carried-forward weekdays (holidays
   * included) and weekdays with no record at all (e.g. aocd was down). Weekends never count. Counting stops at the
   * latest record, so a day not yet attempted is not counted.
   */
  carryForwardStreak(date: string): { days: number; since: string | null } {
    const latest = this.latestOnOrBefore(date);
    if (!latest || latest.status === 'live') return { days: 0, since: null };
    const live = this.db
      .prepare(`SELECT date FROM fx_rates WHERE status = 'live' AND date <= ? ORDER BY date DESC LIMIT 1`)
      .get(latest.date) as { date: string } | undefined;
    const first = this.db.prepare(`SELECT MIN(date) AS date FROM fx_rates`).get() as { date: string };
    return weekdaysIn(live ? addDays(live.date, 1) : first.date, latest.date);
  }

  between(from: string, to: string): FxRateRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM fx_rates WHERE date >= ? AND date <= ? ORDER BY date`)
        .all(from, to) as SqlRow[]
    ).map(toRateRow);
  }

  isClosed(date: string): boolean {
    return this.db.prepare(`SELECT 1 FROM fx_closed_days WHERE date = ?`).get(date) !== undefined;
  }

  closedBetween(from: string, to: string): Set<string> {
    return new Set(
      (
        this.db.prepare(`SELECT date FROM fx_closed_days WHERE date >= ? AND date <= ?`).all(from, to) as {
          date: string;
        }[]
      ).map((r) => r.date),
    );
  }

  openDiscrepancyFor(date: string): FxDiscrepancyRow | null {
    return this.discrepancy(
      `SELECT * FROM fx_discrepancies WHERE date = ? AND status = 'open' ORDER BY raised_at DESC LIMIT 1`,
      date,
    );
  }

  discrepancyByDecision(decisionId: string): FxDiscrepancyRow | null {
    return this.discrepancy(`SELECT * FROM fx_discrepancies WHERE decision_id = ?`, decisionId);
  }

  openDiscrepancies(): FxDiscrepancyRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM fx_discrepancies WHERE status = 'open' ORDER BY date DESC, raised_at DESC`)
        .all() as SqlRow[]
    ).map(toDiscrepancyRow);
  }

  hasAlert(since: string): boolean {
    return this.db.prepare(`SELECT 1 FROM fx_alerts WHERE since = ?`).get(since) !== undefined;
  }

  private rate(sql: string, ...args: string[]): FxRateRow | null {
    const r = this.db.prepare(sql).get(...args) as SqlRow | undefined;
    return r ? toRateRow(r) : null;
  }

  private discrepancy(sql: string, ...args: string[]): FxDiscrepancyRow | null {
    const r = this.db.prepare(sql).get(...args) as SqlRow | undefined;
    return r ? toDiscrepancyRow(r) : null;
  }
}

function toRateRow(r: SqlRow): FxRateRow {
  return {
    date: r.date as string,
    rate: r.rate as number,
    status: r.status as FxRateStatus,
    sourceDate: r.source_date as string,
    extractor: r.extractor as FxExtractor,
    validation: r.validation as FxValidation,
    reason: r.reason as FxReason,
    recordedAt: r.recorded_at as string,
    recordedBy: r.recorded_by as string,
    revisions: r.revisions as number,
    bnmSession: r.bnm_session as FxSession | null,
    sourceUrl: r.source_url as string | null,
    rawExcerpt: r.raw_excerpt as string | null,
    evidence: r.evidence as string | null,
    notes: r.notes as string | null,
    session: r.session as string | null,
    official: r.official as number | null,
    officialDate: r.official_date as string | null,
    problems: typeof r.problems === 'string' ? (JSON.parse(r.problems) as string[]) : [],
  };
}

function toDiscrepancyRow(r: SqlRow): FxDiscrepancyRow {
  return {
    decisionId: r.decision_id as string,
    date: r.date as string,
    scraped: r.scraped as number,
    official: r.official as number,
    scrapedDate: r.scraped_date as string | null,
    officialDate: r.official_date as string | null,
    extractor: r.extractor as 'haiku' | 'sonnet' | null,
    bnmSession: r.bnm_session as FxSession | null,
    status: r.status as 'open' | 'resolved',
    raisedAt: r.raised_at as string,
    resolvedAt: r.resolved_at as string | null,
    chosenRate: r.chosen_rate as number | null,
    choice: r.choice as FxDiscrepancyChoice | null,
    applied: r.applied === null ? null : r.applied === 1,
  };
}

export function toRateDTO(r: FxRateRow, closed: boolean): FxRateDTO {
  return {
    date: r.date,
    pair: 'USD/MYR',
    rate: r.rate,
    status: r.status,
    sourceDate: r.sourceDate,
    extractor: r.extractor,
    validation: r.validation,
    reason: r.reason,
    flagged: isFlagged(r.reason),
    recordedAt: r.recordedAt,
    recordedBy: r.recordedBy,
    revisions: r.revisions,
    closed,
    bnmSession: r.bnmSession,
    sourceUrl: r.sourceUrl,
    rawExcerpt: r.rawExcerpt,
    evidence: r.evidence,
    notes: r.notes,
    session: r.session,
    official: r.official,
    officialDate: r.officialDate,
    problems: r.problems,
  };
}

export function toDiscrepancyDTO(
  d: FxDiscrepancyRow,
  decisionStatus: FxDiscrepancyDTO['decisionStatus'],
): FxDiscrepancyDTO {
  return {
    date: d.date,
    decisionId: d.decisionId,
    scraped: d.scraped,
    official: d.official,
    scrapedDate: d.scrapedDate,
    officialDate: d.officialDate,
    extractor: d.extractor,
    bnmSession: d.bnmSession,
    status: d.status,
    decisionStatus,
    raisedAt: d.raisedAt,
    resolvedAt: d.resolvedAt,
    chosenRate: d.chosenRate,
    choice: d.choice,
    applied: d.applied,
  };
}
