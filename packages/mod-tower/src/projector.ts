/**
 * Control Tower projections (`twr_*`). The tower reads only these tables, built from an explicit list of event
 * types, so it is decoupled from other modules' internals and rebuildable from the log at any time (the kernel
 * back-fills them when the tower joins an existing log). Deterministic and timezone-free: no service calls, no clock
 * or config reads — event time is `e.ts`, usage is bucketed by the sidecar's lastAt in 15-minute UTC buckets, and local
 * days are resolved at read time (the kernel may back-fill before modules are initialised with the config).
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  TASK_SIZE_WEIGHT,
  type EventType,
  type JsonValue,
  type MetaOf,
  type StoredEvent,
  type TaskSize,
} from '@aoc/contracts';
import type { Projector } from '@aoc/kernel';
import { stmt } from './sql';

export const TOWER_HANDLES = [
  // sessions & fleet
  'session.launch_requested',
  'session.observed',
  'session.lifecycle_changed',
  'session.liveness_changed',
  'session.ended',
  'usage.recorded',
  'throttle.hit',
  'throttle.cleared',
  // decisions
  'decision.requested',
  'decision.resolved',
  'decision.withdrawn',
  'decision.expired',
  // build ledger
  'project.created',
  'project.updated',
  'plan.declared',
  'plan.amended',
  'task.done',
  // change control, break-glass, provenance
  'change.drafted',
  'change.field_affirmed',
  'change.approved',
  'change.completed',
  'breakglass.invoked',
  'breakglass.approved',
  'breakglass.rejected',
  'breakglass.post_incident_overdue',
  'promotion.requested',
  'promotion.refused',
  'promotion.rejected',
  'promotion.failed',
  'promotion.completed',
  // intake tickets
  'intake.submitted',
  'ticket.triage_started',
  'ticket.escalated_to_human',
  'ticket.fix_plan_submitted',
  'ticket.build_started',
  'ticket.uat_ready',
  'ticket.uat_result',
  'ticket.golive_requested',
  'ticket.closed',
  // credits
  'credit.allocated',
  'credit.cap_reached',
  'credit.auto_granted',
  'credit.topup_requested',
  'credit.topup_granted',
  'credit.topup_denied',
  'credit.topup_withdrawn',
  // fx
  'fx.rate_recorded',
  'fx.discrepancy_raised',
  'fx.discrepancy_resolved',
  'fx.carry_forward_alert',
  // registry playbooks
  'playbook.proposed',
  'playbook.approved',
  'playbook.rejected',
  'playbook.retired',
  // audit integrity & compliance mapping
  'anchor.created',
  'anchor.failed',
  'chain.verified',
  'selfmod.blocked',
  'mapping.published',
  'mapping.stamped',
] as const satisfies readonly EventType[];

export const TOWER_TABLES = [
  'twr_sessions',
  'twr_liveness',
  'twr_usage',
  'twr_throttle_idle',
  'twr_decisions',
  'twr_projects',
  'twr_manifests',
  'twr_tasks',
  'twr_plan_log',
  'twr_amendments',
  'twr_task_done',
  'twr_changes',
  'twr_affirmations',
  'twr_breakglass',
  'twr_promotions',
  'twr_tickets',
  'twr_ticket_links',
  'twr_credit_users',
  'twr_credit_blocked',
  'twr_fx_discrepancies',
  'twr_playbooks',
  'twr_state',
  'twr_mapping_stamps',
  'twr_audit_log',
];

const DDL = [
  `CREATE TABLE IF NOT EXISTS twr_sessions (
    session_id TEXT PRIMARY KEY, mode TEXT NOT NULL,
    project_id TEXT, thread_id TEXT, ticket_id TEXT, owner_id TEXT,
    process_type TEXT, model TEXT, read_only INTEGER NOT NULL DEFAULT 0,
    launched_ms INTEGER NOT NULL, playbook_at_launch INTEGER NOT NULL DEFAULT 0,
    lifecycle TEXT NOT NULL, liveness TEXT, liveness_since_ms INTEGER, ended_ms INTEGER,
    context_tokens INTEGER, context_model TEXT, throttle_started_ms INTEGER, throttle_reset_at TEXT)`,
  `CREATE INDEX IF NOT EXISTS twr_sessions_project ON twr_sessions(project_id)`,
  `CREATE INDEX IF NOT EXISTS twr_sessions_launched ON twr_sessions(launched_ms)`,
  `CREATE TABLE IF NOT EXISTS twr_liveness (seq INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, from_state TEXT, to_state TEXT)`,
  `CREATE INDEX IF NOT EXISTS twr_liveness_ts ON twr_liveness(ts_ms)`,
  // Every real UTC offset is a multiple of 15 minutes, so these buckets fall wholly inside one local day anywhere.
  `CREATE TABLE IF NOT EXISTS twr_usage (
    bucket_ms INTEGER NOT NULL, session_id TEXT NOT NULL, model TEXT NOT NULL,
    input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_w5 INTEGER NOT NULL, cache_w1 INTEGER NOT NULL,
    PRIMARY KEY (bucket_ms, session_id, model))`,
  `CREATE INDEX IF NOT EXISTS twr_usage_session ON twr_usage(session_id)`,
  `CREATE TABLE IF NOT EXISTS twr_throttle_idle (seq INTEGER PRIMARY KEY, session_id TEXT NOT NULL, ts_ms INTEGER NOT NULL, idle_ms INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS twr_throttle_idle_ts ON twr_throttle_idle(ts_ms)`,
  // The recommendation's option id and the due time come from meta, so they survive crypto-shredding of the body.
  `CREATE TABLE IF NOT EXISTS twr_decisions (
    decision_id TEXT PRIMARY KEY, kind TEXT NOT NULL, test TEXT, project_id TEXT, session_id TEXT,
    subject_type TEXT, subject_id TEXT, requester_id TEXT, requires_passkey INTEGER NOT NULL,
    recommended_option_id TEXT, due_ms INTEGER,
    requested_ms INTEGER NOT NULL, status TEXT NOT NULL, resolved_ms INTEGER, method TEXT)`,
  `CREATE INDEX IF NOT EXISTS twr_decisions_status ON twr_decisions(status)`,
  `CREATE INDEX IF NOT EXISTS twr_decisions_resolved ON twr_decisions(resolved_ms)`,
  `CREATE TABLE IF NOT EXISTS twr_projects (project_id TEXT PRIMARY KEY, name TEXT)`,
  // One manifest per declaring session (as the build ledger keeps them). `has_tasks` = 0 when the plan body was
  // crypto-shredded: then only the meta counters below describe it.
  `CREATE TABLE IF NOT EXISTS twr_manifests (
    session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT, task_count INTEGER NOT NULL, total_weight REAL NOT NULL,
    done_count INTEGER NOT NULL DEFAULT 0, done_weight REAL NOT NULL DEFAULT 0, has_tasks INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS twr_manifests_project ON twr_manifests(project_id)`,
  // `meta_only` marks closes of an erased manifest (its counters above already count them); the WIP read is an
  // index-only aggregate over (project_id, meta_only, status, weight).
  `CREATE TABLE IF NOT EXISTS twr_tasks (
    session_id TEXT NOT NULL, task_id TEXT NOT NULL, project_id TEXT NOT NULL, thread_id TEXT, weight REAL NOT NULL, status TEXT NOT NULL,
    meta_only INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session_id, task_id))`,
  `CREATE INDEX IF NOT EXISTS twr_tasks_thread ON twr_tasks(thread_id, task_id)`,
  `CREATE INDEX IF NOT EXISTS twr_tasks_wip ON twr_tasks(project_id, meta_only, status, weight)`,
  `CREATE TABLE IF NOT EXISTS twr_plan_log (seq INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, project_id TEXT, process_type TEXT, task_count INTEGER NOT NULL, xs_count INTEGER)`,
  `CREATE INDEX IF NOT EXISTS twr_plan_log_ts ON twr_plan_log(ts_ms)`,
  `CREATE TABLE IF NOT EXISTS twr_amendments (seq INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, project_id TEXT, process_type TEXT, added_weight REAL NOT NULL, done_ratio REAL NOT NULL, late INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS twr_amendments_ts ON twr_amendments(ts_ms)`,
  `CREATE TABLE IF NOT EXISTS twr_task_done (
    seq INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, project_id TEXT, process_type TEXT,
    verified INTEGER NOT NULL, flag TEXT, evidence_verified INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS twr_task_done_ts ON twr_task_done(ts_ms)`,
  `CREATE TABLE IF NOT EXISTS twr_changes (change_id TEXT PRIMARY KEY, project_id TEXT, approved_ms INTEGER, self_approved INTEGER, completed_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS twr_affirmations (seq INTEGER PRIMARY KEY, ts_ms INTEGER NOT NULL, change_id TEXT NOT NULL, edited INTEGER NOT NULL, dwell_ms REAL NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS twr_affirmations_ts ON twr_affirmations(ts_ms)`,
  `CREATE TABLE IF NOT EXISTS twr_breakglass (
    breakglass_id TEXT PRIMARY KEY, project_id TEXT, decision_id TEXT, invoked_ms INTEGER NOT NULL,
    approved_ms INTEGER, rejected_ms INTEGER, change_id TEXT, due_ms INTEGER, overdue_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS twr_promotions (
    promotion_id TEXT PRIMARY KEY, project_id TEXT, requested_ms INTEGER, refused_ms INTEGER, reason TEXT, orphan_count INTEGER, closed_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS twr_tickets (
    ticket_id TEXT PRIMARY KEY, project_id TEXT, severity TEXT NOT NULL, submitted_ms INTEGER NOT NULL,
    stage TEXT NOT NULL, stage_since_ms INTEGER NOT NULL, uat_passed INTEGER NOT NULL DEFAULT 0, closed_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS twr_ticket_links (decision_id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS twr_credit_users (
    user_id TEXT PRIMARY KEY, period TEXT, capped_since_ms INTEGER,
    pending_request_id TEXT, pending_decision_id TEXT, pending_since_ms INTEGER, pending_usd REAL)`,
  `CREATE TABLE IF NOT EXISTS twr_credit_blocked (user_id TEXT NOT NULL, session_id TEXT NOT NULL, since_ms INTEGER NOT NULL, PRIMARY KEY (user_id, session_id))`,
  `CREATE TABLE IF NOT EXISTS twr_fx_discrepancies (decision_id TEXT PRIMARY KEY, date TEXT NOT NULL, raised_ms INTEGER NOT NULL, resolved INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS twr_playbooks (playbook_id TEXT PRIMARY KEY, process_type TEXT NOT NULL, status TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS twr_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    verified_ms INTEGER, chain_ok INTEGER, first_bad_seq INTEGER, broken_since_ms INTEGER,
    anchor_ms INTEGER, anchor_seq INTEGER, anchor_failed_ms INTEGER, anchor_fail_reason TEXT,
    mapping_version TEXT, mapping_hash TEXT,
    fx_alert_ms INTEGER, fx_alert_days INTEGER, fx_last_live_ms INTEGER)`,
  `CREATE TABLE IF NOT EXISTS twr_mapping_stamps (version TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (version, hash))`,
  `CREATE TABLE IF NOT EXISTS twr_audit_log (seq INTEGER PRIMARY KEY, type TEXT NOT NULL, ts_ms INTEGER NOT NULL, project_id TEXT)`,
  `CREATE INDEX IF NOT EXISTS twr_audit_log_type ON twr_audit_log(type, ts_ms)`,
];

type Payload = Record<string, JsonValue> | null;
type PlanTask = { id?: unknown; size?: unknown };
const metaOf = <T extends EventType>(e: StoredEvent, _type: T) => e.meta as unknown as MetaOf<T>;
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const weightOf = (size: unknown) => TASK_SIZE_WEIGHT[size as TaskSize] ?? 0;

export const USAGE_BUCKET_MS = 15 * 60_000;
/** An amendment is late when it adds weight after this share of the declared work was done. */
export const LATE_DONE_SHARE = 0.5;

