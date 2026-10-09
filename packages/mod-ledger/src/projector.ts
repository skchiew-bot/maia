/**
 * Build-ledger projection. Deterministic and rebuildable from the log; bodies may be crypto-shredded
 * (payload === null), in which case rows are rebuilt from meta and free text shows as "[erased]".
 */
import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import type { JsonValue, MetaOf, PayloadOf, StoredEvent, TaskSize } from '@aoc/contracts';
import type { Projector } from '@aoc/kernel';
import { normalizeStep, sizeOfWeight, weightOfSize } from './rules';

export const LEDGER_TABLES = [
  'ledger_projects',
  'ledger_threads',
  'ledger_thread_writers',
  'ledger_manifests',
  'ledger_phases',
  'ledger_tasks',
  'ledger_session_state',
  'ledger_files',
  'ledger_playbook_steps',
  'ledger_drift',
  'ledger_amendments',
  'ledger_enhancements',
] as const;

const DDL = [
  `CREATE TABLE IF NOT EXISTS ledger_projects (
    project_id TEXT PRIMARY KEY, slug TEXT NOT NULL, name TEXT, description TEXT, repo_path TEXT, default_branch TEXT,
    created_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_at TEXT NOT NULL, last_activity_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ledger_threads (
    thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT, created_at TEXT NOT NULL,
    writer_session_id TEXT, writer_since TEXT)`,
  `CREATE INDEX IF NOT EXISTS ledger_threads_project ON ledger_threads(project_id)`,
  `CREATE TABLE IF NOT EXISTS ledger_thread_writers (
    thread_id TEXT NOT NULL, session_id TEXT NOT NULL, acquired_at TEXT NOT NULL, acquired_seq INTEGER NOT NULL,
    released_at TEXT, reason TEXT, PRIMARY KEY (thread_id, acquired_seq))`,
  `CREATE INDEX IF NOT EXISTS ledger_thread_writers_session ON ledger_thread_writers(session_id)`,
  `CREATE TABLE IF NOT EXISTS ledger_manifests (
    session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT, owner_id TEXT, version INTEGER NOT NULL,
    declared_at TEXT NOT NULL, declared_seq INTEGER NOT NULL, summary TEXT, base_weight INTEGER NOT NULL,
    total_weight INTEGER NOT NULL, base_head TEXT, base_fingerprint TEXT, updated_at TEXT NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS ledger_manifests_project ON ledger_manifests(project_id)`,
  `CREATE INDEX IF NOT EXISTS ledger_manifests_thread ON ledger_manifests(thread_id)`,
  `CREATE TABLE IF NOT EXISTS ledger_phases (
    session_id TEXT NOT NULL, phase_id TEXT NOT NULL, project_id TEXT NOT NULL, name TEXT, ord INTEGER NOT NULL,
    completed_at TEXT, pinned_sha TEXT, pinned_tag TEXT, pinned_at TEXT, PRIMARY KEY (session_id, phase_id))`,
  `CREATE INDEX IF NOT EXISTS ledger_phases_project ON ledger_phases(project_id)`,
  `CREATE TABLE IF NOT EXISTS ledger_tasks (
    session_id TEXT NOT NULL, task_id TEXT NOT NULL, project_id TEXT NOT NULL, thread_id TEXT, phase_id TEXT NOT NULL,
    ord INTEGER NOT NULL, title TEXT, acceptance TEXT, size TEXT NOT NULL, weight INTEGER NOT NULL, status TEXT NOT NULL,
    owner_id TEXT, added_at TEXT NOT NULL, added_seq INTEGER NOT NULL, done_at TEXT, done_seq INTEGER,
    evidence_kind TEXT, evidence_ref TEXT, evidence_verified INTEGER, flag TEXT, carried_to TEXT,
    PRIMARY KEY (session_id, task_id))`,
  `CREATE INDEX IF NOT EXISTS ledger_tasks_project ON ledger_tasks(project_id)`,
  `CREATE INDEX IF NOT EXISTS ledger_tasks_thread ON ledger_tasks(thread_id, task_id)`,
  `CREATE TABLE IF NOT EXISTS ledger_session_state (
    session_id TEXT PRIMARY KEY, file_changes_since_close INTEGER NOT NULL DEFAULT 0,
    file_changes_total INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0, last_close_at TEXT,
    last_close_fingerprint TEXT, last_close_head TEXT, first_activity_at TEXT, last_activity_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ledger_files (
    session_id TEXT NOT NULL, path TEXT NOT NULL, edits INTEGER NOT NULL, last_at TEXT NOT NULL,
    PRIMARY KEY (session_id, path))`,
  `CREATE TABLE IF NOT EXISTS ledger_playbook_steps (
    session_id TEXT NOT NULL, step_key TEXT NOT NULL, playbook_id TEXT, step_id TEXT, step_index INTEGER,
    step_text TEXT, state TEXT NOT NULL, updated_at TEXT NOT NULL, updated_seq INTEGER NOT NULL,
    PRIMARY KEY (session_id, step_key))`,
  `CREATE TABLE IF NOT EXISTS ledger_drift (
    event_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
    kind TEXT NOT NULL, severity TEXT NOT NULL, task_id TEXT, at TEXT NOT NULL, detail TEXT)`,
  `CREATE INDEX IF NOT EXISTS ledger_drift_session ON ledger_drift(session_id, kind, seq)`,
  `CREATE TABLE IF NOT EXISTS ledger_amendments (
    event_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
    by_id TEXT NOT NULL, at TEXT NOT NULL, version INTEGER NOT NULL, added INTEGER NOT NULL, removed INTEGER NOT NULL,
    resized INTEGER NOT NULL, prev_total_weight INTEGER NOT NULL, new_total_weight INTEGER NOT NULL, reason TEXT)`,
  `CREATE INDEX IF NOT EXISTS ledger_amendments_project ON ledger_amendments(project_id, seq)`,
  `CREATE TABLE IF NOT EXISTS ledger_enhancements (
    event_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, project_id TEXT NOT NULL, session_id TEXT, change_id TEXT,
    by_id TEXT NOT NULL, at TEXT NOT NULL, title TEXT, detail TEXT)`,
  `CREATE INDEX IF NOT EXISTS ledger_enhancements_project ON ledger_enhancements(project_id, seq)`,
];

