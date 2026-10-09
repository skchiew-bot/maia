/**
 * Runs and playbooks read models. Both are pure functions of the log (no registry-file or service
 * lookups), so a rebuild — full or partial — yields the same tables.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { MetaOf, PayloadOf, PlaybookDTO, PlaybookInfo, PlaybookStatus } from '@aoc/contracts';
import type { Projector } from '@aoc/kernel';

// ── runs ───────────────────────────────────────────────────────────────────
export interface RunRow {
  session_id: string;
  root_session_id: string;
  process_type: string;
  model: string;
  project_id: string | null;
  launched_at: string;
  launch_seq: number;
  ended_at: string | null;
  outcome: string | null;
}
export interface UsageRow {
  session_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_5m_tokens: number;
  cache_write_1h_tokens: number;
}

/** One managed run: a launch plus its context-rollover successors (§5) — they count once in economics. */
export interface RunChain {
  rootSessionId: string;
  processType: string;
  projectId: string | null;
  model: string;
  launchedAt: string;
  launchSeq: number;
  sessions: RunRow[];
  /** The last session ended for good (any outcome except a rollover retirement). */
  finished: boolean;
  outcome: string | null;
}

export function createRunsProjector(): Projector {
  return {
    name: 'registry.runs',
    tables: ['reg_runs', 'reg_run_usage'],
    ddl: [
      `CREATE TABLE IF NOT EXISTS reg_runs (
        session_id TEXT PRIMARY KEY,
        root_session_id TEXT NOT NULL,
        process_type TEXT NOT NULL,
        model TEXT NOT NULL,
        project_id TEXT,
        launched_at TEXT NOT NULL,
        launch_seq INTEGER NOT NULL,
        ended_at TEXT,
        outcome TEXT
      )`,
      'CREATE INDEX IF NOT EXISTS reg_runs_type ON reg_runs(process_type, launch_seq)',
      'CREATE INDEX IF NOT EXISTS reg_runs_root ON reg_runs(root_session_id)',
      `CREATE TABLE IF NOT EXISTS reg_run_usage (
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens REAL NOT NULL DEFAULT 0,
        output_tokens REAL NOT NULL DEFAULT 0,
        cache_read_tokens REAL NOT NULL DEFAULT 0,
        cache_write_5m_tokens REAL NOT NULL DEFAULT 0,
        cache_write_1h_tokens REAL NOT NULL DEFAULT 0,
        PRIMARY KEY (session_id, model)
      )`,
    ],
    handles: ['session.launch_requested', 'session.ended', 'session.rollover_completed', 'usage.recorded'],
    apply({ db }, e) {
      switch (e.type) {
        case 'session.launch_requested': {
          const m = e.meta as MetaOf<'session.launch_requested'>;
          db.prepare(
            `INSERT INTO reg_runs (session_id, root_session_id, process_type, model, project_id, launched_at, launch_seq)
             VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id) DO NOTHING`,
          ).run(m.sessionId, m.sessionId, m.processType, m.model, m.projectId, e.ts, e.seq);
          return;
        }
        case 'session.ended': {
          const m = e.meta as MetaOf<'session.ended'>;
          db.prepare('UPDATE reg_runs SET ended_at = ?, outcome = ? WHERE session_id = ?').run(
            e.ts,
            m.outcome,
            m.sessionId,
          );
          return;
        }
        case 'session.rollover_completed': {
          const m = e.meta as MetaOf<'session.rollover_completed'>;
          const from = db
            .prepare('SELECT root_session_id, process_type FROM reg_runs WHERE session_id = ?')
            .get(m.fromSessionId) as { root_session_id: string; process_type: string } | undefined;
          if (!from) return;
          db.prepare(
            'UPDATE reg_runs SET root_session_id = ? WHERE (session_id = ? OR root_session_id = ?) AND process_type = ?',
          ).run(from.root_session_id, m.toSessionId, m.toSessionId, from.process_type);
          return;
        }
        case 'usage.recorded': {
          const m = e.meta as MetaOf<'usage.recorded'>;
          db.prepare(
            `INSERT INTO reg_run_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_5m_tokens, cache_write_1h_tokens)
             VALUES (?,?,?,?,?,?,?)
             ON CONFLICT(session_id, model) DO UPDATE SET
               input_tokens = input_tokens + excluded.input_tokens,
               output_tokens = output_tokens + excluded.output_tokens,
               cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
               cache_write_5m_tokens = cache_write_5m_tokens + excluded.cache_write_5m_tokens,
               cache_write_1h_tokens = cache_write_1h_tokens + excluded.cache_write_1h_tokens`,
          ).run(
            m.sessionId,
            m.model,
            m.inputTokens,
            m.outputTokens,
            m.cacheReadTokens,
            m.cacheWrite5mTokens,
            m.cacheWrite1hTokens,
          );
          return;
        }
      }
    },
  };
}

