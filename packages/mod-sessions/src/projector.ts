import type { DatabaseSync } from 'node:sqlite';
import type { JsonValue, StoredEvent } from '@aoc/contracts';
import { localDate, type Projector } from '@aoc/kernel';

export const SESSIONS_TABLES = [
  'sess_sessions',
  'sess_decisions',
  'sess_activity',
  'sess_usage_daily',
  'sess_seen_messages',
  'sess_tasks_daily',
  'sess_throttle_daily',
  'sess_users',
  'sess_projects',
];

const DDL = [
  `CREATE TABLE IF NOT EXISTS sess_sessions (
    session_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL,
    claude_session_id TEXT,
    owner_id TEXT,
    project_id TEXT, thread_id TEXT, phase_id TEXT, ticket_id TEXT, parent_session_id TEXT,
    process_type TEXT, model TEXT, read_only INTEGER NOT NULL DEFAULT 0, credential_profile TEXT,
    lifecycle TEXT NOT NULL,
    liveness TEXT, liveness_reason TEXT, liveness_since TEXT,
    cwd TEXT, transcript_path TEXT, pid INTEGER,
    turns INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    started_at TEXT NOT NULL, ended_at TEXT, outcome TEXT,
    last_tool_at TEXT, last_activity_at TEXT,
    context_tokens INTEGER,
    throttled_until TEXT, throttle_started_at TEXT,
    predecessor_id TEXT, successor_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS sess_sessions_claude ON sess_sessions(claude_session_id)`,
  `CREATE INDEX IF NOT EXISTS sess_sessions_project ON sess_sessions(project_id)`,
  `CREATE INDEX IF NOT EXISTS sess_sessions_lifecycle ON sess_sessions(lifecycle)`,
  `CREATE TABLE IF NOT EXISTS sess_decisions (decision_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS sess_decisions_session ON sess_decisions(session_id, status)`,
  `CREATE TABLE IF NOT EXISTS sess_activity (session_id TEXT NOT NULL, minute TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (session_id, minute))`,
  `CREATE TABLE IF NOT EXISTS sess_usage_daily (
    session_id TEXT NOT NULL, date TEXT NOT NULL, model TEXT NOT NULL,
    input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_w5 INTEGER NOT NULL, cache_w1 INTEGER NOT NULL,
    PRIMARY KEY (session_id, date, model)
  )`,
  `CREATE TABLE IF NOT EXISTS sess_seen_messages (session_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY (session_id, message_id))`,
  `CREATE TABLE IF NOT EXISTS sess_tasks_daily (date TEXT PRIMARY KEY, done INTEGER NOT NULL, verified INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sess_throttle_daily (date TEXT PRIMARY KEY, idle_ms INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sess_users (user_id TEXT PRIMARY KEY, name TEXT)`,
  `CREATE TABLE IF NOT EXISTS sess_projects (project_id TEXT PRIMARY KEY, name TEXT, repo_path TEXT)`,
];

const HANDLES = [
  'session.launch_requested',
  'session.launched',
  'session.observed',
  'session.turn_started',
  'session.lifecycle_changed',
  'session.liveness_changed',
  'session.ended',
  'session.rollover_completed',
  'decision.requested',
  'decision.resolved',
  'decision.withdrawn',
  'tool.used',
  'tool.denied',
  'usage.recorded',
  'throttle.hit',
  'throttle.cleared',
  'task.done',
  'user.created',
  'user.updated',
  'project.created',
  'project.updated',
] as const;

type P = Record<string, JsonValue> | null;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function minuteOf(iso: string): string {
  return iso.slice(0, 16); // YYYY-MM-DDTHH:MM (UTC)
}

function titleFromPrompt(prompt: string | null): string | null {
  if (!prompt) return null;
  const first = prompt.split('\n').find((l) => l.trim().length > 0) ?? '';
  return first.trim().slice(0, 80) || null;
}

export function createSessionsProjector(timezone: () => string): Projector {
  return {
    name: 'sessions',
    tables: SESSIONS_TABLES,
    ddl: DDL,
    handles: HANDLES,
    apply({ db }, e, payload) {
      apply(db, e, payload as P, timezone());
    },
    onErase(db, scopeId) {
      db.prepare("UPDATE sess_sessions SET title = '[erased]', cwd = NULL, transcript_path = NULL WHERE session_id = ?").run(scopeId);
      db.prepare("UPDATE sess_users SET name = '[erased]' WHERE user_id = ?").run(scopeId);
      db.prepare("UPDATE sess_projects SET name = '[erased]', repo_path = NULL WHERE project_id = ?").run(scopeId);
    },
  };
}