/** Key pairing started/done reports of one step: the playbook step id, else a hash of the reported text. */
function playbookStepKey(
  stepId: string | null | undefined,
  stepText: string | null | undefined,
): string | null {
  if (stepId) return `id:${stepId}`;
  if (stepText) return `h:${createHash('sha256').update(normalizeStep(stepText)).digest('hex').slice(0, 32)}`;
  return null;
}

type Handler = (db: DatabaseSync, e: StoredEvent, payload: JsonValue | null) => void;

function touchProject(db: DatabaseSync, projectId: string, ts: string): void {
  db.prepare('UPDATE ledger_projects SET last_activity_at = ? WHERE project_id = ?').run(ts, projectId);
}

function ensureSessionState(db: DatabaseSync, sessionId: string): void {
  db.prepare(
    'INSERT INTO ledger_session_state (session_id) VALUES (?) ON CONFLICT(session_id) DO NOTHING',
  ).run(sessionId);
}

function ensurePhase(
  db: DatabaseSync,
  sessionId: string,
  phaseId: string,
  projectId: string,
  name: string | null,
): void {
  const next = (
    db
      .prepare('SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM ledger_phases WHERE session_id = ?')
      .get(sessionId) as { n: number }
  ).n;
  db.prepare(
    `INSERT INTO ledger_phases (session_id, phase_id, project_id, name, ord) VALUES (?,?,?,?,?)
     ON CONFLICT(session_id, phase_id) DO NOTHING`,
  ).run(sessionId, phaseId, projectId, name, next);
}

interface NewTask {
  sessionId: string;
  taskId: string;
  projectId: string;
  threadId: string | null;
  phaseId: string;
  title: string | null;
  acceptance: string | null;
  size: TaskSize;
  ownerId: string | null;
  ts: string;
  seq: number;
}

function insertTask(db: DatabaseSync, t: NewTask): void {
  const ord = (
    db
      .prepare(
        'SELECT COALESCE(MAX(ord), -1) + 1 AS n FROM ledger_tasks WHERE session_id = ? AND phase_id = ?',
      )
      .get(t.sessionId, t.phaseId) as { n: number }
  ).n;
  db.prepare(
    `INSERT INTO ledger_tasks (session_id, task_id, project_id, thread_id, phase_id, ord, title, acceptance, size, weight, status, owner_id, added_at, added_seq)
     VALUES (?,?,?,?,?,?,?,?,?,?,'open',?,?,?) ON CONFLICT(session_id, task_id) DO NOTHING`,
  ).run(
    t.sessionId,
    t.taskId,
    t.projectId,
    t.threadId,
    t.phaseId,
    ord,
    t.title,
    t.acceptance,
    t.size,
    weightOfSize(t.size),
    t.ownerId,
    t.ts,
    t.seq,
  );
}