function toChain(rows: RunRow[]): RunChain {
  const sorted = [...rows].sort((a, b) => a.launch_seq - b.launch_seq);
  const root = sorted.find((r) => r.session_id === r.root_session_id) ?? sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  return {
    rootSessionId: root.root_session_id,
    processType: root.process_type,
    projectId: root.project_id,
    model: root.model,
    launchedAt: root.launched_at,
    launchSeq: root.launch_seq,
    sessions: sorted,
    finished: last.outcome !== null && last.outcome !== 'retired',
    outcome: last.outcome,
  };
}

export function listRunChains(db: DatabaseSync): RunChain[] {
  const rows = db.prepare('SELECT * FROM reg_runs ORDER BY launch_seq').all() as unknown as RunRow[];
  const byRoot = new Map<string, RunRow[]>();
  for (const r of rows) {
    const chain = byRoot.get(r.root_session_id);
    if (chain) chain.push(r);
    else byRoot.set(r.root_session_id, [r]);
  }
  return [...byRoot.values()].map(toChain).sort((a, b) => a.launchSeq - b.launchSeq);
}

export function runChainOf(db: DatabaseSync, sessionId: string): RunChain | null {
  const row = db.prepare('SELECT root_session_id FROM reg_runs WHERE session_id = ?').get(sessionId) as
    { root_session_id: string } | undefined;
  if (!row) return null;
  const rows = db
    .prepare('SELECT * FROM reg_runs WHERE root_session_id = ?')
    .all(row.root_session_id) as unknown as RunRow[];
  return toChain(rows);
}

export function usageOf(db: DatabaseSync, sessionId: string): UsageRow[] {
  return db
    .prepare('SELECT * FROM reg_run_usage WHERE session_id = ?')
    .all(sessionId) as unknown as UsageRow[];
}

// ── playbooks ──────────────────────────────────────────────────────────────
export interface PlaybookRow {
  playbook_id: string;
  process_type: string;
  version: number;
  title: string | null;
  steps_json: string | null;
  rationale: string | null;
  step_count: number;
  method: 'llm' | 'fallback';
  status: PlaybookStatus;
  source_session_id: string | null;
  project_id: string | null;
  decision_id: string;
  proposed_by: string;
  proposed_at: string;
  proposed_seq: number;
  approved_at: string | null;
  approved_by: string | null;
  approved_seq: number | null;
  rejected_at: string | null;
  rejected_by: string | null;
  retired_at: string | null;
  retired_seq: number | null;
  retire_reason: string | null;
  body_scope: string | null;
  erased: number;
}