function bump(db: DatabaseSync, sessionId: string, ts: string): void {
  db.prepare(
    `INSERT INTO sess_activity (session_id, minute, count) VALUES (?, ?, 1)
     ON CONFLICT(session_id, minute) DO UPDATE SET count = count + 1`,
  ).run(sessionId, minuteOf(ts));
}

/**
 * The owner the supervisor recorded at launch. Events written before launch_requested carried ownerId: the launching
 * human, else (rollover) the parent session's owner.
 */
function ownerOf(db: DatabaseSync, e: StoredEvent, m: Record<string, JsonValue>): string | null {
  if ('ownerId' in m) return str(m.ownerId);
  if (e.actor.kind === 'human') return e.actor.id;
  if (!m.parentSessionId) return null;
  const parent = db.prepare('SELECT owner_id FROM sess_sessions WHERE session_id = ?').get(m.parentSessionId as string) as
    | { owner_id: string | null }
    | undefined;
  return parent?.owner_id ?? null;
}

function apply(db: DatabaseSync, e: StoredEvent, p: P, tz: string): void {
  const m = e.meta as Record<string, JsonValue>;
  switch (e.type) {
    case 'session.launch_requested':
      db.prepare(
        `INSERT INTO sess_sessions (session_id, mode, owner_id, project_id, thread_id, phase_id, ticket_id, parent_session_id, process_type, model,
           read_only, credential_profile, lifecycle, cwd, title, started_at, predecessor_id)
         VALUES (?, 'managed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'launching', ?, ?, ?, ?)
         ON CONFLICT(session_id) DO NOTHING`,
      ).run(
        m.sessionId as string,
        ownerOf(db, e, m),
        m.projectId as string,
        m.threadId as string,
        str(m.phaseId),
        str(m.ticketId),
        str(m.parentSessionId),
        m.processType as string,
        m.model as string,
        m.readOnly ? 1 : 0,
        str(m.credentialProfile),
        str(p?.cwd),
        p ? titleFromPrompt(str(p.prompt)) : '[erased]',
        e.ts,
        str(m.parentSessionId),
      );
      break;
    case 'session.launched':
      db.prepare('UPDATE sess_sessions SET claude_session_id = ?, pid = ?, model = ?, transcript_path = COALESCE(?, transcript_path), cwd = COALESCE(?, cwd) WHERE session_id = ?').run(
        m.claudeSessionId as string,
        m.pid as number,
        m.model as string,
        str(p?.transcriptPath),
        str(p?.cwd),
        m.sessionId as string,
      );
      break;
    case 'session.observed':
      db.prepare(
        `INSERT INTO sess_sessions (session_id, mode, claude_session_id, project_id, lifecycle, cwd, transcript_path, title, started_at)
         VALUES (?, 'observed', ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING`,
      ).run(
        m.sessionId as string,
        m.claudeSessionId as string,
        str(m.projectId),
        str(p?.cwd),
        str(p?.transcriptPath),
        p?.cwd ? `Observed · ${String(p.cwd).split('/').filter(Boolean).pop() ?? '/'}` : 'Observed session',
        e.ts,
      );
      break;
    case 'session.turn_started':
      db.prepare('UPDATE sess_sessions SET turns = MAX(turns, ?), last_activity_at = ? WHERE session_id = ?').run(m.turn as number, e.ts, m.sessionId as string);
      break;
    case 'session.lifecycle_changed':
      db.prepare('UPDATE sess_sessions SET lifecycle = ? WHERE session_id = ?').run(m.to as string, m.sessionId as string);
      if (m.to !== 'throttled') {
        db.prepare('UPDATE sess_sessions SET throttled_until = NULL WHERE session_id = ? AND throttle_started_at IS NULL').run(m.sessionId as string);
      }
      break;
    case 'session.liveness_changed':
      db.prepare('UPDATE sess_sessions SET liveness = ?, liveness_reason = ?, liveness_since = ? WHERE session_id = ?').run(
        (m.to as string | null) ?? null,
        m.reason as string,
        e.ts,
        m.sessionId as string,
      );
      break;
    case 'session.ended':
      db.prepare(
        `UPDATE sess_sessions SET lifecycle = CASE WHEN ? = 'retired' THEN 'retired' WHEN ? = 'completed' THEN 'ended' WHEN ? IN ('failed','killed') THEN CASE WHEN ? = 'failed' THEN 'failed' ELSE 'ended' END ELSE 'ended' END,
           ended_at = ?, outcome = ? WHERE session_id = ?`,
      ).run(m.outcome as string, m.outcome as string, m.outcome as string, m.outcome as string, e.ts, m.outcome as string, m.sessionId as string);
      break;
    case 'session.rollover_completed':
      db.prepare('UPDATE sess_sessions SET successor_id = ? WHERE session_id = ?').run(m.toSessionId as string, m.fromSessionId as string);
      db.prepare('UPDATE sess_sessions SET predecessor_id = ? WHERE session_id = ?').run(m.fromSessionId as string, m.toSessionId as string);
      break;
    case 'decision.requested':
      if (m.sessionId) {
        db.prepare("INSERT OR IGNORE INTO sess_decisions (decision_id, session_id, kind, created_at, status) VALUES (?, ?, ?, ?, 'open')").run(
          m.decisionId as string,
          m.sessionId as string,
          m.kind as string,
          e.ts,
        );
      }
      break;
    case 'decision.resolved':
      db.prepare("UPDATE sess_decisions SET status = 'resolved' WHERE decision_id = ?").run(m.decisionId as string);
      break;
    case 'decision.withdrawn':
      db.prepare("UPDATE sess_decisions SET status = 'withdrawn' WHERE decision_id = ?").run(m.decisionId as string);
      break;
    case 'tool.used':
      bump(db, m.sessionId as string, e.ts);
      db.prepare('UPDATE sess_sessions SET last_tool_at = ?, last_activity_at = ? WHERE session_id = ?').run(e.ts, e.ts, m.sessionId as string);
      break;
    case 'tool.denied':
      bump(db, m.sessionId as string, e.ts);
      break;
    case 'usage.recorded': {
      const date = localDate(Date.parse(m.lastAt as string), tz);
      db.prepare(
        `INSERT INTO sess_usage_daily (session_id, date, model, input, output, cache_read, cache_w5, cache_w1) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id, date, model) DO UPDATE SET input = input + excluded.input, output = output + excluded.output,
           cache_read = cache_read + excluded.cache_read, cache_w5 = cache_w5 + excluded.cache_w5, cache_w1 = cache_w1 + excluded.cache_w1`,
      ).run(
        m.sessionId as string,
        date,
        m.model as string,
        m.inputTokens as number,
        m.outputTokens as number,
        m.cacheReadTokens as number,
        m.cacheWrite5mTokens as number,
        m.cacheWrite1hTokens as number,
      );
      // 0 = the batch held no main-chain message (e.g. a subagent transcript on its own): the context size is unknown.
      if ((m.contextTokens as number) > 0) {
        db.prepare('UPDATE sess_sessions SET context_tokens = ? WHERE session_id = ?').run(m.contextTokens as number, m.sessionId as string);
      }
      const ids = (p?.messageIds as string[] | undefined) ?? [];
      const ins = db.prepare('INSERT OR IGNORE INTO sess_seen_messages (session_id, message_id) VALUES (?, ?)');
      for (const id of ids) ins.run(m.sessionId as string, id);
      break;
    }
    case 'throttle.hit':
      db.prepare('UPDATE sess_sessions SET throttled_until = ?, throttle_started_at = COALESCE(throttle_started_at, ?) WHERE session_id = ?').run(
        str(m.resetAt),
        e.ts,
        m.sessionId as string,
      );
      break;
    case 'throttle.cleared': {
      const date = localDate(Date.parse(e.ts), tz);
      db.prepare(
        `INSERT INTO sess_throttle_daily (date, idle_ms) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET idle_ms = idle_ms + excluded.idle_ms`,
      ).run(date, m.idleMs as number);
      db.prepare('UPDATE sess_sessions SET throttled_until = NULL, throttle_started_at = NULL WHERE session_id = ?').run(m.sessionId as string);
      break;
    }
    case 'task.done': {
      const date = localDate(Date.parse(e.ts), tz);
      const verified = m.evidenceVerified === true && m.flag === null ? 1 : 0;
      db.prepare(
        `INSERT INTO sess_tasks_daily (date, done, verified) VALUES (?, 1, ?) ON CONFLICT(date) DO UPDATE SET done = done + 1, verified = verified + excluded.verified`,
      ).run(date, verified);
      break;
    }
    case 'user.created':
    case 'user.updated':
      if (e.type === 'user.created' || p?.name) {
        db.prepare('INSERT INTO sess_users (user_id, name) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET name = COALESCE(excluded.name, name)').run(
          m.userId as string,
          str(p?.name),
        );
      }
      break;
    case 'project.created':
    case 'project.updated':
      db.prepare(
        `INSERT INTO sess_projects (project_id, name, repo_path) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET name = COALESCE(excluded.name, name), repo_path = COALESCE(excluded.repo_path, repo_path)`,
      ).run(m.projectId as string, str(p?.name), str(p?.repoPath));
      break;
  }
}
