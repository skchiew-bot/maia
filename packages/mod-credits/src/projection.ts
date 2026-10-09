import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  CreditGrant,
  CreditTopupStatus,
  EventType,
  MetaOf,
  StoredEvent,
  UsageTotals,
} from '@aoc/contracts';
import { localDate, localPeriod, type Projector } from '@aoc/kernel';

const metaOf = <T extends EventType>(e: StoredEvent, _type: T): MetaOf<T> => e.meta as unknown as MetaOf<T>;

const DDL = [
  `CREATE TABLE IF NOT EXISTS crd_allocations (
    user_id TEXT NOT NULL, period TEXT NOT NULL, amount_usd REAL NOT NULL, allocated_by TEXT NOT NULL, at TEXT NOT NULL, seq INTEGER NOT NULL,
    PRIMARY KEY (user_id, period))`,
  // Raw token usage per usage.recorded; cost and session ownership are resolved at read time (metering
  // rate card, session directory) so the projection stays deterministic.
  `CREATE TABLE IF NOT EXISTS crd_usage (
    seq INTEGER PRIMARY KEY, session_id TEXT NOT NULL, model TEXT NOT NULL, local_date TEXT NOT NULL, period TEXT NOT NULL,
    input_tokens REAL NOT NULL, output_tokens REAL NOT NULL, cache_read_tokens REAL NOT NULL, cache_write_5m_tokens REAL NOT NULL, cache_write_1h_tokens REAL NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS crd_usage_period ON crd_usage(period, session_id)`,
  `CREATE TABLE IF NOT EXISTS crd_grants (
    seq INTEGER PRIMARY KEY, user_id TEXT NOT NULL, period TEXT NOT NULL, kind TEXT NOT NULL, amount_usd REAL NOT NULL,
    balance_before REAL NOT NULL, balance_after REAL NOT NULL, approver_id TEXT, request_id TEXT, decision_id TEXT, session_id TEXT, task_id TEXT, at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS crd_grants_user ON crd_grants(user_id, period)`,
  `CREATE TABLE IF NOT EXISTS crd_caps (
    seq INTEGER PRIMARY KEY, user_id TEXT NOT NULL, period TEXT NOT NULL, session_id TEXT NOT NULL, task_id TEXT, balance_usd REAL NOT NULL, at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS crd_caps_session ON crd_caps(session_id, period)`,
  `CREATE TABLE IF NOT EXISTS crd_topups (
    request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, period TEXT NOT NULL, amount_usd REAL NOT NULL, reason TEXT, body_scope TEXT,
    session_id TEXT, task_id TEXT, decision_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, created_seq INTEGER NOT NULL,
    resolved_at TEXT, resolved_by TEXT, balance_before REAL, balance_after REAL)`,
  `CREATE INDEX IF NOT EXISTS crd_topups_user ON crd_topups(user_id, status)`,
  `CREATE INDEX IF NOT EXISTS crd_topups_decision ON crd_topups(decision_id)`,
];

const HANDLES = [
  'usage.recorded',
  'credit.allocated',
  'credit.cap_reached',
  'credit.auto_granted',
  'credit.topup_requested',
  'credit.topup_granted',
  'credit.topup_denied',
  'credit.topup_withdrawn',
] as const;