export function createPlaybooksProjector(): Projector {
  return {
    name: 'registry.playbooks',
    tables: ['reg_playbooks'],
    ddl: [
      `CREATE TABLE IF NOT EXISTS reg_playbooks (
        playbook_id TEXT PRIMARY KEY,
        process_type TEXT NOT NULL,
        version INTEGER NOT NULL,
        title TEXT,
        steps_json TEXT,
        rationale TEXT,
        step_count INTEGER NOT NULL,
        method TEXT NOT NULL,
        status TEXT NOT NULL,
        source_session_id TEXT,
        project_id TEXT,
        decision_id TEXT NOT NULL,
        proposed_by TEXT NOT NULL,
        proposed_at TEXT NOT NULL,
        proposed_seq INTEGER NOT NULL,
        approved_at TEXT, approved_by TEXT, approved_seq INTEGER,
        rejected_at TEXT, rejected_by TEXT,
        retired_at TEXT, retired_seq INTEGER, retire_reason TEXT,
        body_scope TEXT,
        erased INTEGER NOT NULL DEFAULT 0
      )`,
      'CREATE INDEX IF NOT EXISTS reg_playbooks_type ON reg_playbooks(process_type, status)',
      'CREATE INDEX IF NOT EXISTS reg_playbooks_decision ON reg_playbooks(decision_id)',
    ],
    handles: ['playbook.proposed', 'playbook.approved', 'playbook.rejected', 'playbook.retired'],
    apply({ db }, e, payload) {
      switch (e.type) {
        case 'playbook.proposed': {
          const m = e.meta as MetaOf<'playbook.proposed'>;
          const p = payload as PayloadOf<'playbook.proposed'> | null;
          db.prepare(
            `INSERT INTO reg_playbooks (playbook_id, process_type, version, title, steps_json, rationale, step_count, method, status,
               source_session_id, project_id, decision_id, proposed_by, proposed_at, proposed_seq, body_scope, erased)
             VALUES (?,?,?,?,?,?,?,?,'proposed',?,?,?,?,?,?,?,?) ON CONFLICT(playbook_id) DO NOTHING`,
          ).run(
            m.playbookId,
            m.processType,
            m.version,
            p?.title ?? null,
            p ? JSON.stringify(p.steps) : null,
            p?.rationale ?? null,
            m.stepCount,
            m.method,
            m.sourceSessionId,
            e.scope.projectId ?? null,
            m.decisionId,
            e.actor.id,
            e.ts,
            e.seq,
            e.bodyScope,
            p ? 0 : 1,
          );
          return;
        }
        case 'playbook.approved': {
          const m = e.meta as MetaOf<'playbook.approved'>;
          db.prepare(
            "UPDATE reg_playbooks SET status = 'approved', approved_at = ?, approved_by = ?, approved_seq = ? WHERE playbook_id = ? AND status = 'proposed'",
          ).run(e.ts, m.approverId, e.seq, m.playbookId);
          return;
        }
        case 'playbook.rejected': {
          const m = e.meta as MetaOf<'playbook.rejected'>;
          db.prepare(
            "UPDATE reg_playbooks SET status = 'rejected', rejected_at = ?, rejected_by = ? WHERE playbook_id = ? AND status = 'proposed'",
          ).run(e.ts, m.approverId, m.playbookId);
          return;
        }
        case 'playbook.retired': {
          const m = e.meta as MetaOf<'playbook.retired'>;
          db.prepare(
            "UPDATE reg_playbooks SET status = 'retired', retired_at = ?, retired_seq = ?, retire_reason = ? WHERE playbook_id = ? AND status IN ('proposed', 'approved')",
          ).run(e.ts, e.seq, m.reason, m.playbookId);
          return;
        }
      }
    },
    onErase(db, scopeId) {
      db.prepare(
        'UPDATE reg_playbooks SET title = NULL, steps_json = NULL, rationale = NULL, erased = 1 WHERE body_scope = ?',
      ).run(scopeId);
    },
  };
}

export function getPlaybookRow(db: DatabaseSync, playbookId: string): PlaybookRow | null {
  return (
    (db.prepare('SELECT * FROM reg_playbooks WHERE playbook_id = ?').get(playbookId) as unknown as
      PlaybookRow | undefined) ?? null
  );
}

export function playbookByDecision(db: DatabaseSync, decisionId: string): PlaybookRow | null {
  return (
    (db.prepare('SELECT * FROM reg_playbooks WHERE decision_id = ?').get(decisionId) as unknown as
      PlaybookRow | undefined) ?? null
  );
}

