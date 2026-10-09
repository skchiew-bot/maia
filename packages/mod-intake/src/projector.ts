import type { DatabaseSync } from 'node:sqlite';
import type { JsonValue, StoredEvent, TicketStage } from '@aoc/contracts';
import type { Projector } from '@aoc/kernel';

export const INTAKE_TABLES = ['itk_tickets', 'itk_attachments', 'itk_sessions', 'itk_decisions', 'itk_promotions'];

const DDL = [
  `CREATE TABLE IF NOT EXISTS itk_tickets (
    ticket_id TEXT PRIMARY KEY, project_id TEXT, requester_id TEXT NOT NULL,
    title TEXT, description TEXT, comment TEXT, severity TEXT NOT NULL,
    stage TEXT NOT NULL, public_status TEXT NOT NULL,
    submitted_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    fix_plan TEXT, fix_plan_session_id TEXT, build_session_id TEXT, build_attempts INTEGER NOT NULL DEFAULT 0,
    triage_round INTEGER NOT NULL DEFAULT 0,
    uat_ref TEXT, uat_sha TEXT, resolution TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS itk_attachments (
    attachment_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, sha256 TEXT NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
    scan TEXT NOT NULL, scanner TEXT NOT NULL, file_name TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS itk_attachments_ticket ON itk_attachments(ticket_id)`,
  `CREATE TABLE IF NOT EXISTS itk_sessions (
    session_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, role TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, started_at TEXT NOT NULL, tokens INTEGER NOT NULL DEFAULT 0,
    confidence REAL, root_cause_class TEXT, root_cause TEXT, fix_plan TEXT, reported_at TEXT, outcome TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS itk_sessions_ticket ON itk_sessions(ticket_id)`,
  `CREATE TABLE IF NOT EXISTS itk_decisions (decision_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS itk_promotions (promotion_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL)`,
];

const HANDLES = [
  'intake.submitted',
  'intake.attachment_stored',
  'ticket.triage_started',
  'ticket.diagnosis_reported',
  'ticket.escalated_to_human',
  'ticket.fix_plan_submitted',
  'ticket.build_started',
  'ticket.uat_ready',
  'ticket.uat_result',
  'ticket.golive_requested',
  'ticket.closed',
  'ticket.public_status_changed',
  'session.launch_requested',
  'session.ended',
  'usage.recorded',
  'decision.requested',
  'decision.resolved',
  'decision.withdrawn',
  'promotion.requested',
] as const;

type P = Record<string, JsonValue> | null;
const s = (v: unknown) => (typeof v === 'string' ? v : null);

function stage(db: DatabaseSync, ticketId: string, st: TicketStage, ts: string): void {
  db.prepare('UPDATE itk_tickets SET stage = ?, updated_at = ? WHERE ticket_id = ?').run(st, ts, ticketId);
}

