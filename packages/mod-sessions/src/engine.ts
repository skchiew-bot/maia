import {
  DEFAULT_LIVENESS_THRESHOLDS,
  deriveLiveness,
  type LivenessService,
  type LivenessState,
  type LivenessThresholds,
  type SessionDirectory,
  type SessionInfo,
  type SessionLifecycle,
  type SessionMode,
} from '@aoc/contracts';
import type { ModuleContext } from '@aoc/kernel';

export interface SessionRow {
  session_id: string;
  mode: SessionMode;
  claude_session_id: string | null;
  owner_id: string | null;
  project_id: string | null;
  thread_id: string | null;
  phase_id: string | null;
  ticket_id: string | null;
  parent_session_id: string | null;
  process_type: string | null;
  model: string | null;
  read_only: number;
  credential_profile: string | null;
  lifecycle: SessionLifecycle;
  liveness: LivenessState | null;
  liveness_reason: string | null;
  liveness_since: string | null;
  cwd: string | null;
  transcript_path: string | null;
  pid: number | null;
  turns: number;
  title: string | null;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  last_tool_at: string | null;
  last_activity_at: string | null;
  context_tokens: number | null;
  throttled_until: string | null;
  throttle_started_at: string | null;
  predecessor_id: string | null;
  successor_id: string | null;
}

/** Ephemeral live signals — never chained (heartbeats would be ~17k rows per session per day, §13). */
export interface LiveSignals {
  processAlive: boolean | null;
  pid: number | null;
  lastHeartbeatAt: number | null;
  lastToolAt: number | null;
  toolInFlightSince: number | null;
  lastStreamAt: number | null;
}

const parse = (iso: string | null | undefined): number | null => (iso ? Date.parse(iso) : null);

export class SessionsEngine implements SessionDirectory {
  private readonly signals = new Map<string, LiveSignals>();

  constructor(private readonly ctx: ModuleContext) {}

  // ── directory ──────────────────────────────────────────────────────────────
  row(sessionId: string): SessionRow | null {
    return (this.ctx.db.prepare('SELECT * FROM sess_sessions WHERE session_id = ?').get(sessionId) as SessionRow | undefined) ?? null;
  }