/**
 * Rollover carry-over (§5): re-declaring a task id that is still open in a previous writer session of the
 * same thread moves it to the new session, so the master timeline counts it once. Only sessions that
 * held and released the thread's writer lock are sources (never parallel read-only sessions).
 */
export const CARRY_SOURCE_SQL = `thread_id = ? AND task_id = ? AND session_id <> ? AND session_id IN (
    SELECT w.session_id FROM ledger_thread_writers w WHERE w.thread_id = ? AND w.released_at IS NOT NULL
      AND w.session_id NOT IN (SELECT writer_session_id FROM ledger_threads WHERE thread_id = ? AND writer_session_id IS NOT NULL))`;

function carryOver(db: DatabaseSync, threadId: string, sessionId: string, taskIds: string[]): void {
  const stmt = db.prepare(
    `UPDATE ledger_tasks SET status = 'carried', carried_to = ? WHERE status = 'open' AND ${CARRY_SOURCE_SQL}`,
  );
  for (const id of taskIds) stmt.run(sessionId, threadId, id, sessionId, threadId, threadId);
}

const handlers: Record<string, Handler> = {
  'project.created'(db, e, p) {
    const m = e.meta as MetaOf<'project.created'>;
    const b = p as PayloadOf<'project.created'> | null;
    db.prepare(
      `INSERT INTO ledger_projects (project_id, slug, name, description, repo_path, default_branch, created_at, created_by, updated_at, last_activity_at)
       VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO NOTHING`,
    ).run(
      m.projectId,
      m.slug,
      b?.name ?? null,
      b?.description ?? null,
      b?.repoPath ?? null,
      b?.defaultBranch ?? null,
      e.ts,
      e.actor.id,
      e.ts,
      e.ts,
    );
  },

  'project.updated'(db, e, p) {
    const m = e.meta as MetaOf<'project.updated'>;
    const b = (p ?? {}) as PayloadOf<'project.updated'>;
    const sets = ['updated_at = ?'];
    const args: (string | null)[] = [e.ts];
    const cols = {
      name: 'name',
      description: 'description',
      repoPath: 'repo_path',
      defaultBranch: 'default_branch',
    } as const;
    for (const [k, col] of Object.entries(cols) as [keyof typeof cols, string][]) {
      if (typeof b[k] === 'string') {
        sets.push(`${col} = ?`);
        args.push(b[k] as string);
      }
    }
    db.prepare(`UPDATE ledger_projects SET ${sets.join(', ')} WHERE project_id = ?`).run(
      ...args,
      m.projectId,
    );
  },

  'thread.created'(db, e, p) {
    const m = e.meta as MetaOf<'thread.created'>;
    const b = p as PayloadOf<'thread.created'> | null;
    db.prepare(
      'INSERT INTO ledger_threads (thread_id, project_id, title, created_at) VALUES (?,?,?,?) ON CONFLICT(thread_id) DO NOTHING',
    ).run(m.threadId, m.projectId, b?.title ?? null, e.ts);
  },

  'thread.writer_acquired'(db, e) {
    const m = e.meta as MetaOf<'thread.writer_acquired'>;
    db.prepare('UPDATE ledger_threads SET writer_session_id = ?, writer_since = ? WHERE thread_id = ?').run(
      m.sessionId,
      e.ts,
      m.threadId,
    );
    db.prepare(
      'INSERT INTO ledger_thread_writers (thread_id, session_id, acquired_at, acquired_seq) VALUES (?,?,?,?)',
    ).run(m.threadId, m.sessionId, e.ts, e.seq);
  },

  'thread.writer_released'(db, e) {
    const m = e.meta as MetaOf<'thread.writer_released'>;
    db.prepare(
      'UPDATE ledger_threads SET writer_session_id = NULL, writer_since = NULL WHERE thread_id = ? AND writer_session_id = ?',
    ).run(m.threadId, m.sessionId);
    db.prepare(
      'UPDATE ledger_thread_writers SET released_at = ?, reason = ? WHERE thread_id = ? AND session_id = ? AND released_at IS NULL',
    ).run(e.ts, m.reason, m.threadId, m.sessionId);
  },

  'plan.declared'(db, e, p) {
    const m = e.meta as MetaOf<'plan.declared'>;
    const b = p as PayloadOf<'plan.declared'> | null;
    db.prepare(
      `INSERT INTO ledger_manifests (session_id, project_id, thread_id, owner_id, version, declared_at, declared_seq, summary, base_weight, total_weight, base_head, base_fingerprint, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO NOTHING`,
    ).run(
      m.sessionId,
      m.projectId,
      m.threadId,
      m.ownerId ?? null,
      m.manifestVersion,
      e.ts,
      e.seq,
      b?.summary ?? null,
      m.totalWeight,
      m.totalWeight,
      m.baseHead ?? null,
      m.treeFingerprint ?? null,
      e.ts,
    );
    ensureSessionState(db, m.sessionId);
    if (b) {
      const ids: string[] = [];
      for (const ph of b.phases) {
        ensurePhase(db, m.sessionId, ph.id, m.projectId, ph.name);
        for (const t of ph.tasks) {
          insertTask(db, {
            sessionId: m.sessionId,
            taskId: t.id,
            projectId: m.projectId,
            threadId: m.threadId,
            phaseId: ph.id,
            title: t.title,
            acceptance: t.acceptance ?? null,
            size: t.size,
            ownerId: m.ownerId ?? null,
            ts: e.ts,
            seq: e.seq,
          });
          ids.push(t.id);
        }
      }
      if (m.threadId) carryOver(db, m.threadId, m.sessionId, ids);
    }
    touchProject(db, m.projectId, e.ts);
  },

  'plan.amended'(db, e, p) {
    const m = e.meta as MetaOf<'plan.amended'>;
    const b = p as PayloadOf<'plan.amended'> | null;
    db.prepare(
      'UPDATE ledger_manifests SET version = ?, total_weight = ?, updated_at = ? WHERE session_id = ?',
    ).run(m.manifestVersion, m.newTotalWeight, e.ts, m.sessionId);
    const man = db
      .prepare('SELECT thread_id, owner_id FROM ledger_manifests WHERE session_id = ?')
      .get(m.sessionId) as { thread_id: string | null; owner_id: string | null } | undefined;
    db.prepare(
      `INSERT INTO ledger_amendments (event_id, seq, session_id, project_id, by_id, at, version, added, removed, resized, prev_total_weight, new_total_weight, reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING`,
    ).run(
      e.id,
      e.seq,
      m.sessionId,
      m.projectId,
      m.ownerId ?? man?.owner_id ?? m.sessionId,
      e.ts,
      m.manifestVersion,
      m.added,
      m.removed,
      m.resized,
      m.prevTotalWeight,
      m.newTotalWeight,
      b?.reason ?? null,
    );
    if (b) {
      const ownerId = m.ownerId ?? man?.owner_id ?? null;
      const threadId = man?.thread_id ?? null;
      for (const t of b.add ?? []) {
        ensurePhase(db, m.sessionId, t.phaseId, m.projectId, t.phaseName ?? t.phaseId);
        // New work in a completed phase reopens it; the last pin stays as a rollback point.
        db.prepare('UPDATE ledger_phases SET completed_at = NULL WHERE session_id = ? AND phase_id = ?').run(
          m.sessionId,
          t.phaseId,
        );
        insertTask(db, {
          sessionId: m.sessionId,
          taskId: t.id,
          projectId: m.projectId,
          threadId,
          phaseId: t.phaseId,
          title: t.title,
          acceptance: t.acceptance ?? null,
          size: t.size,
          ownerId,
          ts: e.ts,
          seq: e.seq,
        });
      }
      if (threadId && b.add?.length)
        carryOver(
          db,
          threadId,
          m.sessionId,
          b.add.map((t) => t.id),
        );
      for (const id of b.remove ?? []) {
        db.prepare(
          "UPDATE ledger_tasks SET status = 'removed' WHERE session_id = ? AND task_id = ? AND status = 'open'",
        ).run(m.sessionId, id);
      }
      for (const r of b.resize ?? []) {
        db.prepare(
          "UPDATE ledger_tasks SET size = ?, weight = ? WHERE session_id = ? AND task_id = ? AND status = 'open'",
        ).run(r.size, weightOfSize(r.size), m.sessionId, r.taskId);
      }
    }
    touchProject(db, m.projectId, e.ts);
  },

  'task.done'(db, e, p) {
    const m = e.meta as MetaOf<'task.done'>;
    const b = p as PayloadOf<'task.done'> | null;
    const ref = b?.evidence.ref ?? null;
    const r = db
      .prepare(
        `UPDATE ledger_tasks SET status = 'done', done_at = ?, done_seq = ?, evidence_kind = ?, evidence_ref = ?, evidence_verified = ?, flag = ?
         WHERE session_id = ? AND task_id = ?`,
      )
      .run(e.ts, e.seq, m.evidenceKind, ref, m.evidenceVerified ? 1 : 0, m.flag, m.sessionId, m.taskId);
    if (Number(r.changes) === 0) {
      // Manifest body erased: rebuild a degraded row from meta.
      const man = db
        .prepare('SELECT thread_id, owner_id FROM ledger_manifests WHERE session_id = ?')
        .get(m.sessionId) as { thread_id: string | null; owner_id: string | null } | undefined;
      ensurePhase(db, m.sessionId, m.phaseId, m.projectId, null);
      insertTask(db, {
        sessionId: m.sessionId,
        taskId: m.taskId,
        projectId: m.projectId,
        threadId: man?.thread_id ?? null,
        phaseId: m.phaseId,
        title: null,
        acceptance: null,
        size: sizeOfWeight(m.weight),
        ownerId: man?.owner_id ?? null,
        ts: e.ts,
        seq: e.seq,
      });
      db.prepare(
        `UPDATE ledger_tasks SET status = 'done', done_at = ?, done_seq = ?, evidence_kind = ?, evidence_ref = ?, evidence_verified = ?, flag = ?
         WHERE session_id = ? AND task_id = ?`,
      ).run(e.ts, e.seq, m.evidenceKind, ref, m.evidenceVerified ? 1 : 0, m.flag, m.sessionId, m.taskId);
    }
    ensureSessionState(db, m.sessionId);
    db.prepare(
      `UPDATE ledger_session_state SET file_changes_since_close = 0, last_close_at = ?,
         last_close_fingerprint = COALESCE(?, last_close_fingerprint), last_close_head = COALESCE(?, last_close_head)
       WHERE session_id = ?`,
    ).run(e.ts, m.treeFingerprint ?? null, m.headSha ?? null, m.sessionId);
    touchProject(db, m.projectId, e.ts);
  },

  'phase.completed'(db, e) {
    const m = e.meta as MetaOf<'phase.completed'>;
    ensurePhase(db, m.sessionId, m.phaseId, m.projectId, null);
    db.prepare(
      'UPDATE ledger_phases SET completed_at = ?, pinned_sha = ?, pinned_tag = ?, pinned_at = ? WHERE session_id = ? AND phase_id = ?',
    ).run(e.ts, m.pinnedSha, m.pinnedTag, e.ts, m.sessionId, m.phaseId);
    touchProject(db, m.projectId, e.ts);
  },

  'drift.detected'(db, e, p) {
    const m = e.meta as MetaOf<'drift.detected'>;
    const b = p as PayloadOf<'drift.detected'> | null;
    db.prepare(
      `INSERT INTO ledger_drift (event_id, seq, session_id, project_id, kind, severity, task_id, at, detail) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(event_id) DO NOTHING`,
    ).run(
      e.id,
      e.seq,
      m.sessionId,
      m.projectId,
      m.kind,
      m.severity,
      m.taskId ?? null,
      e.ts,
      b?.detail ?? null,
    );
    touchProject(db, m.projectId, e.ts);
  },

  'enhancement.recorded'(db, e, p) {
    const m = e.meta as MetaOf<'enhancement.recorded'>;
    const b = p as PayloadOf<'enhancement.recorded'> | null;
    db.prepare(
      `INSERT INTO ledger_enhancements (event_id, seq, project_id, session_id, change_id, by_id, at, title, detail) VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(event_id) DO NOTHING`,
    ).run(
      e.id,
      e.seq,
      m.projectId,
      m.sessionId,
      m.changeId,
      e.actor.id,
      e.ts,
      b?.title ?? null,
      b?.detail ?? null,
    );
    touchProject(db, m.projectId, e.ts);
  },

  'playbook.step_reported'(db, e, p) {
    const m = e.meta as MetaOf<'playbook.step_reported'>;
    const b = p as PayloadOf<'playbook.step_reported'> | null;
    const key = playbookStepKey(m.stepId, b?.step);
    if (!key) return;
    db.prepare(
      `INSERT INTO ledger_playbook_steps (session_id, step_key, playbook_id, step_id, step_index, step_text, state, updated_at, updated_seq)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id, step_key) DO UPDATE SET playbook_id = excluded.playbook_id, step_index = excluded.step_index,
         step_text = COALESCE(excluded.step_text, step_text), state = excluded.state, updated_at = excluded.updated_at, updated_seq = excluded.updated_seq`,
    ).run(
      m.sessionId,
      key,
      m.playbookId,
      m.stepId ?? null,
      m.stepIndex ?? null,
      b?.step ?? null,
      m.state,
      e.ts,
      e.seq,
    );
  },

  'tool.used'(db, e, p) {
    const m = e.meta as MetaOf<'tool.used'>;
    const changed = m.fileChanging && m.ok ? 1 : 0;
    ensureSessionState(db, m.sessionId);
    db.prepare(
      `UPDATE ledger_session_state SET tool_calls = tool_calls + 1, file_changes_since_close = file_changes_since_close + ?,
         file_changes_total = file_changes_total + ?, first_activity_at = COALESCE(first_activity_at, ?), last_activity_at = ?
       WHERE session_id = ?`,
    ).run(changed, changed, e.ts, e.ts, m.sessionId);
    const paths = (p as PayloadOf<'tool.used'> | null)?.filePaths;
    if (changed && paths?.length) {
      const stmt = db.prepare(
        `INSERT INTO ledger_files (session_id, path, edits, last_at) VALUES (?,?,1,?)
         ON CONFLICT(session_id, path) DO UPDATE SET edits = edits + 1, last_at = excluded.last_at`,
      );
      for (const path of new Set(paths)) if (path) stmt.run(m.sessionId, path.slice(0, 1000), e.ts);
    }
  },
};