export const intakeProjector: Projector = {
  name: 'intake',
  tables: INTAKE_TABLES,
  ddl: DDL,
  handles: HANDLES,
  apply({ db }, e: StoredEvent, payload) {
    const p = payload as P;
    const m = e.meta as Record<string, JsonValue>;
    switch (e.type) {
      case 'intake.submitted':
        db.prepare(
          `INSERT OR IGNORE INTO itk_tickets (ticket_id, project_id, requester_id, title, description, comment, severity, stage, public_status, submitted_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'received', 'received', ?, ?)`,
        ).run(m.ticketId as string, e.scope.projectId ?? null, m.requesterId as string, s(p?.title) ?? '[erased]', s(p?.description) ?? '[erased]', s(p?.comment), m.severity as string, e.ts, e.ts);
        break;
      case 'intake.attachment_stored':
        db.prepare('INSERT OR IGNORE INTO itk_attachments (attachment_id, ticket_id, sha256, mime, bytes, scan, scanner, file_name) VALUES (?,?,?,?,?,?,?,?)').run(
          m.attachmentId as string,
          m.ticketId as string,
          m.sha256 as string,
          m.mime as string,
          m.bytes as number,
          m.scan as string,
          m.scanner as string,
          s(p?.fileName) ?? '[erased]',
        );
        break;
      case 'ticket.triage_started':
        db.prepare('UPDATE itk_tickets SET triage_round = triage_round + 1 WHERE ticket_id = ?').run(m.ticketId as string);
        stage(db, m.ticketId as string, 'triage', e.ts);
        break;
      case 'ticket.diagnosis_reported':
        db.prepare("UPDATE itk_sessions SET status = 'reported', confidence = ?, root_cause_class = ?, root_cause = ?, fix_plan = ?, reported_at = ? WHERE session_id = ?").run(
          m.confidence as number,
          // In the body since the class stopped being chained in clear; older events carry it in meta.
          s(p?.rootCauseClass) ?? s(m.rootCauseClass),
          s(p?.rootCause) ?? '[erased]',
          s(p?.fixPlan) ?? '[erased]',
          e.ts,
          m.sessionId as string,
        );
        break;
      case 'ticket.escalated_to_human':
        stage(db, m.ticketId as string, 'awaiting_human', e.ts);
        break;
      case 'ticket.fix_plan_submitted':
        db.prepare('UPDATE itk_tickets SET fix_plan = ?, fix_plan_session_id = ? WHERE ticket_id = ?').run(s(p?.fixPlan) ?? '[erased]', s(m.sourceSessionId), m.ticketId as string);
        stage(db, m.ticketId as string, 'fix_plan_gate', e.ts);
        break;
      case 'ticket.build_started':
        db.prepare('UPDATE itk_tickets SET build_session_id = ?, build_attempts = build_attempts + 1 WHERE ticket_id = ?').run(m.sessionId as string, m.ticketId as string);
        stage(db, m.ticketId as string, 'building', e.ts);
        break;
      case 'ticket.uat_ready':
        db.prepare('UPDATE itk_tickets SET uat_ref = ?, uat_sha = ? WHERE ticket_id = ?').run(m.uatRef as string, m.uatSha as string, m.ticketId as string);
        stage(db, m.ticketId as string, 'uat', e.ts);
        break;
      case 'ticket.uat_result':
        if (m.verdict === 'fail') stage(db, m.ticketId as string, 'building', e.ts);
        break;
      case 'ticket.golive_requested':
        stage(db, m.ticketId as string, 'go_live_gate', e.ts);
        break;
      case 'ticket.closed':
        db.prepare('UPDATE itk_tickets SET resolution = ? WHERE ticket_id = ?').run(m.resolution as string, m.ticketId as string);
        stage(db, m.ticketId as string, m.resolution === 'fixed' ? 'completed' : 'closed', e.ts);
        break;
      case 'ticket.public_status_changed':
        db.prepare('UPDATE itk_tickets SET public_status = ?, updated_at = ? WHERE ticket_id = ?').run(m.publicStatus as string, e.ts, m.ticketId as string);
        break;
      case 'session.launch_requested':
        if (m.ticketId) {
          // Triage sessions are launched before ticket.triage_started increments the round.
          const ticket = db.prepare('SELECT triage_round FROM itk_tickets WHERE ticket_id = ?').get(m.ticketId as string) as { triage_round: number } | undefined;
          const role = m.readOnly ? 'triage' : 'build';
          db.prepare("INSERT OR IGNORE INTO itk_sessions (session_id, ticket_id, role, round, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)").run(
            m.sessionId as string,
            m.ticketId as string,
            role,
            role === 'triage' ? (ticket?.triage_round ?? 0) + 1 : 0,
            e.ts,
          );
        }
        break;
      case 'session.ended':
        db.prepare("UPDATE itk_sessions SET outcome = ?, status = CASE WHEN status = 'running' THEN 'stopped' ELSE status END WHERE session_id = ?").run(m.outcome as string, m.sessionId as string);
        break;
      case 'usage.recorded':
        db.prepare('UPDATE itk_sessions SET tokens = tokens + ? WHERE session_id = ?').run(
          (m.inputTokens as number) + (m.outputTokens as number) + (m.cacheWrite5mTokens as number) + (m.cacheWrite1hTokens as number),
          m.sessionId as string,
        );
        break;
      case 'decision.requested':
        if (m.subjectType === 'ticket') {
          db.prepare("INSERT OR IGNORE INTO itk_decisions (decision_id, ticket_id, kind, status) VALUES (?, ?, ?, 'open')").run(m.decisionId as string, m.subjectId as string, m.kind as string);
        }
        break;
      case 'decision.resolved':
        db.prepare("UPDATE itk_decisions SET status = 'resolved' WHERE decision_id = ?").run(m.decisionId as string);
        break;
      case 'decision.withdrawn':
        db.prepare("UPDATE itk_decisions SET status = 'withdrawn' WHERE decision_id = ?").run(m.decisionId as string);
        break;
      case 'promotion.requested':
        if (m.ticketId) db.prepare('INSERT OR IGNORE INTO itk_promotions (promotion_id, ticket_id) VALUES (?, ?)').run(m.promotionId as string, m.ticketId as string);
        break;
    }
  },
  onErase(db, scopeId) {
    db.prepare("UPDATE itk_tickets SET title = '[erased]', description = '[erased]', comment = NULL, fix_plan = CASE WHEN fix_plan IS NULL THEN NULL ELSE '[erased]' END WHERE ticket_id = ?").run(scopeId);
    db.prepare("UPDATE itk_attachments SET file_name = '[erased]' WHERE ticket_id = ?").run(scopeId);
    // Diagnoses are written under the ticket's key scope and routinely quote the ticket's personal data.
    db.prepare(
      "UPDATE itk_sessions SET root_cause = CASE WHEN root_cause IS NULL THEN NULL ELSE '[erased]' END, fix_plan = CASE WHEN fix_plan IS NULL THEN NULL ELSE '[erased]' END, root_cause_class = NULL WHERE ticket_id = ?",
    ).run(scopeId);
  },
};