  rows(filter: { projectId?: string; lifecycle?: SessionLifecycle[]; mode?: SessionMode } = {}): SessionRow[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.projectId) (where.push('project_id = ?'), args.push(filter.projectId));
    if (filter.mode) (where.push('mode = ?'), args.push(filter.mode));
    if (filter.lifecycle?.length) (where.push(`lifecycle IN (${filter.lifecycle.map(() => '?').join(',')})`), args.push(...filter.lifecycle));
    return this.ctx.db
      .prepare(`SELECT * FROM sess_sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY started_at DESC`)
      .all(...args) as unknown as SessionRow[];
  }

  toInfo(r: SessionRow): SessionInfo {
    return {
      sessionId: r.session_id,
      mode: r.mode,
      claudeSessionId: r.claude_session_id,
      ownerId: r.owner_id,
      projectId: r.project_id,
      threadId: r.thread_id,
      processType: r.process_type,
      model: r.model,
      readOnly: r.read_only === 1,
      lifecycle: r.lifecycle,
      liveness: r.liveness,
      cwd: r.cwd,
      ticketId: r.ticket_id,
      startedAt: r.started_at,
    };
  }

  get(sessionId: string): SessionInfo | null {
    const r = this.row(sessionId);
    return r ? this.toInfo(r) : null;
  }

  byClaudeSessionId(claudeSessionId: string): SessionInfo | null {
    const r = this.ctx.db
      .prepare('SELECT * FROM sess_sessions WHERE claude_session_id = ? ORDER BY started_at DESC LIMIT 1')
      .get(claudeSessionId) as SessionRow | undefined;
    return r ? this.toInfo(r) : null;
  }

  list(filter: { projectId?: string; lifecycle?: SessionLifecycle[]; mode?: SessionMode } = {}): SessionInfo[] {
    return this.rows(filter).map((r) => this.toInfo(r));
  }

  contextTokens(sessionId: string): number {
    return this.row(sessionId)?.context_tokens ?? 0;
  }

  openDecisionCount(sessionId: string): number {
    return (this.ctx.db.prepare("SELECT COUNT(*) AS n FROM sess_decisions WHERE session_id = ? AND status = 'open'").get(sessionId) as { n: number }).n;
  }

  // ── live signals ───────────────────────────────────────────────────────────
  private sig(sessionId: string): LiveSignals {
    let s = this.signals.get(sessionId);
    if (!s) {
      s = { processAlive: null, pid: null, lastHeartbeatAt: null, lastToolAt: null, toolInFlightSince: null, lastStreamAt: null };
      this.signals.set(sessionId, s);
    }
    return s;
  }

  signalsOf(sessionId: string): LiveSignals {
    return { ...this.sig(sessionId) };
  }

  /**
   * The supervisor starts a sidecar per turn, and one can outlive its process by a few seconds: a report about a
   * pid that is not the session's current process (latest session.launched) says nothing about the session.
   */
  private stale(sessionId: string, pid: number | null): boolean {
    if (pid === null) return false;
    const current = this.row(sessionId)?.pid ?? null;
    return current !== null && current !== pid;
  }

  heartbeat(sessionId: string, atMs: number, alive: boolean, pid: number | null): void {
    if (this.stale(sessionId, pid)) return;
    const s = this.sig(sessionId);
    s.lastHeartbeatAt = atMs;
    s.processAlive = alive;
    if (pid !== null) s.pid = pid;
    this.refresh(sessionId);
  }

  toolStarted(sessionId: string, atMs: number): void {
    const s = this.sig(sessionId);
    s.toolInFlightSince = atMs;
    s.lastToolAt = atMs;
    this.touchObserved(sessionId, atMs);
    this.refresh(sessionId);
  }

  toolFinished(sessionId: string, atMs: number): void {
    const s = this.sig(sessionId);
    s.toolInFlightSince = null;
    s.lastToolAt = atMs;
    this.touchObserved(sessionId, atMs);
    this.refresh(sessionId);
  }

  recordActivity(sessionId: string, kind: 'stream' | 'transcript' | 'tool', atMs: number): void {
    const s = this.sig(sessionId);
    if (kind === 'tool') s.lastToolAt = atMs;
    else s.lastStreamAt = atMs;
    this.touchObserved(sessionId, atMs);
    this.refresh(sessionId);
  }

  recordProcess(sessionId: string, alive: boolean, pid: number | null): void {
    const s = this.sig(sessionId);
    s.processAlive = alive;
    if (pid !== null) s.pid = pid;
    if (alive) s.lastHeartbeatAt = this.ctx.clock.now();
    else s.toolInFlightSince = null;
    this.refresh(sessionId);
  }

  /** A sidecar saw its watched process exit (`pid` null: the report did not say which process). */
  processExited(sessionId: string, pid: number | null): void {
    if (this.stale(sessionId, pid)) return;
    this.recordProcess(sessionId, false, null);
  }

  /** Observed sessions have no sidecar: any hook event is proof of activity (but never of process liveness). */
  private touchObserved(sessionId: string, atMs: number): void {
    const r = this.row(sessionId);
    if (r?.mode === 'observed') this.sig(sessionId).lastStreamAt = Math.max(this.sig(sessionId).lastStreamAt ?? 0, atMs);
  }

  // ── liveness ───────────────────────────────────────────────────────────────
  thresholdsFor(r: SessionRow): LivenessThresholds {
    const base: LivenessThresholds = { ...DEFAULT_LIVENESS_THRESHOLDS, ...this.ctx.config.liveness };
    const type = r.process_type ? this.ctx.services.maybe('registry')?.getType(r.process_type) : null;
    if (type?.stallAfterMs) base.stallAfterMs = type.stallAfterMs;
    // Observed sessions cannot prove process liveness (no sidecar): never declare them Dead by silence.
    if (r.mode === 'observed') base.deadAfterMs = Number.POSITIVE_INFINITY;
    return base;
  }

  verdict(r: SessionRow): { state: LivenessState | null; reason: string } {
    const s = this.sig(r.session_id);
    return deriveLiveness(
      {
        lifecycle: r.lifecycle,
        processAlive: r.mode === 'observed' ? null : s.processAlive,
        startedAt: Date.parse(r.started_at),
        lastHeartbeatAt: r.mode === 'observed' ? null : s.lastHeartbeatAt,
        lastToolActivityAt: Math.max(s.lastToolAt ?? 0, parse(r.last_tool_at) ?? 0) || null,
        toolInFlightSince: s.toolInFlightSince,
        lastStreamActivityAt: Math.max(s.lastStreamAt ?? 0, parse(r.last_activity_at) ?? 0) || null,
        openDecisions: this.openDecisionCount(r.session_id),
        throttledUntil: parse(r.throttled_until),
      },
      this.ctx.clock.now(),
      this.thresholdsFor(r),
    );
  }

  /** LivenessService.get */
  liveness(sessionId: string): { state: LivenessState | null; reason: string; since: string } | null {
    const r = this.row(sessionId);
    if (!r) return null;
    return { state: r.liveness, reason: r.liveness_reason ?? 'unknown', since: r.liveness_since ?? r.started_at };
  }

  /** Recompute and chain the change (only state CHANGES are audited). */
  refresh(sessionId: string): void {
    const r = this.row(sessionId);
    if (!r) return;
    const v = this.verdict(r);
    if (v.state === r.liveness) return;
    this.ctx.store.append({
      type: 'session.liveness_changed',
      actor: { kind: 'system', id: 'liveness' },
      scope: { sessionId, projectId: r.project_id ?? undefined },
      meta: { sessionId, from: r.liveness, to: v.state, reason: v.reason },
      source: 'system',
    });
  }

  refreshAll(): void {
    for (const r of this.ctx.db
      .prepare("SELECT session_id FROM sess_sessions WHERE lifecycle NOT IN ('ended','retired') OR liveness IS NOT NULL")
      .all() as { session_id: string }[]) {
      this.refresh(r.session_id);
    }
  }

  forget(sessionId: string): void {
    this.signals.delete(sessionId);
  }
}

/** Adapter exposing the contract's LivenessService.get name without clashing with SessionDirectory.get. */
export function livenessServiceOf(engine: SessionsEngine): LivenessService {
  return {
    get: (id) => engine.liveness(id),
    refresh: (id) => engine.refresh(id),
    recordActivity: (id, kind, at) => engine.recordActivity(id, kind, at),
    recordProcess: (id, alive, pid) => engine.recordProcess(id, alive, pid),
  };
}
