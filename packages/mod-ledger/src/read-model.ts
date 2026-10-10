/** Typed queries over the ledger_ projection tables (read side only; writes go through events). */
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import type { EvidenceKind, TaskSize } from '@aoc/contracts';
import { CARRY_SOURCE_SQL } from './projector';

export type TaskStatus = 'open' | 'done' | 'removed' | 'carried';
export type DriftKind = 'off_plan_change' | 'playbook_deviation' | 'scope_growth' | 'overrun';

export interface ProjectRow {
  project_id: string;
  slug: string;
  name: string | null;
  description: string | null;
  repo_path: string | null;
  default_branch: string | null;
  created_at: string;
  created_by: string;
  updated_at: string;
  last_activity_at: string | null;
}
export interface ThreadRow {
  thread_id: string;
  project_id: string;
  title: string | null;
  created_at: string;
  writer_session_id: string | null;
  writer_since: string | null;
}
export interface WriterRow {
  thread_id: string;
  session_id: string;
  acquired_at: string;
  acquired_seq: number;
  released_at: string | null;
  reason: 'ended' | 'rollover' | 'failed' | 'stopped' | null;
}
export interface ManifestRow {
  session_id: string;
  project_id: string;
  thread_id: string | null;
  owner_id: string | null;
  version: number;
  declared_at: string;
  declared_seq: number;
  summary: string | null;
  base_weight: number;
  total_weight: number;
  base_head: string | null;
  base_fingerprint: string | null;
  updated_at: string;
}
export interface PhaseRow {
  session_id: string;
  phase_id: string;
  project_id: string;
  name: string | null;
  ord: number;
  completed_at: string | null;
  pinned_sha: string | null;
  pinned_tag: string | null;
  pinned_at: string | null;
}
export interface TaskRow {
  session_id: string;
  task_id: string;
  project_id: string;
  thread_id: string | null;
  phase_id: string;
  ord: number;
  title: string | null;
  acceptance: string | null;
  size: TaskSize;
  weight: number;
  status: TaskStatus;
  owner_id: string | null;
  added_at: string;
  added_seq: number;
  done_at: string | null;
  done_seq: number | null;
  evidence_kind: EvidenceKind | null;
  evidence_ref: string | null;
  evidence_verified: number | null;
  flag: 'no_file_change' | 'evidence_unverified' | null;
  carried_to: string | null;
}
export interface SessionStateRow {
  session_id: string;
  file_changes_since_close: number;
  file_changes_total: number;
  tool_calls: number;
  last_close_at: string | null;
  last_close_fingerprint: string | null;
  last_close_head: string | null;
  first_activity_at: string | null;
  last_activity_at: string | null;
}
export interface FileRow {
  session_id: string;
  path: string;
  edits: number;
  last_at: string;
}
export interface PlaybookStepRow {
  session_id: string;
  step_key: string;
  playbook_id: string | null;
  step_id: string | null;
  step_index: number | null;
  step_text: string | null;
  state: 'started' | 'done' | 'failed' | 'skipped';
  updated_at: string;
  updated_seq: number;
}
export interface AmendmentRow {
  event_id: string;
  seq: number;
  session_id: string;
  project_id: string;
  by_id: string;
  at: string;
  version: number;
  added: number;
  removed: number;
  resized: number;
  prev_total_weight: number;
  new_total_weight: number;
  reason: string | null;
}
export interface DriftRow {
  event_id: string;
  seq: number;
  session_id: string;
  project_id: string;
  kind: DriftKind;
  severity: 'low' | 'medium' | 'high';
  task_id: string | null;
  at: string;
  detail: string | null;
}
export interface EnhancementRow {
  event_id: string;
  seq: number;
  project_id: string;
  session_id: string | null;
  change_id: string | null;
  by_id: string;
  at: string;
  title: string | null;
  detail: string | null;
}

const TASK_ORDER = `ORDER BY (SELECT p.ord FROM ledger_phases p WHERE p.session_id = t.session_id AND p.phase_id = t.phase_id), t.ord`;