const LEDGER_HANDLED_EVENTS = Object.keys(handlers);

export function createLedgerProjector(): Projector {
  return {
    name: 'ledger',
    tables: [...LEDGER_TABLES],
    ddl: DDL,
    handles: LEDGER_HANDLED_EVENTS,
    apply({ db }, e, payload) {
      handlers[e.type]?.(db, e, payload);
    },
    /** Crypto-shred: drop free text from the erased body scope (a session, or a project for project/thread bodies). */
    onErase(db, scopeId) {
      db.prepare(
        'UPDATE ledger_projects SET name = NULL, description = NULL, repo_path = NULL, default_branch = NULL WHERE project_id = ?',
      ).run(scopeId);
      db.prepare('UPDATE ledger_threads SET title = NULL WHERE project_id = ?').run(scopeId);
      db.prepare('UPDATE ledger_manifests SET summary = NULL WHERE session_id = ?').run(scopeId);
      db.prepare('UPDATE ledger_phases SET name = NULL WHERE session_id = ?').run(scopeId);
      db.prepare(
        'UPDATE ledger_tasks SET title = NULL, acceptance = NULL, evidence_ref = NULL WHERE session_id = ?',
      ).run(scopeId);
      db.prepare('DELETE FROM ledger_files WHERE session_id = ?').run(scopeId);
      db.prepare("DELETE FROM ledger_playbook_steps WHERE session_id = ? AND step_key LIKE 'h:%'").run(
        scopeId,
      );
      db.prepare('UPDATE ledger_playbook_steps SET step_text = NULL WHERE session_id = ?').run(scopeId);
      db.prepare('UPDATE ledger_drift SET detail = NULL WHERE session_id = ?').run(scopeId);
      db.prepare('UPDATE ledger_amendments SET reason = NULL WHERE session_id = ?').run(scopeId);
      db.prepare(
        'UPDATE ledger_enhancements SET title = NULL, detail = NULL WHERE session_id = ? OR (session_id IS NULL AND project_id = ?)',
      ).run(scopeId, scopeId);
    },
  };
}