export function listPlaybookRows(
  db: DatabaseSync,
  f: { processType?: string; status?: PlaybookStatus } = {},
): PlaybookRow[] {
  const where: string[] = [];
  const args: string[] = [];
  if (f.processType) (where.push('process_type = ?'), args.push(f.processType));
  if (f.status) (where.push('status = ?'), args.push(f.status));
  return db
    .prepare(
      `SELECT * FROM reg_playbooks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY proposed_seq DESC`,
    )
    .all(...args) as unknown as PlaybookRow[];
}

/** Latest approved, not retired, not erased playbook of the type — an erased playbook cannot be followed. */
export function activePlaybookRow(db: DatabaseSync, processType: string): PlaybookRow | null {
  return (
    (db
      .prepare(
        "SELECT * FROM reg_playbooks WHERE process_type = ? AND status = 'approved' AND erased = 0 ORDER BY approved_seq DESC LIMIT 1",
      )
      .get(processType) as unknown as PlaybookRow | undefined) ?? null
  );
}

export function pendingPlaybookRow(db: DatabaseSync, processType: string): PlaybookRow | null {
  return (
    (db
      .prepare(
        "SELECT * FROM reg_playbooks WHERE process_type = ? AND status = 'proposed' ORDER BY proposed_seq DESC LIMIT 1",
      )
      .get(processType) as unknown as PlaybookRow | undefined) ?? null
  );
}

export function nextPlaybookVersion(db: DatabaseSync, processType: string): number {
  const r = db
    .prepare('SELECT MAX(version) AS v FROM reg_playbooks WHERE process_type = ?')
    .get(processType) as { v: number | null };
  return (r.v ?? 0) + 1;
}

export function playbookCount(db: DatabaseSync, processType: string): number {
  return (
    db.prepare('SELECT COUNT(*) AS n FROM reg_playbooks WHERE process_type = ?').get(processType) as {
      n: number;
    }
  ).n;
}

/** [approved_seq, retired_seq) per approved-at-some-point playbook: was an approved playbook active at a launch seq? */
export interface ApprovalInterval {
  processType: string;
  approvedSeq: number;
  retiredSeq: number | null;
}
export function approvalIntervals(db: DatabaseSync): ApprovalInterval[] {
  return (
    db
      .prepare(
        'SELECT process_type, approved_seq, retired_seq FROM reg_playbooks WHERE approved_seq IS NOT NULL',
      )
      .all() as unknown as {
      process_type: string;
      approved_seq: number;
      retired_seq: number | null;
    }[]
  ).map((r) => ({ processType: r.process_type, approvedSeq: r.approved_seq, retiredSeq: r.retired_seq }));
}

function stepsOf(row: PlaybookRow): PlaybookInfo['steps'] {
  if (!row.steps_json) return [];
  try {
    return JSON.parse(row.steps_json) as PlaybookInfo['steps'];
  } catch {
    return [];
  }
}

export function toPlaybookInfo(row: PlaybookRow): PlaybookInfo {
  return {
    playbookId: row.playbook_id,
    processType: row.process_type,
    version: row.version,
    title: row.title ?? '[erased]',
    steps: stepsOf(row),
    status: row.status,
  };
}

export function toPlaybookDTO(row: PlaybookRow, activeId: string | null): PlaybookDTO {
  return {
    playbookId: row.playbook_id,
    processType: row.process_type,
    version: row.version,
    title: row.title ?? '[erased]',
    steps: stepsOf(row),
    rationale: row.rationale,
    status: row.status,
    active: row.playbook_id === activeId,
    method: row.method,
    sourceSessionId: row.source_session_id,
    projectId: row.project_id,
    decisionId: row.decision_id,
    proposedBy: row.proposed_by,
    proposedAt: row.proposed_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
    rejectedAt: row.rejected_at,
    rejectedBy: row.rejected_by,
    retiredAt: row.retired_at,
    retireReason: row.retire_reason,
    erased: row.erased === 1,
  };
}