export class LedgerReadModel {
  private readonly stmts = new Map<string, StatementSync>();

  constructor(private readonly db: DatabaseSync) {}

  private stmt(sql: string): StatementSync {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }
  private one<T>(sql: string, ...args: SQLInputValue[]): T | null {
    return (this.stmt(sql).get(...args) as T | undefined) ?? null;
  }
  private many<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...args) as unknown as T[];
  }

  // ── projects & threads ──────────────────────────────────────────────────
  project(projectId: string): ProjectRow | null {
    return this.one('SELECT * FROM ledger_projects WHERE project_id = ?', projectId);
  }
  projects(): ProjectRow[] {
    return this.many('SELECT * FROM ledger_projects ORDER BY created_at, project_id');
  }
  slugTaken(slug: string): boolean {
    return this.one('SELECT 1 AS x FROM ledger_projects WHERE slug = ?', slug) !== null;
  }
  thread(threadId: string): ThreadRow | null {
    return this.one('SELECT * FROM ledger_threads WHERE thread_id = ?', threadId);
  }
  threadsOf(projectId: string): ThreadRow[] {
    return this.many(
      'SELECT * FROM ledger_threads WHERE project_id = ? ORDER BY created_at, thread_id',
      projectId,
    );
  }
  threadsHeldBy(sessionId: string): ThreadRow[] {
    return this.many('SELECT * FROM ledger_threads WHERE writer_session_id = ?', sessionId);
  }
  writers(threadId: string): WriterRow[] {
    return this.many(
      'SELECT * FROM ledger_thread_writers WHERE thread_id = ? ORDER BY acquired_seq',
      threadId,
    );
  }

  // ── manifests, phases, tasks ────────────────────────────────────────────
  manifest(sessionId: string): ManifestRow | null {
    return this.one('SELECT * FROM ledger_manifests WHERE session_id = ?', sessionId);
  }
  hasManifest(sessionId: string): boolean {
    return this.one('SELECT 1 AS x FROM ledger_manifests WHERE session_id = ?', sessionId) !== null;
  }
  /** The boundary stop delivered in the session's current turn, if any (G-54). */
  boundaryStop(sessionId: string): { task_id: string; reason: string } | null {
    return this.one('SELECT task_id, reason FROM ledger_boundary_stops WHERE session_id = ?', sessionId);
  }
  manifestsOfProject(projectId: string): ManifestRow[] {
    return this.many('SELECT * FROM ledger_manifests WHERE project_id = ? ORDER BY declared_seq', projectId);
  }
  manifestsOfThread(threadId: string): ManifestRow[] {
    return this.many('SELECT * FROM ledger_manifests WHERE thread_id = ? ORDER BY declared_seq', threadId);
  }
  phase(sessionId: string, phaseId: string): PhaseRow | null {
    return this.one('SELECT * FROM ledger_phases WHERE session_id = ? AND phase_id = ?', sessionId, phaseId);
  }
  phasesOf(sessionId: string): PhaseRow[] {
    return this.many('SELECT * FROM ledger_phases WHERE session_id = ? ORDER BY ord', sessionId);
  }
  phasesOfProject(projectId: string): PhaseRow[] {
    return this.many('SELECT * FROM ledger_phases WHERE project_id = ?', projectId);
  }
  task(sessionId: string, taskId: string): TaskRow | null {
    return this.one('SELECT * FROM ledger_tasks WHERE session_id = ? AND task_id = ?', sessionId, taskId);
  }
  tasksOf(sessionId: string): TaskRow[] {
    return this.many(`SELECT * FROM ledger_tasks t WHERE t.session_id = ? ${TASK_ORDER}`, sessionId);
  }
  tasksOfProject(projectId: string): TaskRow[] {
    return this.many('SELECT * FROM ledger_tasks WHERE project_id = ? ORDER BY added_seq, ord', projectId);
  }
  openTaskCount(sessionId: string): number {
    return this.one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM ledger_tasks WHERE session_id = ? AND status = 'open'",
      sessionId,
    )!.n;
  }
  /** First open task in manifest order (the one the agent is presumed to be working on). */
  firstOpenTask(sessionId: string): TaskRow | null {
    return this.one(
      `SELECT * FROM ledger_tasks t WHERE t.session_id = ? AND t.status = 'open' ${TASK_ORDER} LIMIT 1`,
      sessionId,
    );
  }
  sessionsWithOpenTasks(): string[] {
    return this.many<{ session_id: string }>(
      "SELECT DISTINCT session_id FROM ledger_tasks WHERE status = 'open' ORDER BY session_id",
    ).map((r) => r.session_id);
  }
  /** Copies of `taskId` in previous writer sessions of the thread (see CARRY_SOURCE_SQL). */
  carrySources(threadId: string, sessionId: string, taskId: string): TaskRow[] {
    return this.many(
      `SELECT * FROM ledger_tasks WHERE status IN ('open', 'done') AND ${CARRY_SOURCE_SQL}`,
      threadId,
      taskId,
      sessionId,
      threadId,
      threadId,
    );
  }

  // ── session activity ────────────────────────────────────────────────────
  sessionState(sessionId: string): SessionStateRow | null {
    return this.one('SELECT * FROM ledger_session_state WHERE session_id = ?', sessionId);
  }
  files(sessionIds: string[]): FileRow[] {
    if (!sessionIds.length) return [];
    return this.db
      .prepare(
        `SELECT * FROM ledger_files WHERE session_id IN (${sessionIds.map(() => '?').join(',')}) ORDER BY path`,
      )
      .all(...sessionIds) as unknown as FileRow[];
  }
  /** Latest tool activity of any session that declared a manifest in the project. */
  lastToolActivityOfProject(projectId: string): string | null {
    return (
      this.one<{ at: string | null }>(
        'SELECT MAX(s.last_activity_at) AS at FROM ledger_session_state s JOIN ledger_manifests m ON m.session_id = s.session_id WHERE m.project_id = ?',
        projectId,
      )?.at ?? null
    );
  }
  playbookSteps(sessionId: string): PlaybookStepRow[] {
    return this.many(
      'SELECT * FROM ledger_playbook_steps WHERE session_id = ? ORDER BY updated_seq',
      sessionId,
    );
  }

  // ── drift, amendments, enhancements ─────────────────────────────────────
  lastDriftAt(sessionId: string, kind: DriftKind): string | null {
    return (
      this.one<{ at: string }>(
        'SELECT at FROM ledger_drift WHERE session_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1',
        sessionId,
        kind,
      )?.at ?? null
    );
  }
  driftCount(sessionId: string, kind?: DriftKind): number {
    return kind
      ? this.one<{ n: number }>(
          'SELECT COUNT(*) AS n FROM ledger_drift WHERE session_id = ? AND kind = ?',
          sessionId,
          kind,
        )!.n
      : this.one<{ n: number }>('SELECT COUNT(*) AS n FROM ledger_drift WHERE session_id = ?', sessionId)!.n;
  }
  driftOfProject(projectId: string): DriftRow[] {
    return this.many('SELECT * FROM ledger_drift WHERE project_id = ? ORDER BY seq', projectId);
  }
  /** Every phase pin recorded in the project (one per session and phase: the latest), oldest first. */
  pinsOfProject(projectId: string): PhaseRow[] {
    return this.many(
      'SELECT * FROM ledger_phases WHERE project_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at, session_id',
      projectId,
    );
  }
  amendmentsOfSession(sessionId: string): AmendmentRow[] {
    return this.many('SELECT * FROM ledger_amendments WHERE session_id = ? ORDER BY seq', sessionId);
  }
  amendmentsOfProject(projectId: string): AmendmentRow[] {
    return this.many('SELECT * FROM ledger_amendments WHERE project_id = ? ORDER BY seq', projectId);
  }
  enhancementsOfProject(projectId: string): EnhancementRow[] {
    return this.many('SELECT * FROM ledger_enhancements WHERE project_id = ? ORDER BY seq', projectId);
  }
}