/** `timezone` decides which local day / period a usage batch belongs to (config.timezone, set at init). */
export function createCreditsProjector(timezone: () => string): Projector {
  return {
    name: 'credits',
    tables: ['crd_allocations', 'crd_usage', 'crd_grants', 'crd_caps', 'crd_topups'],
    ddl: DDL,
    handles: HANDLES,
    apply({ db }, e, payload) {
      const run = (sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args);
      switch (e.type) {
        case 'usage.recorded': {
          const m = metaOf(e, 'usage.recorded');
          const at = Date.parse(m.lastAt);
          const day = localDate(Number.isNaN(at) ? Date.parse(e.ts) : at, timezone());
          run(
            `INSERT OR IGNORE INTO crd_usage (seq, session_id, model, local_date, period, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            e.seq,
            m.sessionId,
            m.model,
            day,
            day.slice(0, 7),
            m.inputTokens,
            m.outputTokens,
            m.cacheReadTokens,
            m.cacheWrite5mTokens,
            m.cacheWrite1hTokens,
          );
          return;
        }
        case 'credit.allocated': {
          const m = metaOf(e, 'credit.allocated');
          run(
            `INSERT INTO crd_allocations (user_id, period, amount_usd, allocated_by, at, seq) VALUES (?,?,?,?,?,?)
             ON CONFLICT(user_id, period) DO UPDATE SET amount_usd = excluded.amount_usd, allocated_by = excluded.allocated_by, at = excluded.at, seq = excluded.seq`,
            m.userId,
            m.period,
            m.amountUsd,
            m.allocatedBy,
            e.ts,
            e.seq,
          );
          return;
        }
        case 'credit.cap_reached': {
          const m = metaOf(e, 'credit.cap_reached');
          run(
            'INSERT OR IGNORE INTO crd_caps (seq, user_id, period, session_id, task_id, balance_usd, at) VALUES (?,?,?,?,?,?,?)',
            e.seq,
            m.userId,
            m.period,
            m.sessionId,
            m.taskId,
            m.balanceUsd,
            e.ts,
          );
          return;
        }
        case 'credit.auto_granted': {
          const m = metaOf(e, 'credit.auto_granted');
          run(
            `INSERT OR IGNORE INTO crd_grants (seq, user_id, period, kind, amount_usd, balance_before, balance_after, approver_id, request_id, decision_id, session_id, task_id, at)
             VALUES (?,?,?,'auto',?,?,?,NULL,NULL,?,?,?,?)`,
            e.seq,
            m.userId,
            m.period,
            m.amountUsd,
            m.balanceBefore,
            m.balanceAfter,
            m.decisionId ?? null,
            m.sessionId,
            m.taskId,
            e.ts,
          );
          return;
        }
        case 'credit.topup_requested': {
          const m = metaOf(e, 'credit.topup_requested');
          const reason = (payload as { reason?: unknown } | null)?.reason;
          run(
            `INSERT OR IGNORE INTO crd_topups (request_id, user_id, period, amount_usd, reason, body_scope, session_id, task_id, decision_id, status, created_at, created_seq)
             VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`,
            m.requestId,
            m.userId,
            m.period,
            m.amountUsd,
            typeof reason === 'string' ? reason : null,
            e.bodyScope,
            m.sessionId,
            m.taskId,
            m.decisionId,
            e.ts,
            e.seq,
          );
          return;
        }
        case 'credit.topup_granted': {
          const m = metaOf(e, 'credit.topup_granted');
          const period = m.period ?? localPeriod(Date.parse(e.ts), timezone());
          run(
            `INSERT OR IGNORE INTO crd_grants (seq, user_id, period, kind, amount_usd, balance_before, balance_after, approver_id, request_id, decision_id, session_id, task_id, at)
             VALUES (?,?,?,'topup',?,?,?,?,?,?,?,?,?)`,
            e.seq,
            m.userId,
            period,
            m.amountUsd,
            m.balanceBefore,
            m.balanceAfter,
            m.approverId,
            m.requestId,
            m.decisionId,
            m.sessionId ?? null,
            m.taskId ?? null,
            e.ts,
          );
          run(
            `UPDATE crd_topups SET status = 'granted', resolved_at = ?, resolved_by = ?, balance_before = ?, balance_after = ? WHERE request_id = ?`,
            e.ts,
            m.approverId,
            m.balanceBefore,
            m.balanceAfter,
            m.requestId,
          );
          return;
        }
        case 'credit.topup_denied': {
          const m = metaOf(e, 'credit.topup_denied');
          run(
            `UPDATE crd_topups SET status = 'denied', resolved_at = ?, resolved_by = ? WHERE request_id = ?`,
            e.ts,
            m.approverId,
            m.requestId,
          );
          return;
        }
        case 'credit.topup_withdrawn': {
          const m = metaOf(e, 'credit.topup_withdrawn');
          run(
            `UPDATE crd_topups SET status = 'withdrawn', resolved_at = ? WHERE request_id = ?`,
            e.ts,
            m.requestId,
          );
          return;
        }
      }
    },
    onErase(db, scopeId) {
      db.prepare('UPDATE crd_topups SET reason = NULL WHERE body_scope = ?').run(scopeId);
    },
  };
}

/** Grant rows are served as-is in the account DTO. */
export type GrantRow = CreditGrant;

export interface TopupRow {
  requestId: string;
  userId: string;
  period: string;
  amountUsd: number;
  reason: string | null;
  sessionId: string | null;
  taskId: string | null;
  decisionId: string;
  status: CreditTopupStatus;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  balanceBefore: number | null;
  balanceAfter: number | null;
}

export interface UsageGroup {
  sessionId: string;
  model: string;
  localDate: string;
  totals: UsageTotals;
}

const TOPUP_COLUMNS = `request_id AS requestId, user_id AS userId, period, amount_usd AS amountUsd, reason, session_id AS sessionId, task_id AS taskId,
  decision_id AS decisionId, status, created_at AS createdAt, resolved_at AS resolvedAt, resolved_by AS resolvedBy,
  balance_before AS balanceBefore, balance_after AS balanceAfter`;

/** Read-side queries over the crd_ tables (writes happen only in the projector). */
export class CreditRepo {
  constructor(private readonly db: DatabaseSync) {}

  private all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...args) as unknown as T[];
  }

  private one<T>(sql: string, ...args: SQLInputValue[]): T | null {
    return (this.db.prepare(sql).get(...args) as unknown as T | undefined) ?? null;
  }

  allocation(userId: string, period: string): number | null {
    return (
      this.one<{ amountUsd: number }>(
        'SELECT amount_usd AS amountUsd FROM crd_allocations WHERE user_id = ? AND period = ?',
        userId,
        period,
      )?.amountUsd ?? null
    );
  }

  grants(userId: string, period: string): GrantRow[] {
    return this.all<GrantRow>(
      `SELECT kind, amount_usd AS amountUsd, balance_before AS balanceBefore, balance_after AS balanceAfter, approver_id AS approverId, request_id AS requestId,
        decision_id AS decisionId, session_id AS sessionId, task_id AS taskId, at
       FROM crd_grants WHERE user_id = ? AND period = ? ORDER BY seq`,
      userId,
      period,
    );
  }

  usageGroups(period: string): UsageGroup[] {
    const rows = this.all<{ sessionId: string; model: string; localDate: string } & UsageTotals>(
      `SELECT session_id AS sessionId, model, local_date AS localDate, SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
        SUM(cache_read_tokens) AS cacheReadTokens, SUM(cache_write_5m_tokens) AS cacheWrite5mTokens, SUM(cache_write_1h_tokens) AS cacheWrite1hTokens
       FROM crd_usage WHERE period = ? GROUP BY session_id, model, local_date ORDER BY session_id, model, local_date`,
      period,
    );
    return rows.map(({ sessionId, model, localDate: day, ...totals }) => ({
      sessionId,
      model,
      localDate: day,
      totals,
    }));
  }

  /** The task a session was last capped at in the period (what a top-up request is raised against). */
  lastCapTaskId(sessionId: string, period: string): string | null {
    return (
      this.one<{ taskId: string | null }>(
        'SELECT task_id AS taskId FROM crd_caps WHERE session_id = ? AND period = ? ORDER BY seq DESC LIMIT 1',
        sessionId,
        period,
      )?.taskId ?? null
    );
  }

  /** Users with credit activity in the period (allocations, grants, caps, top-up requests). */
  userIdsWithActivity(period: string): string[] {
    return this.all<{ userId: string }>(
      `SELECT user_id AS userId FROM crd_allocations WHERE period = ?1
       UNION SELECT user_id FROM crd_grants WHERE period = ?1
       UNION SELECT user_id FROM crd_caps WHERE period = ?1
       UNION SELECT user_id FROM crd_topups WHERE period = ?1`,
      period,
    ).map((r) => r.userId);
  }

  topup(requestId: string): TopupRow | null {
    return this.one<TopupRow>(`SELECT ${TOPUP_COLUMNS} FROM crd_topups WHERE request_id = ?`, requestId);
  }

  topupByDecision(decisionId: string): TopupRow | null {
    return this.one<TopupRow>(`SELECT ${TOPUP_COLUMNS} FROM crd_topups WHERE decision_id = ?`, decisionId);
  }

  pendingTopup(userId: string): TopupRow | null {
    return this.one<TopupRow>(
      `SELECT ${TOPUP_COLUMNS} FROM crd_topups WHERE user_id = ? AND status = 'pending' ORDER BY created_seq DESC LIMIT 1`,
      userId,
    );
  }

  topups(filter: { userId?: string; status?: CreditTopupStatus; limit?: number }): TopupRow[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.userId) (where.push('user_id = ?'), args.push(filter.userId));
    if (filter.status) (where.push('status = ?'), args.push(filter.status));
    args.push(filter.limit ?? 500);
    return this.all<TopupRow>(
      `SELECT ${TOPUP_COLUMNS} FROM crd_topups ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_seq DESC LIMIT ?`,
      ...args,
    );
  }
}
