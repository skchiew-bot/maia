/**
 * Supervisor projection: what the supervisor must know about its managed sessions to resume, recover after a
 * reboot and enforce one writer per thread. Rebuildable from the log; the cwd (from an encrypted payload) is
 * scrubbed when its body scope is erased.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { JsonValue, SessionLifecycle, StoredEvent } from '@aoc/contracts';
import type { Projector } from '@aoc/kernel';

export interface SupervisedSession {
  sessionId: string;
  claudeSessionId: string | null;
  ownerId: string | null;
  projectId: string;
  threadId: string;
  phaseId: string | null;
  ticketId: string | null;
  changeId: string | null;
  parentSessionId: string | null;
  processType: string;
  model: string;
  readOnly: boolean;
  cwd: string | null;
  lifecycle: SessionLifecycle;
  lifecycleReason: string;
  /** Last turn started (0 = never started). */
  turn: number;
  turnStartedSeq: number;
  turnStartedAt: string | null;
  lastEndedTurn: number;
  lastOutcome: string | null;
  pid: number | null;
  /** Consecutive auto-continue turns since the last turn started for any other reason. */
  autoContinues: number;
  stopRequested: boolean;
  throttledAt: string | null;
  throttleResetAt: string | null;
  successorSessionId: string | null;
  createdAt: string;
}

/** Lifecycles in which a non-read-only session holds its thread's single writer slot (§5). */
export const WRITER_LIFECYCLES: readonly SessionLifecycle[] = [
  'launching',
  'running',
  'idle',
  'waiting_decision',
  'blocked',
  'throttled',
];
export const TERMINAL_LIFECYCLES: readonly SessionLifecycle[] = ['ended', 'retired'];