export function createTowerProjector(): Projector {
  return {
    name: 'tower',
    tables: TOWER_TABLES,
    ddl: DDL,
    handles: TOWER_HANDLES,
    apply({ db }, e, payload) {
      apply(db, e, payload as Payload);
    },
    onErase(db, scopeId) {
      db.prepare("UPDATE twr_projects SET name = '[erased]' WHERE project_id = ?").run(scopeId);
    },
  };
}

function apply(db: DatabaseSync, e: StoredEvent, p: Payload): void {
  const run = (sql: string, ...args: SQLInputValue[]) => stmt(db, sql).run(...args);
  const get = <T>(sql: string, ...args: SQLInputValue[]) => stmt(db, sql).get(...args) as T | undefined;
  const ts = Date.parse(e.ts);
  /** Rows for sessions first seen through a later event (out-of-order or missing launch). */
  const ensureSession = (sessionId: string) =>
    run(
      "INSERT OR IGNORE INTO twr_sessions (session_id, mode, launched_ms, lifecycle) VALUES (?, 'unknown', ?, 'running')",
      sessionId,
      ts,
    );
  const processTypeOf = (sessionId: string) =>
    get<{ process_type: string | null }>(
      'SELECT process_type FROM twr_sessions WHERE session_id = ?',
      sessionId,
    )?.process_type ?? null;
  const ensureManifest = (sessionId: string, projectId: string) =>
    run(
      'INSERT OR IGNORE INTO twr_manifests (session_id, project_id, thread_id, task_count, total_weight, has_tasks) VALUES (?, ?, NULL, 0, 0, 1)',
      sessionId,
      projectId,
    );
  /**
   * Rollover carry-over (§5), as the build ledger does it: a task id re-declared in the same thread moves from the
   * previous writer session to this one, so it is counted once. The ledger reports how many it carried.
   */
  const addTasks = (
    sessionId: string,
    projectId: string,
    threadId: string | null,
    tasks: PlanTask[],
    carriedOver: number | undefined,
  ) => {
    for (const t of tasks) {
      const id = str(t.id);
      if (!id) continue;
      run(
        "INSERT OR IGNORE INTO twr_tasks (session_id, task_id, project_id, thread_id, weight, status) VALUES (?, ?, ?, ?, ?, 'open')",
        sessionId,
        id,
        projectId,
        threadId,
        weightOf(t.size),
      );
      if (threadId && carriedOver !== 0) {
        run(
          "UPDATE twr_tasks SET status = 'carried' WHERE thread_id = ? AND task_id = ? AND session_id != ? AND status = 'open'",
          threadId,
          id,
          sessionId,
        );
      }
    }
  };
  const state = (sql: string, ...args: SQLInputValue[]) => {
    run('INSERT OR IGNORE INTO twr_state (id) VALUES (1)');
    run(`UPDATE twr_state SET ${sql} WHERE id = 1`, ...args);
  };
  const uncap = (userId: string) => {
    run('UPDATE twr_credit_users SET capped_since_ms = NULL WHERE user_id = ?', userId);
    run('DELETE FROM twr_credit_blocked WHERE user_id = ?', userId);
  };
  const clearPending = (userId: string, requestId: string) =>
    run(
      'UPDATE twr_credit_users SET pending_request_id = NULL, pending_decision_id = NULL, pending_since_ms = NULL, pending_usd = NULL WHERE user_id = ? AND pending_request_id = ?',
      userId,
      requestId,
    );
  const ticketStage = (ticketId: string, stage: string) =>
    run('UPDATE twr_tickets SET stage = ?, stage_since_ms = ? WHERE ticket_id = ?', stage, ts, ticketId);
  const linkTicket = (decisionId: string, ticketId: string) =>
    run(
      'INSERT OR IGNORE INTO twr_ticket_links (decision_id, ticket_id) VALUES (?, ?)',
      decisionId,
      ticketId,
    );
  const closePromotion = (promotionId: string) =>
    run(
      'INSERT INTO twr_promotions (promotion_id, closed_ms) VALUES (?, ?) ON CONFLICT(promotion_id) DO UPDATE SET closed_ms = excluded.closed_ms',
      promotionId,
      ts,
    );

  switch (e.type) {
    // ── sessions & fleet ────────────────────────────────────────────────────
    case 'session.launch_requested': {
      const m = metaOf(e, 'session.launch_requested');
      // Same ownership rule as the sessions directory: the launching human, else the parent session's owner.
      const owner =
        e.actor.kind === 'human'
          ? e.actor.id
          : m.parentSessionId
            ? (get<{ owner_id: string | null }>(
                'SELECT owner_id FROM twr_sessions WHERE session_id = ?',
                m.parentSessionId,
              )?.owner_id ?? null)
            : null;
      const playbook = get(
        'SELECT 1 FROM twr_playbooks WHERE process_type = ? AND status = ? LIMIT 1',
        m.processType,
        'approved',
      )
        ? 1
        : 0;
      run(
        `INSERT INTO twr_sessions (session_id, mode, project_id, thread_id, ticket_id, owner_id, process_type, model, read_only, launched_ms, playbook_at_launch, lifecycle)
         VALUES (?, 'managed', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'launching')
         ON CONFLICT(session_id) DO UPDATE SET mode = 'managed', project_id = excluded.project_id, thread_id = excluded.thread_id, ticket_id = excluded.ticket_id,
           owner_id = COALESCE(excluded.owner_id, owner_id), process_type = excluded.process_type, model = excluded.model, read_only = excluded.read_only,
           launched_ms = excluded.launched_ms, playbook_at_launch = excluded.playbook_at_launch`,
        m.sessionId,
        m.projectId,
        m.threadId,
        m.ticketId,
        owner,
        m.processType,
        m.model,
        m.readOnly ? 1 : 0,
        ts,
        playbook,
      );
      return;
    }
    case 'session.observed': {
      const m = metaOf(e, 'session.observed');
      run(
        `INSERT INTO twr_sessions (session_id, mode, project_id, launched_ms, lifecycle) VALUES (?, 'observed', ?, ?, 'running')
         ON CONFLICT(session_id) DO UPDATE SET mode = 'observed', project_id = COALESCE(excluded.project_id, project_id)`,
        m.sessionId,
        m.projectId,
        ts,
      );
      return;
    }
    case 'session.lifecycle_changed': {
      const m = metaOf(e, 'session.lifecycle_changed');
      ensureSession(m.sessionId);
      run('UPDATE twr_sessions SET lifecycle = ? WHERE session_id = ?', m.to, m.sessionId);
      if (m.to === 'ended' || m.to === 'retired')
        run('UPDATE twr_sessions SET ended_ms = COALESCE(ended_ms, ?) WHERE session_id = ?', ts, m.sessionId);
      return;
    }
    case 'session.liveness_changed': {
      const m = metaOf(e, 'session.liveness_changed');
      ensureSession(m.sessionId);
      run(
        'INSERT OR IGNORE INTO twr_liveness (seq, session_id, ts_ms, from_state, to_state) VALUES (?, ?, ?, ?, ?)',
        e.seq,
        m.sessionId,
        ts,
        m.from,
        m.to,
      );
      run(
        'UPDATE twr_sessions SET liveness = ?, liveness_since_ms = ? WHERE session_id = ?',
        m.to,
        ts,
        m.sessionId,
      );
      return;
    }
    case 'session.ended': {
      const m = metaOf(e, 'session.ended');
      ensureSession(m.sessionId);
      const lifecycle = m.outcome === 'retired' ? 'retired' : m.outcome === 'failed' ? 'failed' : 'ended';
      run(
        'UPDATE twr_sessions SET lifecycle = ?, ended_ms = COALESCE(ended_ms, ?), throttle_started_ms = NULL, throttle_reset_at = NULL WHERE session_id = ?',
        lifecycle,
        ts,
        m.sessionId,
      );
      run('DELETE FROM twr_credit_blocked WHERE session_id = ?', m.sessionId);
      return;
    }
    case 'usage.recorded': {
      const m = metaOf(e, 'usage.recorded');
      const at = Date.parse(m.lastAt);
      const bucket = Math.floor((Number.isNaN(at) ? ts : at) / USAGE_BUCKET_MS) * USAGE_BUCKET_MS;
      run(
        `INSERT INTO twr_usage (bucket_ms, session_id, model, input, output, cache_read, cache_w5, cache_w1) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(bucket_ms, session_id, model) DO UPDATE SET input = input + excluded.input, output = output + excluded.output,
           cache_read = cache_read + excluded.cache_read, cache_w5 = cache_w5 + excluded.cache_w5, cache_w1 = cache_w1 + excluded.cache_w1`,
        bucket,
        m.sessionId,
        m.model,
        m.inputTokens,
        m.outputTokens,
        m.cacheReadTokens,
        m.cacheWrite5mTokens,
        m.cacheWrite1hTokens,
      );
      run(
        'UPDATE twr_sessions SET context_tokens = ?, context_model = ? WHERE session_id = ?',
        m.contextTokens,
        m.model,
        m.sessionId,
      );
      return;
    }
    case 'throttle.hit': {
      const m = metaOf(e, 'throttle.hit');
      ensureSession(m.sessionId);
      run(
        'UPDATE twr_sessions SET throttle_started_ms = COALESCE(throttle_started_ms, ?), throttle_reset_at = ? WHERE session_id = ?',
        ts,
        m.resetAt,
        m.sessionId,
      );
      return;
    }
    case 'throttle.cleared': {
      const m = metaOf(e, 'throttle.cleared');
      run(
        'INSERT OR IGNORE INTO twr_throttle_idle (seq, session_id, ts_ms, idle_ms) VALUES (?, ?, ?, ?)',
        e.seq,
        m.sessionId,
        ts,
        m.idleMs,
      );
      run(
        'UPDATE twr_sessions SET throttle_started_ms = NULL, throttle_reset_at = NULL WHERE session_id = ?',
        m.sessionId,
      );
      return;
    }

    // ── decisions ───────────────────────────────────────────────────────────
    case 'decision.requested': {
      const m = metaOf(e, 'decision.requested');
      const due = m.dueAt ? Date.parse(m.dueAt) : NaN;
      run(
        `INSERT OR IGNORE INTO twr_decisions (decision_id, kind, test, project_id, session_id, subject_type, subject_id, requester_id, requires_passkey,
           recommended_option_id, due_ms, requested_ms, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
        m.decisionId,
        m.kind,
        m.test,
        m.projectId ?? e.scope.projectId ?? null,
        m.sessionId,
        m.subjectType,
        m.subjectId,
        m.requesterId,
        m.requiresPasskey ? 1 : 0,
        m.recommendedOptionId ?? null,
        Number.isNaN(due) ? null : due,
        ts,
      );
      if (m.subjectType === 'ticket') linkTicket(m.decisionId, m.subjectId);
      return;
    }
    case 'decision.resolved': {
      const m = metaOf(e, 'decision.resolved');
      run(
        "UPDATE twr_decisions SET status = 'resolved', resolved_ms = ?, method = ? WHERE decision_id = ?",
        ts,
        m.method,
        m.decisionId,
      );
      return;
    }
    case 'decision.withdrawn':
    case 'decision.expired': {
      const status = e.type === 'decision.expired' ? 'expired' : 'withdrawn';
      run(
        'UPDATE twr_decisions SET status = ? WHERE decision_id = ?',
        status,
        metaOf(e, 'decision.withdrawn').decisionId,
      );
      return;
    }

    // ── build ledger ────────────────────────────────────────────────────────
    case 'project.created':
    case 'project.updated': {
      const m = metaOf(e, 'project.created');
      const name = str(p?.name);
      if (e.type === 'project.created') {
        run(
          'INSERT INTO twr_projects (project_id, name) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET name = excluded.name',
          m.projectId,
          name ?? (p ? null : '[erased]'),
        );
      } else if (name) {
        run(
          'INSERT INTO twr_projects (project_id, name) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET name = excluded.name',
          m.projectId,
          name,
        );
      }
      return;
    }
    case 'plan.declared': {
      const m = metaOf(e, 'plan.declared');
      const phases = Array.isArray(p?.phases) ? (p.phases as { tasks?: PlanTask[] }[]) : (m.shape ?? null);
      const tasks = phases?.flatMap((ph) => ph.tasks ?? []) ?? null;
      run(
        `INSERT INTO twr_manifests (session_id, project_id, thread_id, task_count, total_weight, has_tasks) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO NOTHING`,
        m.sessionId,
        m.projectId,
        m.threadId,
        m.taskCount,
        m.totalWeight,
        tasks ? 1 : 0,
      );
      if (tasks) addTasks(m.sessionId, m.projectId, m.threadId, tasks, m.carriedOver);
      // Task sizes live in the (encrypted) payload; after crypto-shred the manifest is skipped by the xs-heavy signal.
      run(
        'INSERT OR IGNORE INTO twr_plan_log (seq, ts_ms, project_id, process_type, task_count, xs_count) VALUES (?, ?, ?, ?, ?, ?)',
        e.seq,
        ts,
        m.projectId,
        processTypeOf(m.sessionId),
        m.taskCount,
        tasks ? tasks.filter((t) => t.size === 'xs').length : null,
      );
      return;
    }
    case 'plan.amended': {
      const m = metaOf(e, 'plan.amended');
      ensureManifest(m.sessionId, m.projectId);
      const man = get<{ thread_id: string | null; done_weight: number }>(
        'SELECT thread_id, done_weight FROM twr_manifests WHERE session_id = ?',
        m.sessionId,
      )!;
      const doneRatio = m.prevTotalWeight > 0 ? man.done_weight / m.prevTotalWeight : 0;
      const added = Math.max(0, m.newTotalWeight - m.prevTotalWeight);
      run(
        'UPDATE twr_manifests SET task_count = MAX(0, task_count + ? - ?), total_weight = ? WHERE session_id = ?',
        m.added,
        m.removed,
        m.newTotalWeight,
        m.sessionId,
      );
      // The body when there is one, else the shape the ledger chained in meta (sizes and ids survive an erasure).
      const change: { add?: unknown; remove?: unknown; resize?: unknown } | null = p ?? m.shape ?? null;
      if (change) {
        addTasks(
          m.sessionId,
          m.projectId,
          man.thread_id,
          Array.isArray(change.add) ? (change.add as PlanTask[]) : [],
          m.carriedOver,
        );
        for (const id of Array.isArray(change.remove) ? change.remove : []) {
          run(
            "UPDATE twr_tasks SET status = 'removed' WHERE session_id = ? AND task_id = ? AND status = 'open'",
            m.sessionId,
            String(id),
          );
        }
        for (const r of Array.isArray(change.resize) ? (change.resize as { taskId?: unknown; size?: unknown }[]) : []) {
          run(
            "UPDATE twr_tasks SET weight = ? WHERE session_id = ? AND task_id = ? AND status = 'open'",
            weightOf(r.size),
            m.sessionId,
            String(r.taskId),
          );
        }
      }
      run(
        'INSERT OR IGNORE INTO twr_amendments (seq, ts_ms, project_id, process_type, added_weight, done_ratio, late) VALUES (?, ?, ?, ?, ?, ?, ?)',
        e.seq,
        ts,
        m.projectId,
        processTypeOf(m.sessionId),
        added,
        doneRatio,
        added > 0 && doneRatio >= LATE_DONE_SHARE ? 1 : 0,
      );
      return;
    }
    case 'task.done': {
      const m = metaOf(e, 'task.done');
      const closed = run(
        "UPDATE twr_tasks SET status = 'done', weight = ? WHERE session_id = ? AND task_id = ? AND status != 'done'",
        m.weight,
        m.sessionId,
        m.taskId,
      );
      if (closed.changes === 0) {
        // A repeated close never double-counts; a close whose manifest body was erased gets a degraded row.
        if (get('SELECT 1 FROM twr_tasks WHERE session_id = ? AND task_id = ?', m.sessionId, m.taskId))
          return;
        const man = get<{ thread_id: string | null; has_tasks: number }>(
          'SELECT thread_id, has_tasks FROM twr_manifests WHERE session_id = ?',
          m.sessionId,
        );
        run(
          "INSERT INTO twr_tasks (session_id, task_id, project_id, thread_id, weight, status, meta_only) VALUES (?, ?, ?, ?, ?, 'done', ?)",
          m.sessionId,
          m.taskId,
          m.projectId,
          man?.thread_id ?? null,
          m.weight,
          man?.has_tasks === 0 ? 1 : 0,
        );
      }
      ensureManifest(m.sessionId, m.projectId);
      run(
        'UPDATE twr_manifests SET done_count = done_count + 1, done_weight = done_weight + ? WHERE session_id = ?',
        m.weight,
        m.sessionId,
      );
      run(
        'INSERT OR IGNORE INTO twr_task_done (seq, ts_ms, project_id, process_type, verified, flag, evidence_verified) VALUES (?, ?, ?, ?, ?, ?, ?)',
        e.seq,
        ts,
        m.projectId,
        processTypeOf(m.sessionId),
        m.evidenceVerified && m.flag === null ? 1 : 0,
        m.flag,
        m.evidenceVerified ? 1 : 0,
      );
      return;
    }

    // ── change control, break-glass, provenance ─────────────────────────────
    case 'change.drafted': {
      const m = metaOf(e, 'change.drafted');
      run(
        'INSERT INTO twr_changes (change_id, project_id) VALUES (?, ?) ON CONFLICT(change_id) DO UPDATE SET project_id = excluded.project_id',
        m.changeId,
        m.projectId,
      );
      return;
    }
    case 'change.field_affirmed': {
      const m = metaOf(e, 'change.field_affirmed');
      run(
        'INSERT OR IGNORE INTO twr_affirmations (seq, ts_ms, change_id, edited, dwell_ms) VALUES (?, ?, ?, ?, ?)',
        e.seq,
        ts,
        m.changeId,
        m.edited ? 1 : 0,
        m.dwellMs,
      );
      return;
    }
    case 'change.approved': {
      const m = metaOf(e, 'change.approved');
      run(
        `INSERT INTO twr_changes (change_id, approved_ms, self_approved) VALUES (?, ?, ?)
         ON CONFLICT(change_id) DO UPDATE SET approved_ms = excluded.approved_ms, self_approved = excluded.self_approved`,
        m.changeId,
        ts,
        m.selfApproved ? 1 : 0,
      );
      return;
    }
    case 'change.completed': {
      const m = metaOf(e, 'change.completed');
      run(
        'INSERT INTO twr_changes (change_id, completed_ms) VALUES (?, ?) ON CONFLICT(change_id) DO UPDATE SET completed_ms = excluded.completed_ms',
        m.changeId,
        ts,
      );
      return;
    }
    case 'breakglass.invoked': {
      const m = metaOf(e, 'breakglass.invoked');
      run(
        'INSERT OR IGNORE INTO twr_breakglass (breakglass_id, project_id, decision_id, invoked_ms) VALUES (?, ?, ?, ?)',
        m.breakglassId,
        m.projectId,
        m.decisionId,
        ts,
      );
      return;
    }
    case 'breakglass.approved': {
      const m = metaOf(e, 'breakglass.approved');
      run(
        `INSERT INTO twr_breakglass (breakglass_id, decision_id, invoked_ms, approved_ms, change_id, due_ms) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(breakglass_id) DO UPDATE SET approved_ms = excluded.approved_ms, change_id = excluded.change_id, due_ms = excluded.due_ms`,
        m.breakglassId,
        m.decisionId,
        ts,
        ts,
        m.postIncidentChangeId,
        Date.parse(m.dueAt),
      );
      return;
    }
    case 'breakglass.rejected': {
      const m = metaOf(e, 'breakglass.rejected');
      run(
        `INSERT INTO twr_breakglass (breakglass_id, decision_id, invoked_ms, rejected_ms) VALUES (?, ?, ?, ?)
         ON CONFLICT(breakglass_id) DO UPDATE SET rejected_ms = excluded.rejected_ms`,
        m.breakglassId,
        m.decisionId,
        ts,
        ts,
      );
      return;
    }
    case 'breakglass.post_incident_overdue': {
      const m = metaOf(e, 'breakglass.post_incident_overdue');
      run(
        `INSERT INTO twr_breakglass (breakglass_id, invoked_ms, change_id, due_ms, overdue_ms) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(breakglass_id) DO UPDATE SET change_id = COALESCE(change_id, excluded.change_id), due_ms = COALESCE(due_ms, excluded.due_ms),
           overdue_ms = COALESCE(overdue_ms, excluded.overdue_ms)`,
        m.breakglassId,
        ts,
        m.changeId,
        Date.parse(m.dueAt),
        ts,
      );
      return;
    }
    case 'promotion.requested': {
      const m = metaOf(e, 'promotion.requested');
      run(
        'INSERT INTO twr_promotions (promotion_id, project_id, requested_ms) VALUES (?, ?, ?) ON CONFLICT(promotion_id) DO UPDATE SET project_id = excluded.project_id, requested_ms = excluded.requested_ms',
        m.promotionId,
        m.projectId,
        ts,
      );
      return;
    }
    case 'promotion.refused': {
      const m = metaOf(e, 'promotion.refused');
      run(
        `INSERT INTO twr_promotions (promotion_id, project_id, refused_ms, reason, orphan_count) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(promotion_id) DO UPDATE SET project_id = COALESCE(project_id, excluded.project_id), refused_ms = excluded.refused_ms,
           reason = excluded.reason, orphan_count = excluded.orphan_count`,
        m.promotionId,
        m.projectId ?? e.scope.projectId ?? null,
        ts,
        m.reason,
        m.orphanShas.length,
      );
      const project =
        get<{ project_id: string | null }>(
          'SELECT project_id FROM twr_promotions WHERE promotion_id = ?',
          m.promotionId,
        )?.project_id ?? null;
      run(
        'INSERT OR IGNORE INTO twr_audit_log (seq, type, ts_ms, project_id) VALUES (?, ?, ?, ?)',
        e.seq,
        e.type,
        ts,
        project,
      );
      return;
    }
    case 'promotion.rejected':
      closePromotion(metaOf(e, 'promotion.rejected').promotionId);
      return;
    case 'promotion.failed':
      closePromotion(metaOf(e, 'promotion.failed').promotionId);
      return;
    case 'promotion.completed':
      closePromotion(metaOf(e, 'promotion.completed').promotionId);
      return;

    // ── intake tickets (stage machine mirrors the intake flow, §7) ─────────
    case 'intake.submitted': {
      const m = metaOf(e, 'intake.submitted');
      run(
        "INSERT OR IGNORE INTO twr_tickets (ticket_id, project_id, severity, submitted_ms, stage, stage_since_ms) VALUES (?, ?, ?, ?, 'received', ?)",
        m.ticketId,
        e.scope.projectId ?? null,
        m.severity,
        ts,
        ts,
      );
      return;
    }
    case 'ticket.triage_started':
      ticketStage(metaOf(e, 'ticket.triage_started').ticketId, 'triage');
      return;
    case 'ticket.escalated_to_human': {
      const m = metaOf(e, 'ticket.escalated_to_human');
      ticketStage(m.ticketId, 'awaiting_human');
      linkTicket(m.decisionId, m.ticketId);
      return;
    }
    case 'ticket.fix_plan_submitted': {
      const m = metaOf(e, 'ticket.fix_plan_submitted');
      ticketStage(m.ticketId, 'fix_plan_gate');
      linkTicket(m.decisionId, m.ticketId);
      return;
    }
    case 'ticket.build_started':
      ticketStage(metaOf(e, 'ticket.build_started').ticketId, 'building');
      return;
    case 'ticket.uat_ready': {
      const m = metaOf(e, 'ticket.uat_ready');
      ticketStage(m.ticketId, 'uat');
      linkTicket(m.decisionId, m.ticketId);
      return;
    }
    case 'ticket.uat_result': {
      const m = metaOf(e, 'ticket.uat_result');
      if (m.verdict === 'pass') run('UPDATE twr_tickets SET uat_passed = 1 WHERE ticket_id = ?', m.ticketId);
      else {
        run('UPDATE twr_tickets SET uat_passed = 0 WHERE ticket_id = ?', m.ticketId);
        ticketStage(m.ticketId, 'building');
      }
      return;
    }
    case 'ticket.golive_requested': {
      const m = metaOf(e, 'ticket.golive_requested');
      ticketStage(m.ticketId, 'go_live_gate');
      linkTicket(m.decisionId, m.ticketId);
      return;
    }
    case 'ticket.closed': {
      const m = metaOf(e, 'ticket.closed');
      ticketStage(m.ticketId, m.resolution === 'fixed' ? 'completed' : 'closed');
      run('UPDATE twr_tickets SET closed_ms = ? WHERE ticket_id = ?', ts, m.ticketId);
      return;
    }

    // ── credits: who is at the cap, which sessions it holds, pending top-ups ─
    case 'credit.allocated': {
      const m = metaOf(e, 'credit.allocated');
      // A new allocation changes the funding; the next task boundary re-caps if the balance is still exhausted.
      if (get('SELECT 1 FROM twr_credit_users WHERE user_id = ? AND period = ?', m.userId, m.period))
        uncap(m.userId);
      return;
    }
    case 'credit.cap_reached': {
      const m = metaOf(e, 'credit.cap_reached');
      run(
        `INSERT INTO twr_credit_users (user_id, period, capped_since_ms) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET capped_since_ms = CASE WHEN period = excluded.period THEN COALESCE(capped_since_ms, excluded.capped_since_ms) ELSE excluded.capped_since_ms END,
           period = excluded.period`,
        m.userId,
        m.period,
        ts,
      );
      run(
        'INSERT OR IGNORE INTO twr_credit_blocked (user_id, session_id, since_ms) VALUES (?, ?, ?)',
        m.userId,
        m.sessionId,
        ts,
      );
      return;
    }
    case 'credit.auto_granted': {
      const m = metaOf(e, 'credit.auto_granted');
      if (m.balanceAfter > 0) uncap(m.userId);
      return;
    }
    case 'credit.topup_requested': {
      const m = metaOf(e, 'credit.topup_requested');
      run(
        `INSERT INTO twr_credit_users (user_id, period, pending_request_id, pending_decision_id, pending_since_ms, pending_usd) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET pending_request_id = excluded.pending_request_id, pending_decision_id = excluded.pending_decision_id,
           pending_since_ms = excluded.pending_since_ms, pending_usd = excluded.pending_usd`,
        m.userId,
        m.period,
        m.requestId,
        m.decisionId,
        ts,
        m.amountUsd,
      );
      return;
    }
    case 'credit.topup_granted': {
      const m = metaOf(e, 'credit.topup_granted');
      clearPending(m.userId, m.requestId);
      if (m.balanceAfter > 0) uncap(m.userId);
      return;
    }
    case 'credit.topup_denied': {
      const m = metaOf(e, 'credit.topup_denied');
      clearPending(m.userId, m.requestId);
      return;
    }
    case 'credit.topup_withdrawn': {
      const m = metaOf(e, 'credit.topup_withdrawn');
      clearPending(m.userId, m.requestId);
      return;
    }

    // ── fx ──────────────────────────────────────────────────────────────────
    case 'fx.rate_recorded': {
      if (metaOf(e, 'fx.rate_recorded').status === 'live') state('fx_last_live_ms = ?', ts);
      return;
    }
    case 'fx.discrepancy_raised': {
      const m = metaOf(e, 'fx.discrepancy_raised');
      run(
        'INSERT OR IGNORE INTO twr_fx_discrepancies (decision_id, date, raised_ms) VALUES (?, ?, ?)',
        m.decisionId,
        m.date,
        ts,
      );
      return;
    }
    case 'fx.discrepancy_resolved': {
      const m = metaOf(e, 'fx.discrepancy_resolved');
      run(
        'UPDATE twr_fx_discrepancies SET resolved = 1 WHERE decision_id = ? OR date = ?',
        m.decisionId,
        m.date,
      );
      return;
    }
    case 'fx.carry_forward_alert': {
      const m = metaOf(e, 'fx.carry_forward_alert');
      state('fx_alert_ms = ?, fx_alert_days = ?', ts, m.consecutiveDays);
      return;
    }

    // ── registry playbooks (for "launched on the discovery model despite a playbook") ─
    case 'playbook.proposed': {
      const m = metaOf(e, 'playbook.proposed');
      run(
        "INSERT OR IGNORE INTO twr_playbooks (playbook_id, process_type, status) VALUES (?, ?, 'proposed')",
        m.playbookId,
        m.processType,
      );
      return;
    }
    case 'playbook.approved':
    case 'playbook.rejected':
    case 'playbook.retired': {
      const status =
        e.type === 'playbook.approved' ? 'approved' : e.type === 'playbook.rejected' ? 'rejected' : 'retired';
      run(
        'UPDATE twr_playbooks SET status = ? WHERE playbook_id = ?',
        status,
        metaOf(e, 'playbook.retired').playbookId,
      );
      return;
    }

    // ── audit integrity & compliance mapping ────────────────────────────────
    case 'anchor.created': {
      const m = metaOf(e, 'anchor.created');
      state('anchor_ms = ?, anchor_seq = ?', ts, m.seq);
      return;
    }
    case 'anchor.failed': {
      const m = metaOf(e, 'anchor.failed');
      state('anchor_failed_ms = ?, anchor_fail_reason = ?', ts, m.reason);
      return;
    }
    case 'chain.verified': {
      const m = metaOf(e, 'chain.verified');
      state(
        'verified_ms = ?, chain_ok = ?, first_bad_seq = ?, broken_since_ms = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(broken_since_ms, ?) END',
        ts,
        m.ok ? 1 : 0,
        m.firstBadSeq,
        m.ok ? 1 : 0,
        ts,
      );
      return;
    }
    case 'selfmod.blocked': {
      const m = metaOf(e, 'selfmod.blocked');
      const project =
        get<{ project_id: string | null }>(
          'SELECT project_id FROM twr_sessions WHERE session_id = ?',
          m.sessionId,
        )?.project_id ?? null;
      run(
        'INSERT OR IGNORE INTO twr_audit_log (seq, type, ts_ms, project_id) VALUES (?, ?, ?, ?)',
        e.seq,
        e.type,
        ts,
        project,
      );
      return;
    }
    case 'mapping.published': {
      const m = metaOf(e, 'mapping.published');
      state('mapping_version = ?, mapping_hash = ?', m.version, m.hash);
      return;
    }
    case 'mapping.stamped': {
      const m = metaOf(e, 'mapping.stamped');
      run('INSERT OR IGNORE INTO twr_mapping_stamps (version, hash) VALUES (?, ?)', m.version, m.hash);
      return;
    }
  }
}
