import type { DatabaseSync } from 'node:sqlite';
import { modelTierOf, type JsonValue, type MetaOf, type StoredEvent } from '@aoc/contracts';
import type { Projector } from '@aoc/kernel';
import { normalizeMessage } from './signature';

export const LEARNING_TABLES = [
  'lrn_errors',
  'lrn_classes',
  'lrn_offences',
  'lrn_offence_history',
  'lrn_lessons',
  'lrn_lesson_runs',
  'lrn_usage',
  'lrn_session_files',
  'lrn_ticket_sessions',
  'lrn_change_sessions',
  'lrn_rollbacks',
];

/**
 * R11: no table stores an actor, user id, requester or approver. Occurrences keep the session id only for the
 * model / process-type analysis and cost windows; the API never returns it.
 */
const DDL = [
  `CREATE TABLE IF NOT EXISTS lrn_errors (
    error_id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    observed_at TEXT NOT NULL,
    observed_ms INTEGER NOT NULL,
    source TEXT NOT NULL,
    session_id TEXT,
    project_id TEXT,
    process_type TEXT,
    model TEXT,
    model_tier TEXT,
    signature TEXT NOT NULL,
    code_area TEXT,
    priority TEXT NOT NULL,
    direct_cost_usd REAL NOT NULL,
    direct_cost_ms REAL NOT NULL,
    message TEXT,
    template TEXT,
    fix TEXT,
    hint TEXT,
    body_scope TEXT,
    class_id TEXT,
    assigned_by TEXT,
    confidence REAL,
    assigned_seq INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS lrn_errors_class ON lrn_errors(class_id, observed_ms)`,
  `CREATE INDEX IF NOT EXISTS lrn_errors_signature ON lrn_errors(signature, assigned_by)`,
  `CREATE INDEX IF NOT EXISTS lrn_errors_observed ON lrn_errors(observed_ms)`,
  `CREATE INDEX IF NOT EXISTS lrn_errors_body ON lrn_errors(body_scope)`,
  `CREATE TABLE IF NOT EXISTS lrn_classes (
    class_id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    dimension TEXT NOT NULL,
    name TEXT,
    description TEXT,
    origin TEXT NOT NULL,
    body_scope TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS lrn_offences (
    offence_id TEXT PRIMARY KEY,
    class_id TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL,
    detected_at TEXT NOT NULL,
    root_caused_at TEXT,
    fix_applied_at TEXT,
    fix_applied_ms INTEGER,
    fix_seq INTEGER,
    verified_closed_at TEXT,
    reopened_at TEXT,
    reopen_count INTEGER NOT NULL DEFAULT 0,
    last_transition_at TEXT NOT NULL,
    last_transition_event TEXT NOT NULL,
    fix TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS lrn_offence_history (
    offence_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    at TEXT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    occurrences INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    note TEXT,
    fix TEXT,
    body_scope TEXT,
    PRIMARY KEY (offence_id, seq)
  )`,
  `CREATE TABLE IF NOT EXISTS lrn_lessons (
    lesson_id TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    class_id TEXT,
    scope_type TEXT NOT NULL,
    scope_value TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    status TEXT NOT NULL,
    origin TEXT NOT NULL,
    rule TEXT,
    fix TEXT,
    rationale TEXT,
    proposed_at TEXT NOT NULL,
    bound_at TEXT,
    bound_ms INTEGER,
    rejected_at TEXT,
    retired_at TEXT,
    retired_ms INTEGER,
    retire_reason TEXT,
    runs_unused INTEGER,
    body_scope TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS lrn_lessons_decision ON lrn_lessons(decision_id)`,
  `CREATE INDEX IF NOT EXISTS lrn_lessons_status ON lrn_lessons(status, scope_type)`,
  `CREATE TABLE IF NOT EXISTS lrn_lesson_runs (
    lesson_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    applied_ms INTEGER NOT NULL,
    PRIMARY KEY (lesson_id, session_id)
  )`,
  `CREATE TABLE IF NOT EXISTS lrn_usage (
    seq INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    model TEXT NOT NULL,
    input INTEGER NOT NULL,
    output INTEGER NOT NULL,
    cache_read INTEGER NOT NULL,
    cache_w5 INTEGER NOT NULL,
    cache_w1 INTEGER NOT NULL,
    first_ms INTEGER NOT NULL,
    last_ms INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS lrn_usage_session ON lrn_usage(session_id, last_ms)`,
  `CREATE TABLE IF NOT EXISTS lrn_session_files (
    session_id TEXT NOT NULL,
    path TEXT NOT NULL,
    first_ms INTEGER NOT NULL,
    body_scope TEXT,
    PRIMARY KEY (session_id, path)
  )`,
  `CREATE TABLE IF NOT EXISTS lrn_ticket_sessions (ticket_id TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (ticket_id, session_id))`,
  `CREATE TABLE IF NOT EXISTS lrn_change_sessions (change_id TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (change_id, session_id))`,
  `CREATE TABLE IF NOT EXISTS lrn_rollbacks (rollback_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, change_id TEXT)`,
];