const TABLE = 'sup_sessions';
const DDL = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
    session_id TEXT PRIMARY KEY,
    claude_session_id TEXT,
    owner_id TEXT,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    phase_id TEXT, ticket_id TEXT, change_id TEXT, parent_session_id TEXT,
    process_type TEXT NOT NULL,
    model TEXT NOT NULL,
    read_only INTEGER NOT NULL,
    cwd TEXT,
    lifecycle TEXT NOT NULL,
    lifecycle_reason TEXT NOT NULL,
    turn INTEGER NOT NULL DEFAULT 0,
    turn_started_seq INTEGER NOT NULL DEFAULT 0,
    turn_started_at TEXT,
    last_ended_turn INTEGER NOT NULL DEFAULT 0,
    last_outcome TEXT,
    pid INTEGER,
    auto_continues INTEGER NOT NULL DEFAULT 0,
    stop_requested INTEGER NOT NULL DEFAULT 0,
    throttled_at TEXT,
    throttle_reset_at TEXT,
    successor_session_id TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ${TABLE}_thread ON ${TABLE}(thread_id)`,
  `CREATE INDEX IF NOT EXISTS ${TABLE}_lifecycle ON ${TABLE}(lifecycle)`,
];

type Meta = Record<string, JsonValue>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export const supervisorProjector: Projector = {
  name: 'supervisor',
  tables: [TABLE],
  ddl: DDL,
  handles: [
    'session.launch_requested',
    'session.launched',
    'session.turn_started',
    'session.turn_ended',
    'session.lifecycle_changed',
    'session.ended',
    'session.stop_requested',
    'session.rollover_completed',
    'throttle.hit',
    'throttle.cleared',
  ],
  apply({ db }, e, payload) {
    apply(db, e, payload);
  },
  onErase(db, scopeId) {
    db.prepare(`UPDATE ${TABLE} SET cwd = NULL WHERE session_id = ?`).run(scopeId);
  },
};

function apply(db: DatabaseSync, e: StoredEvent, payload: JsonValue | null): void {
  const m = e.meta as Meta;
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Meta) : null;
  const id = m.sessionId as string;
  switch (e.type) {
    case 'session.launch_requested':
      db.prepare(
        `INSERT INTO ${TABLE} (session_id, owner_id, project_id, thread_id, phase_id, ticket_id, change_id, parent_session_id,
           process_type, model, read_only, cwd, lifecycle, lifecycle_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'launching', 'launch_requested', ?) ON CONFLICT(session_id) DO NOTHING`,
      ).run(
        id,
        ownerOf(db, e, m),
        m.projectId as string,
        m.threadId as string,
        str(m.phaseId),
        str(m.ticketId),
        str(m.changeId),
        str(m.parentSessionId),
        m.processType as string,
        m.model as string,
        m.readOnly ? 1 : 0,
        str(p?.cwd),
        e.ts,
      );
      break;
    case 'session.launched':
      db.prepare(
        `UPDATE ${TABLE} SET claude_session_id = ?, pid = ?, cwd = COALESCE(?, cwd) WHERE session_id = ?`,
      ).run(m.claudeSessionId as string, m.pid as number, str(p?.cwd), id);
      break;
    case 'session.turn_started':
      // A new turn means any earlier throttle is over (a stale hit from a retried request must not linger).
      db.prepare(
        `UPDATE ${TABLE} SET turn = ?, turn_started_seq = ?, turn_started_at = ?, throttled_at = NULL, throttle_reset_at = NULL,
           auto_continues = CASE WHEN ? = 'continue' THEN auto_continues + 1 ELSE 0 END WHERE session_id = ?`,
      ).run(m.turn as number, e.seq, e.ts, m.reason as string, id);
      break;
    case 'session.turn_ended':
      db.prepare(
        `UPDATE ${TABLE} SET last_ended_turn = MAX(last_ended_turn, ?), last_outcome = ?, pid = NULL WHERE session_id = ?`,
      ).run(m.turn as number, m.outcome as string, id);
      break;
    case 'session.lifecycle_changed':
      db.prepare(`UPDATE ${TABLE} SET lifecycle = ?, lifecycle_reason = ? WHERE session_id = ?`).run(
        m.to as string,
        m.reason as string,
        id,
      );
      break;
    case 'session.ended':
      // Terminal whatever the lifecycle trail says: an ended session is never recovered or resumed.
      db.prepare(
        `UPDATE ${TABLE} SET lifecycle = 'ended', lifecycle_reason = ? WHERE session_id = ? AND lifecycle NOT IN ('ended', 'retired')`,
      ).run(m.outcome as string, id);
      break;
    case 'session.stop_requested':
      db.prepare(`UPDATE ${TABLE} SET stop_requested = 1 WHERE session_id = ?`).run(id);
      break;
    case 'session.rollover_completed':
      db.prepare(`UPDATE ${TABLE} SET successor_session_id = ? WHERE session_id = ?`).run(
        m.toSessionId as string,
        m.fromSessionId as string,
      );
      break;
    case 'throttle.hit':
      db.prepare(
        `UPDATE ${TABLE} SET throttled_at = COALESCE(throttled_at, ?), throttle_reset_at = COALESCE(?, throttle_reset_at) WHERE session_id = ?`,
      ).run(e.ts, str(m.resetAt), id);
      break;
    case 'throttle.cleared':
      db.prepare(
        `UPDATE ${TABLE} SET throttled_at = NULL, throttle_reset_at = NULL WHERE session_id = ?`,
      ).run(id);
      break;
  }
}

/**
 * The owner recorded at launch. Events written before launch_requested carried ownerId: the launching human,
 * else (a rollover successor) the parent session's owner.
 */
function ownerOf(db: DatabaseSync, e: StoredEvent, m: Meta): string | null {
  if ('ownerId' in m) return str(m.ownerId);
  if (e.actor.kind === 'human') return e.actor.id;
  if (!m.parentSessionId) return null;
  const parent = db
    .prepare(`SELECT owner_id FROM ${TABLE} WHERE session_id = ?`)
    .get(m.parentSessionId as string) as { owner_id: string | null } | undefined;
  return parent?.owner_id ?? null;
}

interface Row {
  session_id: string;
  claude_session_id: string | null;
  owner_id: string | null;
  project_id: string;
  thread_id: string;
  phase_id: string | null;
  ticket_id: string | null;
  change_id: string | null;
  parent_session_id: string | null;
  process_type: string;
  model: string;
  read_only: number;
  cwd: string | null;
  lifecycle: string;
  lifecycle_reason: string;
  turn: number;
  turn_started_seq: number;
  turn_started_at: string | null;
  last_ended_turn: number;
  last_outcome: string | null;
  pid: number | null;
  auto_continues: number;
  stop_requested: number;
  throttled_at: string | null;
  throttle_reset_at: string | null;
  successor_session_id: string | null;
  created_at: string;
}

function toSession(r: Row): SupervisedSession {
  return {
    sessionId: r.session_id,
    claudeSessionId: r.claude_session_id,
    ownerId: r.owner_id,
    projectId: r.project_id,
    threadId: r.thread_id,
    phaseId: r.phase_id,
    ticketId: r.ticket_id,
    changeId: r.change_id,
    parentSessionId: r.parent_session_id,
    processType: r.process_type,
    model: r.model,
    readOnly: r.read_only === 1,
    cwd: r.cwd,
    lifecycle: r.lifecycle as SessionLifecycle,
    lifecycleReason: r.lifecycle_reason,
    turn: r.turn,
    turnStartedSeq: r.turn_started_seq,
    turnStartedAt: r.turn_started_at,
    lastEndedTurn: r.last_ended_turn,
    lastOutcome: r.last_outcome,
    pid: r.pid,
    autoContinues: r.auto_continues,
    stopRequested: r.stop_requested === 1,
    throttledAt: r.throttled_at,
    throttleResetAt: r.throttle_reset_at,
    successorSessionId: r.successor_session_id,
    createdAt: r.created_at,
  };
}

/** Read side of the projection. */
export class SupervisorView {
  constructor(private readonly db: DatabaseSync) {}

  get(sessionId: string): SupervisedSession | null {
    const r = this.db.prepare(`SELECT * FROM ${TABLE} WHERE session_id = ?`).get(sessionId) as
      Row | undefined;
    return r ? toSession(r) : null;
  }

  byLifecycle(lifecycles: readonly SessionLifecycle[]): SupervisedSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ${TABLE} WHERE lifecycle IN (${lifecycles.map(() => '?').join(',')}) ORDER BY created_at, session_id`,
      )
      .all(...lifecycles) as unknown as Row[];
    return rows.map(toSession);
  }

  /** Other sessions currently holding the thread's writer slot (at most one while the invariant holds). */
  otherWriters(threadId: string, exceptSessionId: string): SupervisedSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM ${TABLE} WHERE thread_id = ? AND session_id <> ? AND read_only = 0 AND lifecycle IN (${WRITER_LIFECYCLES.map(() => '?').join(',')})
         ORDER BY created_at DESC`,
      )
      .all(threadId, exceptSessionId, ...WRITER_LIFECYCLES) as unknown as Row[];
    return rows.map(toSession);
  }

  /** The thread's most recent non-terminal writer session (the rollover candidate). */
  writerOf(threadId: string): SupervisedSession | null {
    const r = this.db
      .prepare(
        `SELECT * FROM ${TABLE} WHERE thread_id = ? AND read_only = 0 AND lifecycle NOT IN (${TERMINAL_LIFECYCLES.map(() => '?').join(',')})
         ORDER BY created_at DESC, session_id DESC LIMIT 1`,
      )
      .get(threadId, ...TERMINAL_LIFECYCLES) as Row | undefined;
    return r ? toSession(r) : null;
  }
}
