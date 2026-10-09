/**
 * Read model for change control (`chg_` tables). Deterministic and rebuildable from the log; payload === null means the
 * body was crypto-shredded, so free text is stored as NULL and the row is marked erased.
 */
import type { DatabaseSync } from 'node:sqlite';
import {
  BLIND_AFFIRM_DWELL_MS,
  CHANGE_FIELDS,
  type BreakglassDTO,
  type ChangeField,
  type ChangeRequestDTO,
  type ChangeScope,
  type ChangeStatus,
  type EventType,
  type JsonValue,
  type MetaOf,
  type PayloadOf,
  type PromotionDTO,
  type PromotionRefusalReason,
  type RollbackDTO,
  type StoredEvent,
} from '@aoc/contracts';
import type { ProjectionContext, Projector } from '@aoc/kernel';

type SqlValue = string | number | null;
const bind = (x: unknown): SqlValue =>
  x === undefined || x === null
    ? null
    : typeof x === 'boolean'
      ? x
        ? 1
        : 0
      : typeof x === 'number' || typeof x === 'string'
        ? x
        : JSON.stringify(x);

export function run(db: DatabaseSync, sql: string, ...args: unknown[]): void {
  db.prepare(sql).run(...args.map(bind));
}
export function one<T>(db: DatabaseSync, sql: string, ...args: unknown[]): T | null {
  return (db.prepare(sql).get(...args.map(bind)) as T | undefined) ?? null;
}
export function all<T>(db: DatabaseSync, sql: string, ...args: unknown[]): T[] {
  return db.prepare(sql).all(...args.map(bind)) as unknown as T[];
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS chg_projects (project_id TEXT PRIMARY KEY, repo_path TEXT, default_branch TEXT, acceptance_command TEXT)`,
  `CREATE TABLE IF NOT EXISTS chg_changes (
    change_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL, title TEXT,
    drafted_by TEXT NOT NULL, created_by TEXT NOT NULL, owner_id TEXT, created_at TEXT NOT NULL, session_id TEXT, breakglass_id TEXT,
    draft_rollback_ref TEXT, rollback_ref TEXT, rollback_sha TEXT,
    submitted_by TEXT, submitted_at TEXT, self_approvable INTEGER, decision_id TEXT,
    approver_id TEXT, self_approved INTEGER, approved_at TEXT, rejected_by TEXT, rejected_at TEXT, reject_comment TEXT,
    pinned_sha TEXT, pinned_tag TEXT, completed_at TEXT, erased INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS chg_changes_project ON chg_changes(project_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS chg_change_fields (
    change_id TEXT NOT NULL, field TEXT NOT NULL, draft TEXT, value TEXT, affirmed INTEGER NOT NULL DEFAULT 0, edited INTEGER,
    edit_ratio REAL, dwell_ms REAL, blind INTEGER NOT NULL DEFAULT 0, affirmed_by TEXT, affirmed_at TEXT, PRIMARY KEY (change_id, field))`,
  `CREATE TABLE IF NOT EXISTS chg_affirmations (
    seq INTEGER PRIMARY KEY, change_id TEXT NOT NULL, project_id TEXT NOT NULL, field TEXT NOT NULL, user_id TEXT NOT NULL,
    edited INTEGER NOT NULL, edit_ratio REAL NOT NULL, dwell_ms REAL NOT NULL, blind INTEGER NOT NULL, at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS chg_affirmations_user ON chg_affirmations(user_id)`,
  `CREATE TABLE IF NOT EXISTS chg_change_sessions (
    change_id TEXT NOT NULL, session_id TEXT NOT NULL, started_at TEXT NOT NULL, inherited_from TEXT, PRIMARY KEY (change_id, session_id))`,
  `CREATE INDEX IF NOT EXISTS chg_change_sessions_session ON chg_change_sessions(session_id)`,
  `CREATE TABLE IF NOT EXISTS chg_session_tickets (session_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS chg_session_heads (session_id TEXT NOT NULL, project_id TEXT NOT NULL, sha TEXT NOT NULL, PRIMARY KEY (session_id, project_id, sha))`,
  `CREATE TABLE IF NOT EXISTS chg_ticket_state (ticket_id TEXT PRIMARY KEY, fix_plan_decision_id TEXT, fix_plan_approved_at TEXT, uat_verdict TEXT, uat_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS chg_decisions (
    decision_id TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_type TEXT NOT NULL, subject_id TEXT NOT NULL, status TEXT NOT NULL,
    option_id TEXT, resolved_by TEXT, passkey_verified INTEGER, resolved_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS chg_pins (seq INTEGER NOT NULL, project_id TEXT NOT NULL, sha TEXT, tag TEXT, source TEXT NOT NULL, source_id TEXT, at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS chg_pins_project ON chg_pins(project_id)`,
  `CREATE TABLE IF NOT EXISTS chg_rollbacks (
    rollback_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, target_ref TEXT NOT NULL, target_sha TEXT NOT NULL, change_id TEXT, reason TEXT,
    status TEXT NOT NULL, requested_by TEXT NOT NULL, requested_at TEXT NOT NULL, branch TEXT,
    tests_passed INTEGER, tests_failed INTEGER, clean INTEGER, report TEXT, verified_at TEXT, decision_id TEXT,
    approver_id TEXT, passkey_verified INTEGER, approved_at TEXT, rejected_by TEXT, rejected_at TEXT, reject_comment TEXT,
    main_sha_before TEXT, main_sha_after TEXT, executed_at TEXT, failure_reason TEXT, failure_detail TEXT, failed_at TEXT,
    erased INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS chg_breakglass (
    breakglass_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, ref TEXT NOT NULL, sha TEXT NOT NULL, invoked_by TEXT NOT NULL, invoked_at TEXT NOT NULL,
    justification TEXT, decision_id TEXT NOT NULL, status TEXT NOT NULL, approver_id TEXT, passkey_verified INTEGER, approved_at TEXT,
    rejected_by TEXT, rejected_at TEXT, reject_comment TEXT, post_incident_change_id TEXT, due_at TEXT, overdue_at TEXT, promotion_id TEXT,
    erased INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS chg_promotions (
    promotion_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, from_ref TEXT, from_sha TEXT, target_branch TEXT, ticket_id TEXT, change_id TEXT,
    breakglass_id TEXT, status TEXT NOT NULL, requested_by TEXT NOT NULL, requested_at TEXT NOT NULL, decision_id TEXT,
    refused_reason TEXT, orphan_shas TEXT, refused_at TEXT, rejected_by TEXT, rejected_at TEXT, reject_comment TEXT,
    failure_reason TEXT, failure_detail TEXT, failed_at TEXT, main_sha_before TEXT, main_sha_after TEXT, completed_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS chg_promotions_project ON chg_promotions(project_id, requested_at)`,
];

const TABLES = [
  'chg_projects',
  'chg_changes',
  'chg_change_fields',
  'chg_affirmations',
  'chg_change_sessions',
  'chg_session_tickets',
  'chg_session_heads',
  'chg_ticket_state',
  'chg_decisions',
  'chg_pins',
  'chg_rollbacks',
  'chg_breakglass',
  'chg_promotions',
];

/** Decision kinds whose resolution this module acts on, by subject type. */
export const OWN_DECISIONS: Record<string, string> = {
  change: 'change_request',
  rollback: 'rollback',
  breakglass: 'break_glass',
  promotion: 'go_live',
};

const HANDLES = [
  'project.created',
  'project.updated',
  'change.drafted',
  'change.field_affirmed',
  'change.submitted',
  'change.approved',
  'change.rejected',
  'change.started',
  'change.completed',
  'git.ref_pinned',
  'task.done',
  'phase.completed',
  'rollback.requested',
  'rollback.verification_started',
  'rollback.verified',
  'rollback.approved',
  'rollback.rejected',
  'rollback.executed',
  'rollback.failed',
  'breakglass.invoked',
  'breakglass.approved',
  'breakglass.rejected',
  'breakglass.post_incident_overdue',
  'promotion.requested',
  'promotion.refused',
  'promotion.rejected',
  'promotion.failed',
  'promotion.completed',
  'decision.requested',
  'decision.resolved',
  'decision.withdrawn',
  'session.launch_requested',
  'session.rollover_completed',
  'ticket.build_started',
  'ticket.uat_result',
] as const;

const metaOf = <T extends EventType>(e: StoredEvent, _type: T) => e.meta as unknown as MetaOf<T>;
const bodyOf = <T extends EventType>(p: JsonValue | null, _type: T) => p as unknown as PayloadOf<T> | null;
const str = (x: unknown): string | null => (typeof x === 'string' && x.trim() ? x : null);

function apply(db: DatabaseSync, e: StoredEvent, payload: JsonValue | null): void {
  const at = e.ts;
  switch (e.type) {
    case 'project.created':
    case 'project.updated': {
      const p = payload as Record<string, unknown> | null;
      const projectId = String(e.meta.projectId);
      run(
        db,
        `INSERT INTO chg_projects (project_id, repo_path, default_branch, acceptance_command) VALUES (?,?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET repo_path = COALESCE(excluded.repo_path, repo_path),
           default_branch = COALESCE(excluded.default_branch, default_branch), acceptance_command = COALESCE(excluded.acceptance_command, acceptance_command)`,
        projectId,
        str(p?.repoPath),
        str(p?.defaultBranch),
        str(p?.acceptanceCommand),
      );
      return;
    }
    case 'change.drafted': {
      const m = metaOf(e, 'change.drafted');
      const p = bodyOf(payload, 'change.drafted');
      const owner = m.ownerId !== undefined ? m.ownerId : e.actor.kind === 'human' ? e.actor.id : null;
      run(
        db,
        `INSERT OR IGNORE INTO chg_changes (change_id, project_id, scope, status, title, drafted_by, created_by, owner_id, created_at, session_id, breakglass_id,
          draft_rollback_ref, rollback_ref, erased) VALUES (?,?,?,'draft',?,?,?,?,?,?,?,?,?,?)`,
        m.changeId,
        m.projectId,
        m.scope,
        p?.title ?? null,
        m.draftedBy,
        e.actor.id,
        owner,
        at,
        m.sessionId,
        m.breakglassId,
        p?.rollbackRef ?? null,
        p?.rollbackRef ?? null,
        p ? 0 : 1,
      );
      for (const f of CHANGE_FIELDS) {
        const draft = p ? p[f] : null;
        run(
          db,
          'INSERT OR IGNORE INTO chg_change_fields (change_id, field, draft, value) VALUES (?,?,?,?)',
          m.changeId,
          f,
          draft,
          draft,
        );
      }
      return;
    }
    case 'change.field_affirmed': {
      const m = metaOf(e, 'change.field_affirmed');
      const p = bodyOf(payload, 'change.field_affirmed');
      const blind = m.blind ?? (!m.edited && m.dwellMs < BLIND_AFFIRM_DWELL_MS);
      run(
        db,
        `UPDATE chg_change_fields SET value = ?, affirmed = 1, edited = ?, edit_ratio = ?, dwell_ms = ?, blind = ?, affirmed_by = ?, affirmed_at = ?
         WHERE change_id = ? AND field = ?`,
        p?.value ?? null,
        m.edited,
        m.editRatio,
        m.dwellMs,
        blind,
        e.actor.id,
        at,
        m.changeId,
        m.field,
      );
      if (m.field === 'rollbackPlan' && p?.rollbackRef !== undefined)
        run(db, 'UPDATE chg_changes SET rollback_ref = ? WHERE change_id = ?', p.rollbackRef, m.changeId);
      if (!p) run(db, 'UPDATE chg_changes SET erased = 1 WHERE change_id = ?', m.changeId);
      run(
        db,
        `INSERT OR IGNORE INTO chg_affirmations (seq, change_id, project_id, field, user_id, edited, edit_ratio, dwell_ms, blind, at)
         SELECT ?, change_id, project_id, ?, ?, ?, ?, ?, ?, ? FROM chg_changes WHERE change_id = ?`,
        e.seq,
        m.field,
        e.actor.id,
        m.edited,
        m.editRatio,
        m.dwellMs,
        blind,
        at,
        m.changeId,
      );
      return;
    }
    case 'change.submitted': {
      const m = metaOf(e, 'change.submitted');
      run(
        db,
        `UPDATE chg_changes SET status = 'submitted', submitted_by = ?, submitted_at = ?, self_approvable = ?, decision_id = ?, rollback_sha = ? WHERE change_id = ?`,
        e.actor.id,
        at,
        m.selfApprovable,
        m.decisionId,
        m.rollbackSha,
        m.changeId,
      );
      // The rollback point named by an approved-to-be change record is a recorded, immutable SHA (§8).
      if (m.rollbackSha)
        addPin(
          db,
          e,
          `SELECT project_id FROM chg_changes WHERE change_id = ?`,
          m.changeId,
          m.rollbackSha,
          null,
          'change.submitted',
          m.changeId,
        );
      return;
    }
    case 'change.approved': {
      const m = metaOf(e, 'change.approved');
      run(
        db,
        `UPDATE chg_changes SET status = 'approved', approver_id = ?, self_approved = ?, approved_at = ? WHERE change_id = ?`,
        m.approverId,
        m.selfApproved,
        at,
        m.changeId,
      );
      return;
    }
    case 'change.rejected': {
      const m = metaOf(e, 'change.rejected');
      const p = bodyOf(payload, 'change.rejected');
      run(
        db,
        `UPDATE chg_changes SET status = 'rejected', rejected_by = ?, rejected_at = ?, reject_comment = ? WHERE change_id = ?`,
        m.approverId,
        at,
        p?.comment ?? null,
        m.changeId,
      );
      return;
    }
    case 'change.started': {
      const m = metaOf(e, 'change.started');
      run(
        db,
        'INSERT OR IGNORE INTO chg_change_sessions (change_id, session_id, started_at) VALUES (?,?,?)',
        m.changeId,
        m.sessionId,
        at,
      );
      run(
        db,
        `UPDATE chg_changes SET status = 'in_progress' WHERE change_id = ? AND status = 'approved'`,
        m.changeId,
      );
      return;
    }
    case 'change.completed': {
      const m = metaOf(e, 'change.completed');
      run(
        db,
        `UPDATE chg_changes SET status = 'completed', pinned_sha = ?, pinned_tag = ?, completed_at = ? WHERE change_id = ?`,
        m.pinnedSha,
        m.pinnedTag,
        at,
        m.changeId,
      );
      if (m.pinnedSha || m.pinnedTag)
        addPin(
          db,
          e,
          `SELECT project_id FROM chg_changes WHERE change_id = ?`,
          m.changeId,
          m.pinnedSha,
          m.pinnedTag,
          'change.completed',
          m.changeId,
        );
      return;
    }
    case 'git.ref_pinned': {
      const m = metaOf(e, 'git.ref_pinned');
      run(
        db,
        'INSERT INTO chg_pins (seq, project_id, sha, tag, source, source_id, at) VALUES (?,?,?,?,?,?,?)',
        e.seq,
        m.projectId,
        m.sha,
        m.tag,
        'git.ref_pinned',
        m.reason,
        at,
      );
      return;
    }
    case 'task.done': {
      const m = metaOf(e, 'task.done');
      addSessionHead(db, m.sessionId, m.projectId, m.headSha);
      return;
    }
    case 'phase.completed': {
      const m = metaOf(e, 'phase.completed');
      addSessionHead(db, m.sessionId, m.projectId, m.pinnedSha);
      if (m.pinnedSha || m.pinnedTag)
        run(
          db,
          'INSERT INTO chg_pins (seq, project_id, sha, tag, source, source_id, at) VALUES (?,?,?,?,?,?,?)',
          e.seq,
          m.projectId,
          m.pinnedSha,
          m.pinnedTag,
          'phase.completed',
          m.phaseId,
          at,
        );
      return;
    }
    case 'rollback.requested': {
      const m = metaOf(e, 'rollback.requested');
      const p = bodyOf(payload, 'rollback.requested');
      run(
        db,
        `INSERT OR IGNORE INTO chg_rollbacks (rollback_id, project_id, target_ref, target_sha, change_id, reason, status, requested_by, requested_at, erased)
         VALUES (?,?,?,?,?,?,'requested',?,?,?)`,
        m.rollbackId,
        m.projectId,
        m.targetRef,
        m.targetSha,
        m.changeId,
        p?.reason ?? null,
        e.actor.id,
        at,
        p ? 0 : 1,
      );
      return;
    }
    case 'rollback.verification_started': {
      const m = metaOf(e, 'rollback.verification_started');
      run(
        db,
        `UPDATE chg_rollbacks SET status = 'verifying', branch = ? WHERE rollback_id = ? AND status = 'requested'`,
        m.branch,
        m.rollbackId,
      );
      return;
    }
    case 'rollback.verified': {
      const m = metaOf(e, 'rollback.verified');
      const p = bodyOf(payload, 'rollback.verified');
      run(
        db,
        `UPDATE chg_rollbacks SET status = ?, branch = ?, tests_passed = ?, tests_failed = ?, clean = ?, report = ?, verified_at = ?, decision_id = ?,
           erased = MAX(erased, ?) WHERE rollback_id = ?`,
        m.clean ? 'awaiting_approval' : 'not_clean',
        m.branch,
        m.testsPassed,
        m.testsFailed,
        m.clean,
        p?.report ?? null,
        at,
        m.decisionId,
        p ? 0 : 1,
        m.rollbackId,
      );
      return;
    }
    case 'rollback.approved': {
      const m = metaOf(e, 'rollback.approved');
      run(
        db,
        `UPDATE chg_rollbacks SET status = 'approved', approver_id = ?, passkey_verified = ?, approved_at = ? WHERE rollback_id = ?`,
        m.approverId,
        m.passkeyVerified,
        at,
        m.rollbackId,
      );
      return;
    }
    case 'rollback.rejected': {
      const m = metaOf(e, 'rollback.rejected');
      const p = bodyOf(payload, 'rollback.rejected');
      run(
        db,
        `UPDATE chg_rollbacks SET status = 'rejected', rejected_by = ?, rejected_at = ?, reject_comment = ? WHERE rollback_id = ?`,
        m.approverId,
        at,
        p?.comment ?? null,
        m.rollbackId,
      );
      return;
    }
    case 'rollback.executed': {
      const m = metaOf(e, 'rollback.executed');
      run(
        db,
        `UPDATE chg_rollbacks SET status = 'executed', main_sha_before = ?, main_sha_after = ?, executed_at = ? WHERE rollback_id = ?`,
        m.mainShaBefore,
        m.mainShaAfter,
        at,
        m.rollbackId,
      );
      return;
    }
    case 'rollback.failed': {
      const m = metaOf(e, 'rollback.failed');
      const p = bodyOf(payload, 'rollback.failed');
      run(
        db,
        `UPDATE chg_rollbacks SET status = 'failed', failure_reason = ?, failure_detail = ?, failed_at = ? WHERE rollback_id = ?`,
        m.reason,
        p?.detail ?? null,
        at,
        m.rollbackId,
      );
      return;
    }
    case 'breakglass.invoked': {
      const m = metaOf(e, 'breakglass.invoked');
      const p = bodyOf(payload, 'breakglass.invoked');
      run(
        db,
        `INSERT OR IGNORE INTO chg_breakglass (breakglass_id, project_id, ref, sha, invoked_by, invoked_at, justification, decision_id, status, erased)
         VALUES (?,?,?,?,?,?,?,?,'pending',?)`,
        m.breakglassId,
        m.projectId,
        m.ref,
        m.sha,
        m.invokedBy,
        at,
        p?.justification ?? null,
        m.decisionId,
        p ? 0 : 1,
      );
      return;
    }
    case 'breakglass.approved': {
      const m = metaOf(e, 'breakglass.approved');
      run(
        db,
        `UPDATE chg_breakglass SET status = 'approved', approver_id = ?, passkey_verified = ?, approved_at = ?, post_incident_change_id = ?, due_at = ? WHERE breakglass_id = ?`,
        m.approverId,
        m.passkeyVerified,
        at,
        m.postIncidentChangeId,
        m.dueAt,
        m.breakglassId,
      );
      return;
    }
    case 'breakglass.rejected': {
      const m = metaOf(e, 'breakglass.rejected');
      const p = bodyOf(payload, 'breakglass.rejected');
      run(
        db,
        `UPDATE chg_breakglass SET status = 'rejected', rejected_by = ?, rejected_at = ?, reject_comment = ? WHERE breakglass_id = ?`,
        m.approverId,
        at,
        p?.comment ?? null,
        m.breakglassId,
      );
      return;
    }
    case 'breakglass.post_incident_overdue': {
      const m = metaOf(e, 'breakglass.post_incident_overdue');
      run(db, 'UPDATE chg_breakglass SET overdue_at = ? WHERE breakglass_id = ?', at, m.breakglassId);
      return;
    }
    case 'promotion.requested': {
      const m = metaOf(e, 'promotion.requested');
      run(
        db,
        `INSERT OR IGNORE INTO chg_promotions (promotion_id, project_id, from_ref, from_sha, target_branch, ticket_id, change_id, breakglass_id, status, requested_by, requested_at)
         VALUES (?,?,?,?,?,?,?,?,'requested',?,?)`,
        m.promotionId,
        m.projectId,
        m.fromRef,
        m.fromSha,
        m.targetBranch,
        m.ticketId,
        m.changeId,
        m.breakglassId ?? null,
        e.actor.id,
        at,
      );
      if (m.breakglassId)
        run(
          db,
          'UPDATE chg_breakglass SET promotion_id = ? WHERE breakglass_id = ?',
          m.promotionId,
          m.breakglassId,
        );
      return;
    }
    case 'promotion.refused': {
      const m = metaOf(e, 'promotion.refused');
      run(
        db,
        `INSERT INTO chg_promotions (promotion_id, project_id, from_sha, ticket_id, change_id, status, requested_by, requested_at, refused_reason, orphan_shas, refused_at)
         VALUES (?,?,?,?,?,'refused',?,?,?,?,?)
         ON CONFLICT(promotion_id) DO UPDATE SET status = 'refused', refused_reason = excluded.refused_reason, orphan_shas = excluded.orphan_shas, refused_at = excluded.refused_at`,
        m.promotionId,
        m.projectId ?? e.scope.projectId ?? '',
        m.fromSha ?? null,
        e.scope.ticketId ?? null,
        e.scope.changeId ?? null,
        e.actor.id,
        at,
        m.reason,
        JSON.stringify(m.orphanShas),
        at,
      );
      return;
    }
    case 'promotion.rejected': {
      const m = metaOf(e, 'promotion.rejected');
      const p = bodyOf(payload, 'promotion.rejected');
      run(
        db,
        `UPDATE chg_promotions SET status = 'rejected', rejected_by = ?, rejected_at = ?, reject_comment = ? WHERE promotion_id = ?`,
        m.approverId,
        at,
        p?.comment ?? null,
        m.promotionId,
      );
      return;
    }
    case 'promotion.failed': {
      const m = metaOf(e, 'promotion.failed');
      const p = bodyOf(payload, 'promotion.failed');
      run(
        db,
        `UPDATE chg_promotions SET status = 'failed', failure_reason = ?, failure_detail = ?, failed_at = ? WHERE promotion_id = ?`,
        m.reason,
        p?.detail ?? null,
        at,
        m.promotionId,
      );
      return;
    }
    case 'promotion.completed': {
      const m = metaOf(e, 'promotion.completed');
      run(
        db,
        `UPDATE chg_promotions SET status = 'completed', main_sha_before = ?, main_sha_after = ?, completed_at = ?, decision_id = COALESCE(?, decision_id) WHERE promotion_id = ?`,
        m.mainShaBefore,
        m.mainShaAfter,
        at,
        m.decisionId,
        m.promotionId,
      );
      return;
    }
    case 'decision.requested': {
      const m = metaOf(e, 'decision.requested');
      const ours =
        OWN_DECISIONS[m.subjectType] === m.kind || (m.kind === 'fix_plan' && m.subjectType === 'ticket');
      if (!ours) return;
      run(
        db,
        `INSERT OR IGNORE INTO chg_decisions (decision_id, kind, subject_type, subject_id, status) VALUES (?,?,?,?,'open')`,
        m.decisionId,
        m.kind,
        m.subjectType,
        m.subjectId,
      );
      if (m.subjectType === 'promotion')
        run(
          db,
          'UPDATE chg_promotions SET decision_id = ? WHERE promotion_id = ?',
          m.decisionId,
          m.subjectId,
        );
      return;
    }
    case 'decision.resolved': {
      const m = metaOf(e, 'decision.resolved');
      run(
        db,
        `UPDATE chg_decisions SET status = 'resolved', option_id = ?, resolved_by = ?, passkey_verified = ?, resolved_at = ? WHERE decision_id = ?`,
        m.optionId,
        m.resolvedBy,
        m.passkeyVerified,
        at,
        m.decisionId,
      );
      const d = one<{ kind: string; subject_type: string; subject_id: string }>(
        db,
        'SELECT kind, subject_type, subject_id FROM chg_decisions WHERE decision_id = ?',
        m.decisionId,
      );
      if (d?.kind === 'fix_plan' && d.subject_type === 'ticket' && m.optionId === 'approve') {
        run(
          db,
          `INSERT INTO chg_ticket_state (ticket_id, fix_plan_decision_id, fix_plan_approved_at) VALUES (?,?,?)
           ON CONFLICT(ticket_id) DO UPDATE SET fix_plan_decision_id = excluded.fix_plan_decision_id, fix_plan_approved_at = excluded.fix_plan_approved_at`,
          d.subject_id,
          m.decisionId,
          at,
        );
      }
      return;
    }
    case 'decision.withdrawn': {
      const m = metaOf(e, 'decision.withdrawn');
      run(db, `UPDATE chg_decisions SET status = 'withdrawn' WHERE decision_id = ?`, m.decisionId);
      return;
    }
    case 'session.launch_requested': {
      const m = metaOf(e, 'session.launch_requested');
      if (m.ticketId)
        run(
          db,
          'INSERT OR REPLACE INTO chg_session_tickets (session_id, ticket_id) VALUES (?,?)',
          m.sessionId,
          m.ticketId,
        );
      return;
    }
    case 'ticket.build_started': {
      const m = metaOf(e, 'ticket.build_started');
      run(
        db,
        'INSERT OR REPLACE INTO chg_session_tickets (session_id, ticket_id) VALUES (?,?)',
        m.sessionId,
        m.ticketId,
      );
      return;
    }
    case 'session.rollover_completed': {
      // A successor session continues its predecessor's approved work (§5): it inherits the change and ticket links.
      const m = metaOf(e, 'session.rollover_completed');
      run(
        db,
        `INSERT OR IGNORE INTO chg_change_sessions (change_id, session_id, started_at, inherited_from)
         SELECT change_id, ?, ?, ? FROM chg_change_sessions WHERE session_id = ?`,
        m.toSessionId,
        at,
        m.fromSessionId,
        m.fromSessionId,
      );
      run(
        db,
        'INSERT OR IGNORE INTO chg_session_tickets (session_id, ticket_id) SELECT ?, ticket_id FROM chg_session_tickets WHERE session_id = ?',
        m.toSessionId,
        m.fromSessionId,
      );
      return;
    }
    case 'ticket.uat_result': {
      const m = metaOf(e, 'ticket.uat_result');
      run(
        db,
        `INSERT INTO chg_ticket_state (ticket_id, uat_verdict, uat_at) VALUES (?,?,?)
         ON CONFLICT(ticket_id) DO UPDATE SET uat_verdict = excluded.uat_verdict, uat_at = excluded.uat_at`,
        m.ticketId,
        m.verdict,
        at,
      );
      return;
    }
  }
}

const HEX_SHA = /^[0-9a-f]{7,64}$/i;

/** HEADs the ledger read from the session's repo (never agent-supplied): the provenance proof that a commit was its work. */
function addSessionHead(
  db: DatabaseSync,
  sessionId: string,
  projectId: string,
  sha: string | null | undefined,
): void {
  if (sha && HEX_SHA.test(sha))
    run(
      db,
      'INSERT OR IGNORE INTO chg_session_heads (session_id, project_id, sha) VALUES (?,?,?)',
      sessionId,
      projectId,
      sha.toLowerCase(),
    );
}

function addPin(
  db: DatabaseSync,
  e: StoredEvent,
  projectSql: string,
  key: string,
  sha: string | null,
  tag: string | null,
  source: string,
  sourceId: string,
): void {
  const project = one<{ project_id: string }>(db, projectSql, key);
  if (project)
    run(
      db,
      'INSERT INTO chg_pins (seq, project_id, sha, tag, source, source_id, at) VALUES (?,?,?,?,?,?,?)',
      e.seq,
      project.project_id,
      sha,
      tag,
      source,
      sourceId,
      e.ts,
    );
}

/** Crypto-shred: scrub free text belonging to an erased body scope (all change-control bodies are project-scoped). */
function onErase(db: DatabaseSync, scopeId: string): void {
  run(
    db,
    'UPDATE chg_projects SET repo_path = NULL, default_branch = NULL, acceptance_command = NULL WHERE project_id = ?',
    scopeId,
  );
  run(
    db,
    'UPDATE chg_change_fields SET draft = NULL, value = NULL WHERE change_id IN (SELECT change_id FROM chg_changes WHERE project_id = ?)',
    scopeId,
  );
  run(
    db,
    'UPDATE chg_changes SET title = NULL, reject_comment = NULL, draft_rollback_ref = NULL, rollback_ref = NULL, erased = 1 WHERE project_id = ?',
    scopeId,
  );
  run(
    db,
    'UPDATE chg_rollbacks SET reason = NULL, report = NULL, reject_comment = NULL, failure_detail = NULL, erased = 1 WHERE project_id = ?',
    scopeId,
  );
  run(
    db,
    'UPDATE chg_breakglass SET justification = NULL, reject_comment = NULL, erased = 1 WHERE project_id = ?',
    scopeId,
  );
  run(
    db,
    'UPDATE chg_promotions SET reject_comment = NULL, failure_detail = NULL WHERE project_id = ?',
    scopeId,
  );
}

export const changeProjector: Projector = {
  name: 'change',
  tables: TABLES,
  ddl: DDL,
  handles: HANDLES,
  apply: (ctx: ProjectionContext, e, payload) => apply(ctx.db, e, payload),
  onErase,
};

// ── read model ────────────────────────────────────────────────────────────────

export interface ChangeRow {
  change_id: string;
  project_id: string;
  scope: ChangeScope;
  status: ChangeStatus;
  title: string | null;
  drafted_by: 'ai' | 'human';
  created_by: string;
  owner_id: string | null;
  created_at: string;
  session_id: string | null;
  breakglass_id: string | null;
  draft_rollback_ref: string | null;
  rollback_ref: string | null;
  rollback_sha: string | null;
  submitted_by: string | null;
  submitted_at: string | null;
  self_approvable: number | null;
  decision_id: string | null;
  approver_id: string | null;
  self_approved: number | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  reject_comment: string | null;
  pinned_sha: string | null;
  pinned_tag: string | null;
  completed_at: string | null;
  erased: number;
}
export interface FieldRow {
  change_id: string;
  field: ChangeField;
  draft: string | null;
  value: string | null;
  affirmed: number;
  edited: number | null;
  edit_ratio: number | null;
  dwell_ms: number | null;
  blind: number;
  affirmed_by: string | null;
  affirmed_at: string | null;
}
export interface RollbackRow {
  rollback_id: string;
  project_id: string;
  target_ref: string;
  target_sha: string;
  change_id: string | null;
  reason: string | null;
  status: RollbackDTO['status'];
  requested_by: string;
  requested_at: string;
  branch: string | null;
  tests_passed: number | null;
  tests_failed: number | null;
  clean: number | null;
  report: string | null;
  verified_at: string | null;
  decision_id: string | null;
  approver_id: string | null;
  passkey_verified: number | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  reject_comment: string | null;
  main_sha_before: string | null;
  main_sha_after: string | null;
  executed_at: string | null;
  failure_reason: string | null;
  failure_detail: string | null;
  failed_at: string | null;
  erased: number;
}
export interface BreakglassRow {
  breakglass_id: string;
  project_id: string;
  ref: string;
  sha: string;
  invoked_by: string;
  invoked_at: string;
  justification: string | null;
  decision_id: string;
  status: BreakglassDTO['status'];
  approver_id: string | null;
  passkey_verified: number | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  reject_comment: string | null;
  post_incident_change_id: string | null;
  due_at: string | null;
  overdue_at: string | null;
  promotion_id: string | null;
  erased: number;
}
export interface PromotionRow {
  promotion_id: string;
  project_id: string;
  from_ref: string | null;
  from_sha: string | null;
  target_branch: string | null;
  ticket_id: string | null;
  change_id: string | null;
  breakglass_id: string | null;
  status: PromotionDTO['status'];
  requested_by: string;
  requested_at: string;
  decision_id: string | null;
  refused_reason: string | null;
  orphan_shas: string | null;
  refused_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  reject_comment: string | null;
  failure_reason: string | null;
  failure_detail: string | null;
  failed_at: string | null;
  main_sha_before: string | null;
  main_sha_after: string | null;
  completed_at: string | null;
}
export interface DecisionRow {
  decision_id: string;
  kind: string;
  subject_type: string;
  subject_id: string;
  status: string;
  option_id: string | null;
  resolved_by: string | null;
  passkey_verified: number | null;
  resolved_at: string | null;
}
export interface ProjectRow {
  project_id: string;
  repo_path: string | null;
  default_branch: string | null;
  acceptance_command: string | null;
}

/** Change statuses at or past approval: the record cleared its gate. */
export const APPROVED_STATUSES: ReadonlySet<ChangeStatus> = new Set(['approved', 'in_progress', 'completed']);
const APPROVED_SQL = `('approved','in_progress','completed')`;

const flag = (n: number | null): boolean | null => (n === null ? null : n === 1);

export interface ListFilter {
  projectId?: string;
  status?: string;
  limit?: number;
}

/** Typed queries + DTO mapping over the chg_ tables. */
export class ChangeReadModel {
  constructor(
    private readonly db: () => DatabaseSync,
    private readonly now: () => number,
  ) {}

  project(projectId: string): ProjectRow | null {
    return one<ProjectRow>(this.db(), 'SELECT * FROM chg_projects WHERE project_id = ?', projectId);
  }
  change(id: string): ChangeRow | null {
    return one<ChangeRow>(this.db(), 'SELECT * FROM chg_changes WHERE change_id = ?', id);
  }
  fields(changeId: string): FieldRow[] {
    const rows = all<FieldRow>(this.db(), 'SELECT * FROM chg_change_fields WHERE change_id = ?', changeId);
    return CHANGE_FIELDS.map((f) => rows.find((r) => r.field === f)).filter((r): r is FieldRow => !!r);
  }
  rollback(id: string): RollbackRow | null {
    return one<RollbackRow>(this.db(), 'SELECT * FROM chg_rollbacks WHERE rollback_id = ?', id);
  }
  breakglass(id: string): BreakglassRow | null {
    return one<BreakglassRow>(this.db(), 'SELECT * FROM chg_breakglass WHERE breakglass_id = ?', id);
  }
  promotion(id: string): PromotionRow | null {
    return one<PromotionRow>(this.db(), 'SELECT * FROM chg_promotions WHERE promotion_id = ?', id);
  }
  decision(id: string): DecisionRow | null {
    return one<DecisionRow>(this.db(), 'SELECT * FROM chg_decisions WHERE decision_id = ?', id);
  }
  rollbacksIn(statuses: RollbackDTO['status'][]): RollbackRow[] {
    return all<RollbackRow>(
      this.db(),
      `SELECT * FROM chg_rollbacks WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY requested_at`,
      ...statuses,
    );
  }
  overdueCandidates(nowIso: string): BreakglassRow[] {
    return all<BreakglassRow>(
      this.db(),
      `SELECT b.* FROM chg_breakglass b LEFT JOIN chg_changes c ON c.change_id = b.post_incident_change_id
       WHERE b.status = 'approved' AND b.overdue_at IS NULL AND b.due_at IS NOT NULL AND b.due_at < ? AND (c.status IS NULL OR c.status != 'completed')`,
      nowIso,
    );
  }
  pinsByTag(projectId: string, tag: string): { sha: string | null }[] {
    return all<{ sha: string | null }>(
      this.db(),
      'SELECT sha FROM chg_pins WHERE project_id = ? AND tag = ?',
      projectId,
      tag,
    );
  }
  isPinnedSha(projectId: string, sha: string): boolean {
    return !!one(
      this.db(),
      'SELECT 1 FROM chg_pins WHERE project_id = ? AND sha IS NOT NULL AND length(sha) >= 7 AND substr(?, 1, length(sha)) = sha',
      projectId,
      sha,
    );
  }
  pins(projectId: string, limit = 8): { sha: string | null; tag: string | null }[] {
    return all(
      this.db(),
      'SELECT sha, tag FROM chg_pins WHERE project_id = ? ORDER BY seq DESC LIMIT ?',
      projectId,
      limit,
    );
  }
  approvedChangesForSession(sessionId: string, projectId: string): string[] {
    return all<{ change_id: string }>(
      this.db(),
      `SELECT c.change_id FROM chg_change_sessions s JOIN chg_changes c ON c.change_id = s.change_id
       WHERE s.session_id = ? AND c.project_id = ? AND c.status IN ${APPROVED_SQL} ORDER BY c.change_id`,
      sessionId,
      projectId,
    ).map((r) => r.change_id);
  }
  /** Hex SHAs the ledger recorded as the session's HEAD (task.done, phase.completed). */
  sessionHeads(sessionId: string, projectId: string): string[] {
    return all<{ sha: string }>(
      this.db(),
      'SELECT sha FROM chg_session_heads WHERE session_id = ? AND project_id = ? ORDER BY sha',
      sessionId,
      projectId,
    ).map((r) => r.sha);
  }
  sessionTicket(sessionId: string): string | null {
    return (
      one<{ ticket_id: string }>(
        this.db(),
        'SELECT ticket_id FROM chg_session_tickets WHERE session_id = ?',
        sessionId,
      )?.ticket_id ?? null
    );
  }
  ticketFixPlanApproved(ticketId: string): boolean {
    return !!one(
      this.db(),
      'SELECT 1 FROM chg_ticket_state WHERE ticket_id = ? AND fix_plan_approved_at IS NOT NULL',
      ticketId,
    );
  }
  ticketUat(ticketId: string): string | null {
    return (
      one<{ uat_verdict: string | null }>(
        this.db(),
        'SELECT uat_verdict FROM chg_ticket_state WHERE ticket_id = ?',
        ticketId,
      )?.uat_verdict ?? null
    );
  }
  affirmationCounts(
    projectId?: string,
  ): { user_id: string; n: number; unedited: number; flagged: number; ratio_sum: number }[] {
    return all(
      this.db(),
      `SELECT user_id, COUNT(*) AS n, SUM(CASE WHEN edited = 0 THEN 1 ELSE 0 END) AS unedited, SUM(blind) AS flagged, SUM(edit_ratio) AS ratio_sum
       FROM chg_affirmations ${projectId ? 'WHERE project_id = ?' : ''} GROUP BY user_id`,
      ...(projectId ? [projectId] : []),
    );
  }

  private list<T>(table: string, timeCol: string, f: ListFilter): T[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.projectId) (where.push('project_id = ?'), args.push(f.projectId));
    if (f.status) (where.push('status = ?'), args.push(f.status));
    return all<T>(
      this.db(),
      `SELECT * FROM ${table} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${timeCol} DESC LIMIT ?`,
      ...args,
      f.limit ?? 100,
    );
  }

  // ── DTOs ──
  changeDto(id: string): ChangeRequestDTO | null {
    const c = this.change(id);
    if (!c) return null;
    const fields = this.fields(id);
    const bg = c.breakglass_id ? this.breakglass(c.breakglass_id) : null;
    const dueAt = bg?.post_incident_change_id === c.change_id ? bg.due_at : null;
    return {
      changeId: c.change_id,
      projectId: c.project_id,
      scope: c.scope,
      status: c.status,
      title: c.title,
      draftedBy: c.drafted_by,
      createdBy: c.created_by,
      ownerId: c.owner_id,
      createdAt: c.created_at,
      sessionId: c.session_id,
      breakglassId: c.breakglass_id,
      dueAt,
      overdue: !!dueAt && c.status !== 'completed' && Date.parse(dueAt) < this.now(),
      fields: fields.map((f) => ({
        field: f.field,
        draft: f.draft,
        value: f.value,
        affirmed: f.affirmed === 1,
        edited: flag(f.edited),
        editRatio: f.edit_ratio,
        dwellMs: f.dwell_ms,
        blind: f.blind === 1,
        affirmedBy: f.affirmed_by,
        affirmedAt: f.affirmed_at,
      })),
      affirmedCount: fields.filter((f) => f.affirmed === 1).length,
      rollbackRef: c.rollback_ref,
      rollbackSha: c.rollback_sha,
      submittedBy: c.submitted_by,
      submittedAt: c.submitted_at,
      selfApprovable: flag(c.self_approvable),
      decisionId: c.decision_id,
      approval:
        c.approved_at && c.approver_id
          ? { approverId: c.approver_id, selfApproved: c.self_approved === 1, at: c.approved_at }
          : null,
      rejection:
        c.rejected_at && c.rejected_by
          ? { approverId: c.rejected_by, at: c.rejected_at, comment: c.reject_comment }
          : null,
      sessions: all<{ session_id: string; started_at: string; inherited_from: string | null }>(
        this.db(),
        'SELECT session_id, started_at, inherited_from FROM chg_change_sessions WHERE change_id = ? ORDER BY started_at',
        id,
      ).map((s) => ({ sessionId: s.session_id, startedAt: s.started_at, inheritedFrom: s.inherited_from })),
      completedAt: c.completed_at,
      pinnedSha: c.pinned_sha,
      pinnedTag: c.pinned_tag,
      erased: c.erased === 1,
    };
  }
  changes(f: ListFilter): ChangeRequestDTO[] {
    return this.list<ChangeRow>('chg_changes', 'created_at', f).map((r) => this.changeDto(r.change_id)!);
  }

  rollbackDto(id: string): RollbackDTO | null {
    const r = this.rollback(id);
    if (!r) return null;
    return {
      rollbackId: r.rollback_id,
      projectId: r.project_id,
      targetRef: r.target_ref,
      targetSha: r.target_sha,
      changeId: r.change_id,
      reason: r.reason,
      status: r.status,
      requestedBy: r.requested_by,
      requestedAt: r.requested_at,
      verification:
        r.verified_at && r.branch
          ? {
              branch: r.branch,
              testsPassed: r.tests_passed ?? 0,
              testsFailed: r.tests_failed ?? 0,
              clean: r.clean === 1,
              report: r.report,
              at: r.verified_at,
            }
          : null,
      decisionId: r.decision_id,
      approval:
        r.approved_at && r.approver_id
          ? { approverId: r.approver_id, passkeyVerified: r.passkey_verified === 1, at: r.approved_at }
          : null,
      rejection:
        r.rejected_at && r.rejected_by
          ? { approverId: r.rejected_by, at: r.rejected_at, comment: r.reject_comment }
          : null,
      execution:
        r.executed_at && r.main_sha_before && r.main_sha_after
          ? { mainShaBefore: r.main_sha_before, mainShaAfter: r.main_sha_after, at: r.executed_at }
          : null,
      failure:
        r.failed_at && r.failure_reason
          ? { reason: r.failure_reason, detail: r.failure_detail, at: r.failed_at }
          : null,
      erased: r.erased === 1,
    };
  }
  rollbacks(f: ListFilter): RollbackDTO[] {
    return this.list<RollbackRow>('chg_rollbacks', 'requested_at', f).map((r) =>
      this.rollbackDto(r.rollback_id)!,
    );
  }

  promotionDto(id: string): PromotionDTO | null {
    const p = this.promotion(id);
    if (!p) return null;
    const approver = p.decision_id ? (this.decision(p.decision_id)?.resolved_by ?? null) : null;
    return {
      promotionId: p.promotion_id,
      projectId: p.project_id,
      fromRef: p.from_ref,
      fromSha: p.from_sha,
      targetBranch: p.target_branch,
      ticketId: p.ticket_id,
      changeId: p.change_id,
      breakglassId: p.breakglass_id,
      breakglass: !!p.breakglass_id,
      status: p.status,
      requestedBy: p.requested_by,
      requestedAt: p.requested_at,
      decisionId: p.decision_id,
      refusal:
        p.refused_at && p.refused_reason
          ? {
              reason: p.refused_reason as PromotionRefusalReason,
              orphanShas: JSON.parse(p.orphan_shas ?? '[]') as string[],
              at: p.refused_at,
            }
          : null,
      rejection:
        p.rejected_at && p.rejected_by
          ? { approverId: p.rejected_by, at: p.rejected_at, comment: p.reject_comment }
          : null,
      failure:
        p.failed_at && p.failure_reason
          ? { reason: p.failure_reason, detail: p.failure_detail, at: p.failed_at }
          : null,
      completion:
        p.completed_at && p.main_sha_before && p.main_sha_after
          ? {
              mainShaBefore: p.main_sha_before,
              mainShaAfter: p.main_sha_after,
              approverId: approver,
              at: p.completed_at,
            }
          : null,
    };
  }
  promotions(f: ListFilter): PromotionDTO[] {
    return this.list<PromotionRow>('chg_promotions', 'requested_at', f).map((r) =>
      this.promotionDto(r.promotion_id)!,
    );
  }

  breakglassDto(id: string): BreakglassDTO | null {
    const b = this.breakglass(id);
    if (!b) return null;
    const post = b.post_incident_change_id ? this.change(b.post_incident_change_id) : null;
    return {
      breakglassId: b.breakglass_id,
      projectId: b.project_id,
      ref: b.ref,
      sha: b.sha,
      invokedBy: b.invoked_by,
      invokedAt: b.invoked_at,
      justification: b.justification,
      decisionId: b.decision_id,
      status: b.status,
      approval:
        b.approved_at && b.approver_id
          ? { approverId: b.approver_id, passkeyVerified: b.passkey_verified === 1, at: b.approved_at }
          : null,
      rejection:
        b.rejected_at && b.rejected_by
          ? { approverId: b.rejected_by, at: b.rejected_at, comment: b.reject_comment }
          : null,
      postIncidentChangeId: b.post_incident_change_id,
      postIncidentStatus: post?.status ?? null,
      dueAt: b.due_at,
      overdue: !!b.due_at && post?.status !== 'completed' && Date.parse(b.due_at) < this.now(),
      overdueFlaggedAt: b.overdue_at,
      promotion: b.promotion_id ? this.promotionDto(b.promotion_id) : null,
      erased: b.erased === 1,
    };
  }
  breakglasses(f: ListFilter): BreakglassDTO[] {
    return this.list<BreakglassRow>('chg_breakglass', 'invoked_at', f).map((r) =>
      this.breakglassDto(r.breakglass_id)!,
    );
  }
}