const HANDLES = [
  'error.observed',
  'rootcause.class_defined',
  'rootcause.assigned',
  'offence.transitioned',
  'lesson.proposed',
  'lesson.bound',
  'lesson.rejected',
  'lesson.applied',
  'lesson.retired',
  'usage.recorded',
  'tool.used',
  'ticket.build_started',
  'change.started',
  'rollback.requested',
] as const;

type Obj = Record<string, JsonValue>;
const str = (v: JsonValue | undefined): string | null => (typeof v === 'string' && v.length ? v : null);
const ms = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
};
/** When the thing happened at the source (buffered hook events carry sourceTs). */
const happenedAt = (e: StoredEvent): string => e.sourceTs ?? e.ts;
const originOf = (e: StoredEvent): 'human' | 'ai' => (e.actor.kind === 'human' ? 'human' : 'ai');

export function createLearningProjector(): Projector {
  return {
    name: 'learning',
    tables: LEARNING_TABLES,
    ddl: DDL,
    handles: HANDLES,
    apply({ db }, e, payload) {
      apply(
        db,
        e,
        payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Obj) : null,
      );
    },
    onErase(db, scopeId) {
      db.prepare(
        'UPDATE lrn_errors SET message = NULL, template = NULL, fix = NULL, hint = NULL WHERE body_scope = ?',
      ).run(scopeId);
      db.prepare('UPDATE lrn_classes SET name = NULL, description = NULL WHERE body_scope = ?').run(scopeId);
      db.prepare('UPDATE lrn_lessons SET rule = NULL, fix = NULL, rationale = NULL WHERE body_scope = ?').run(
        scopeId,
      );
      db.prepare('UPDATE lrn_offence_history SET note = NULL, fix = NULL WHERE body_scope = ?').run(scopeId);
      db.prepare('UPDATE lrn_offences SET fix = NULL WHERE offence_id = ?').run(scopeId);
      db.prepare('DELETE FROM lrn_session_files WHERE body_scope = ?').run(scopeId);
    },
  };
}

function apply(db: DatabaseSync, e: StoredEvent, p: Obj | null): void {
  switch (e.type) {
    case 'error.observed': {
      const m = e.meta as MetaOf<'error.observed'>;
      const at = happenedAt(e);
      const message = str(p?.message);
      db.prepare(
        `INSERT OR IGNORE INTO lrn_errors (error_id, seq, observed_at, observed_ms, source, session_id, project_id, process_type, model, model_tier,
           signature, code_area, priority, direct_cost_usd, direct_cost_ms, message, template, fix, hint, body_scope)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        m.errorId,
        e.seq,
        at,
        ms(at),
        m.source,
        m.sessionId,
        m.projectId,
        m.processType,
        m.model,
        m.model ? modelTierOf(m.model) : null,
        m.signature,
        m.codeArea,
        m.priority,
        m.costUsd,
        m.costMs,
        message,
        message === null ? null : normalizeMessage(message),
        str(p?.fix),
        str(p?.rootCauseHint),
        e.bodyScope,
      );
      return;
    }
    case 'rootcause.class_defined': {
      const m = e.meta as MetaOf<'rootcause.class_defined'>;
      db.prepare(
        `INSERT INTO lrn_classes (class_id, seq, created_at, dimension, name, description, origin, body_scope) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(class_id) DO UPDATE SET dimension = excluded.dimension, name = excluded.name, description = excluded.description, body_scope = excluded.body_scope`,
      ).run(m.classId, e.seq, e.ts, m.dimension, str(p?.name), str(p?.description), originOf(e), e.bodyScope);
      return;
    }
    case 'rootcause.assigned': {
      const m = e.meta as MetaOf<'rootcause.assigned'>;
      db.prepare(
        'UPDATE lrn_errors SET class_id = ?, assigned_by = ?, confidence = ?, assigned_seq = ? WHERE error_id = ?',
      ).run(m.classId, m.assignedBy, m.confidence, e.seq, m.errorId);
      return;
    }
    case 'offence.transitioned': {
      const m = e.meta as MetaOf<'offence.transitioned'>;
      const fix = str(p?.fix);
      db.prepare(
        `INSERT OR IGNORE INTO lrn_offence_history (offence_id, seq, event_id, at, from_state, to_state, occurrences, cost_usd, note, fix, body_scope)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        m.offenceId,
        e.seq,
        e.id,
        e.ts,
        m.from,
        m.to,
        m.occurrences,
        m.costOfRecurrenceUsd,
        str(p?.note),
        fix,
        e.bodyScope,
      );
      db.prepare(
        `INSERT OR IGNORE INTO lrn_offences (offence_id, class_id, state, detected_at, last_transition_at, last_transition_event) VALUES (?,?,?,?,?,?)`,
      ).run(m.offenceId, m.classId, m.to, e.ts, e.ts, e.id);
      db.prepare(
        'UPDATE lrn_offences SET state = ?, last_transition_at = ?, last_transition_event = ?, fix = COALESCE(?, fix) WHERE offence_id = ?',
      ).run(m.to, e.ts, e.id, fix, m.offenceId);
      const col: Partial<Record<typeof m.to, string>> = {
        root_caused: 'root_caused_at = ?',
        verified_closed: 'verified_closed_at = ?',
        reopened: 'reopened_at = ?, reopen_count = reopen_count + 1',
      };
      if (m.to === 'fix_applied') {
        db.prepare(
          'UPDATE lrn_offences SET fix_applied_at = ?, fix_applied_ms = ?, fix_seq = ? WHERE offence_id = ?',
        ).run(e.ts, ms(e.ts), e.seq, m.offenceId);
      } else if (col[m.to]) {
        db.prepare(`UPDATE lrn_offences SET ${col[m.to]} WHERE offence_id = ?`).run(e.ts, m.offenceId);
      }
      return;
    }
    case 'lesson.proposed': {
      const m = e.meta as MetaOf<'lesson.proposed'>;
      db.prepare(
        `INSERT OR IGNORE INTO lrn_lessons (lesson_id, seq, class_id, scope_type, scope_value, decision_id, status, origin, rule, fix, rationale, proposed_at, body_scope)
         VALUES (?,?,?,?,?,?,'proposed',?,?,?,?,?,?)`,
      ).run(
        m.lessonId,
        e.seq,
        m.classId,
        m.scopeType,
        m.scopeValue,
        m.decisionId,
        originOf(e),
        str(p?.rule),
        str(p?.fix),
        str(p?.rationale),
        e.ts,
        e.bodyScope,
      );
      return;
    }
    case 'lesson.bound': {
      const m = e.meta as MetaOf<'lesson.bound'>;
      db.prepare(
        "UPDATE lrn_lessons SET status = 'bound', bound_at = ?, bound_ms = ? WHERE lesson_id = ? AND status = 'proposed'",
      ).run(e.ts, ms(e.ts), m.lessonId);
      return;
    }
    case 'lesson.rejected': {
      const m = e.meta as MetaOf<'lesson.rejected'>;
      db.prepare(
        "UPDATE lrn_lessons SET status = 'rejected', rejected_at = ? WHERE lesson_id = ? AND status = 'proposed'",
      ).run(e.ts, m.lessonId);
      return;
    }
    case 'lesson.applied': {
      const m = e.meta as MetaOf<'lesson.applied'>;
      db.prepare(
        'INSERT OR IGNORE INTO lrn_lesson_runs (lesson_id, session_id, seq, applied_ms) VALUES (?,?,?,?)',
      ).run(m.lessonId, m.sessionId, e.seq, ms(e.ts));
      return;
    }
    case 'lesson.retired': {
      const m = e.meta as MetaOf<'lesson.retired'>;
      db.prepare(
        "UPDATE lrn_lessons SET status = 'retired', retired_at = ?, retired_ms = ?, retire_reason = ?, runs_unused = ? WHERE lesson_id = ? AND status IN ('proposed','bound')",
      ).run(e.ts, ms(e.ts), m.reason, m.runsUnused, m.lessonId);
      return;
    }
    case 'usage.recorded': {
      const m = e.meta as MetaOf<'usage.recorded'>;
      db.prepare(
        `INSERT OR IGNORE INTO lrn_usage (seq, session_id, model, input, output, cache_read, cache_w5, cache_w1, first_ms, last_ms) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        e.seq,
        m.sessionId,
        m.model,
        m.inputTokens,
        m.outputTokens,
        m.cacheReadTokens,
        m.cacheWrite5mTokens,
        m.cacheWrite1hTokens,
        ms(m.firstAt),
        ms(m.lastAt),
      );
      return;
    }
    case 'tool.used': {
      const m = e.meta as MetaOf<'tool.used'>;
      const paths = p?.filePaths;
      if (!m.fileChanging || !m.ok || !Array.isArray(paths)) return;
      const ins = db.prepare(
        'INSERT OR IGNORE INTO lrn_session_files (session_id, path, first_ms, body_scope) VALUES (?,?,?,?)',
      );
      for (const path of paths)
        if (typeof path === 'string' && path) ins.run(m.sessionId, path, ms(happenedAt(e)), e.bodyScope);
      return;
    }
    case 'ticket.build_started': {
      const m = e.meta as MetaOf<'ticket.build_started'>;
      db.prepare('INSERT OR IGNORE INTO lrn_ticket_sessions (ticket_id, session_id, seq) VALUES (?,?,?)').run(
        m.ticketId,
        m.sessionId,
        e.seq,
      );
      return;
    }
    case 'change.started': {
      const m = e.meta as MetaOf<'change.started'>;
      db.prepare('INSERT OR IGNORE INTO lrn_change_sessions (change_id, session_id, seq) VALUES (?,?,?)').run(
        m.changeId,
        m.sessionId,
        e.seq,
      );
      return;
    }
    case 'rollback.requested': {
      const m = e.meta as MetaOf<'rollback.requested'>;
      db.prepare(
        'INSERT OR IGNORE INTO lrn_rollbacks (rollback_id, project_id, change_id) VALUES (?,?,?)',
      ).run(m.rollbackId, m.projectId, m.changeId);
      return;
    }
  }
}
