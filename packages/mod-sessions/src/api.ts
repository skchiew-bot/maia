import {
  hasPermission,
  MODEL_CONTEXT_TOKENS,
  modelTierOf,
  type ApmSeries,
  type AuthContext,
  type ConsoleSnapshot,
  type CurrentPhaseDTO,
  type Progress,
  type ProgressDTO,
  type SessionActivityDTO,
  type SessionDetail,
  type SessionLifecycle,
  type SessionSummary,
  type SessionTokenRow,
} from '@aoc/contracts';
import { EventStore, HttpError, localDate, parseQuery, requirePermission, type App, type ModuleContext } from '@aoc/kernel';
import { z } from 'zod';
import type { SessionRow, SessionsEngine } from './engine';
import { minuteOf } from './projector';

export const APM_WINDOW_MINUTES = 30;
/** Most ended sessions the console snapshot lists for today. */
export const ENDED_TODAY_LIMIT = 50;
const ACTIVE: SessionLifecycle[] = ['launching', 'running', 'idle', 'waiting_decision', 'blocked', 'throttled'];

interface UsageRow {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_w5: number;
  cache_w1: number;
}

export class SessionReadModels {
  constructor(
    private readonly ctx: ModuleContext,
    private readonly engine: SessionsEngine,
  ) {}

  private today(): string {
    return localDate(this.ctx.clock.now(), this.ctx.config.timezone);
  }

  apm(sessionId: string): ApmSeries {
    const now = this.ctx.clock.now();
    const minutes: string[] = [];
    for (let i = APM_WINDOW_MINUTES - 1; i >= 0; i--) minutes.push(minuteOf(new Date(now - i * 60_000).toISOString()));
    const rows = this.ctx.db
      .prepare('SELECT minute, count FROM sess_activity WHERE session_id = ? AND minute >= ?')
      .all(sessionId, minutes[0]!) as { minute: string; count: number }[];
    const byMinute = new Map(rows.map((r) => [r.minute, r.count]));
    const points = minutes.map((m) => byMinute.get(m) ?? 0);
    return { windowMinutes: APM_WINDOW_MINUTES, points, current: points[points.length - 1] ?? 0 };
  }

  private cost(rows: UsageRow[], date: string): number {
    const metering = this.ctx.services.maybe('metering');
    if (!metering) return 0;
    let usd = 0;
    for (const r of rows) {
      usd += metering.notionalCostUsd(
        r.model,
        { inputTokens: r.input, outputTokens: r.output, cacheReadTokens: r.cache_read, cacheWrite5mTokens: r.cache_w5, cacheWrite1hTokens: r.cache_w1 },
        date,
      );
    }
    return Math.round(usd * 10_000) / 10_000;
  }

  costToday(sessionId: string): number {
    const date = this.today();
    const rows = this.ctx.db.prepare('SELECT model, input, output, cache_read, cache_w5, cache_w1 FROM sess_usage_daily WHERE session_id = ? AND date = ?').all(sessionId, date) as unknown as UsageRow[];
    return this.cost(rows, date);
  }

  private progress(p: Progress | null): ProgressDTO | null {
    if (!p) return null;
    return {
      doneTasks: p.doneTasks,
      totalTasks: p.totalTasks,
      doneWeight: p.doneWeight,
      totalWeight: p.totalWeight,
      pct: p.pct,
      flaggedTasks: p.flaggedTasks,
      etaMs: p.etaMs,
      etaHiddenReason: p.etaHiddenReason,
    };
  }

  /** The first phase in plan order that still has open work. */
  private currentPhase(p: Progress | null): CurrentPhaseDTO | null {
    if (!p) return null;
    const index = p.phases.findIndex((ph) => ph.totalTasks > 0 && !ph.complete);
    const ph = p.phases[index];
    return ph ? { phaseId: ph.phaseId, name: ph.name, index: index + 1, count: p.phases.length } : null;
  }

  /** Today's FX rate (USD→MYR) as stamped by metering; null when today has none. */
  private fxToday(): number | null {
    return this.ctx.services.maybe('metering')?.fxRate(this.today())?.rate ?? null;
  }

  private windowFor(model: string | null): number | null {
    if (!model) return null;
    const tier = modelTierOf(model);
    return tier === 'unknown' ? null : (MODEL_CONTEXT_TOKENS[tier] ?? null);
  }

  summary(r: SessionRow): SessionSummary {
    const project = r.project_id
      ? (this.ctx.db.prepare('SELECT name FROM sess_projects WHERE project_id = ?').get(r.project_id) as { name: string | null } | undefined)
      : undefined;
    const owner = r.owner_id ? (this.ctx.db.prepare('SELECT name FROM sess_users WHERE user_id = ?').get(r.owner_id) as { name: string | null } | undefined) : undefined;
    const dec = this.ctx.db
      .prepare("SELECT decision_id, kind, created_at FROM sess_decisions WHERE session_id = ? AND status = 'open' ORDER BY created_at LIMIT 1")
      .get(r.session_id) as { decision_id: string; kind: string; created_at: string } | undefined;
    const window = this.windowFor(r.model);
    const phaseName = r.phase_id ?? null;
    const ledgerProgress = this.ctx.services.maybe('ledger')?.sessionProgress(r.session_id) ?? null;
    const costToday = this.costToday(r.session_id);
    const fx = this.fxToday();
    return {
      sessionId: r.session_id,
      mode: r.mode,
      title: r.title ?? `${r.process_type ?? 'session'}`,
      projectId: r.project_id,
      projectName: project?.name ?? null,
      threadId: r.thread_id,
      phaseId: r.phase_id,
      phaseName,
      currentPhase: this.currentPhase(ledgerProgress),
      processType: r.process_type,
      model: r.model,
      ownerId: r.owner_id,
      ownerName: owner?.name ?? null,
      lifecycle: r.lifecycle,
      liveness: r.liveness || r.liveness_since ? { state: r.liveness, reason: r.liveness_reason ?? 'unknown', since: r.liveness_since ?? r.started_at } : null,
      apm: this.apm(r.session_id),
      progress: this.progress(ledgerProgress),
      contextTokens: r.context_tokens,
      contextPct: r.context_tokens != null && window ? Math.round((r.context_tokens / window) * 1000) / 10 : null,
      costTodayUsd: costToday,
      costTodayRm: fx === null ? null : Math.round(costToday * fx * 100) / 100,
      openDecision: dec ? { decisionId: dec.decision_id, kind: dec.kind, createdAt: dec.created_at } : null,
      throttledUntil: r.throttled_until,
      lastActivityAt: r.last_activity_at ?? r.last_tool_at,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      outcome: r.outcome,
      ticketId: r.ticket_id,
    };
  }

  /** Sessions that ended on the local calendar day `date` (configured timezone), most recent first. */
  private endedOn(date: string): SessionRow[] {
    const tz = this.ctx.config.timezone;
    // A local day never starts more than 24h before now, so this window holds every candidate.
    return (
      this.ctx.db
        .prepare("SELECT * FROM sess_sessions WHERE lifecycle IN ('ended','failed','retired') AND ended_at >= ? ORDER BY ended_at DESC LIMIT 500")
        .all(new Date(this.ctx.clock.now() - 25 * 3600_000).toISOString()) as unknown as SessionRow[]
    )
      .filter((r) => r.ended_at !== null && localDate(Date.parse(r.ended_at), tz) === date)
      .slice(0, ENDED_TODAY_LIMIT);
  }

  console(): ConsoleSnapshot {
    const date = this.today();
    const rows = this.engine.rows({ lifecycle: ACTIVE });
    const endedToday = this.endedOn(date);
    const failed = this.engine.rows({ lifecycle: ['failed'] }).filter((r) => !endedToday.some((x) => x.session_id === r.session_id));
    const sessions = [...rows, ...failed.slice(0, 6), ...endedToday].map((r) => this.summary(r));
    const waiting = rows.filter((r) => r.liveness === 'waiting_on_you');
    const throttled = rows.filter((r) => r.liveness === 'throttled');
    const tasks = this.ctx.db.prepare('SELECT done, verified FROM sess_tasks_daily WHERE date = ?').get(date) as { done: number; verified: number } | undefined;
    const idle = (this.ctx.db.prepare('SELECT idle_ms FROM sess_throttle_daily WHERE date = ?').get(date) as { idle_ms: number } | undefined)?.idle_ms ?? 0;
    const ongoingIdle = throttled.reduce((ms, r) => ms + (r.throttle_started_at ? Math.max(0, this.ctx.clock.now() - Date.parse(r.throttle_started_at)) : 0), 0);
    const usage = this.ctx.db
      .prepare('SELECT model, SUM(input) input, SUM(output) output, SUM(cache_read) cache_read, SUM(cache_w5) cache_w5, SUM(cache_w1) cache_w1 FROM sess_usage_daily WHERE date = ? GROUP BY model')
      .all(date) as unknown as UsageRow[];
    const usd = this.cost(usage, date);
    const fx = this.ctx.services.maybe('metering')?.fxRate(date) ?? null;
    return {
      generatedAt: this.ctx.clock.iso(),
      today: date,
      kpis: {
        activeSessions: rows.length,
        waitingOnYou: waiting.length,
        oldestWaitingSince: waiting.map((r) => r.liveness_since ?? r.started_at).sort()[0] ?? null,
        throttled: throttled.length,
        throttleIdleMsToday: idle + ongoingIdle,
        tasksDoneToday: tasks?.done ?? 0,
        tasksDoneWithEvidencePct: tasks && tasks.done > 0 ? Math.round((tasks.verified / tasks.done) * 1000) / 10 : 0,
        notionalUsdToday: usd,
        notionalRmToday: fx ? Math.round(usd * fx.rate * 100) / 100 : null,
      },
      sessions,
    };
  }

  /** Tool calls per minute over the whole session (sess_activity) and its plan-limit episodes. */
  activity(sessionId: string): SessionActivityDTO {
    const rows = this.ctx.db
      .prepare('SELECT minute, count FROM sess_activity WHERE session_id = ? ORDER BY minute')
      .all(sessionId) as { minute: string; count: number }[];
    const throttles: SessionActivityDTO['throttles'] = [];
    let open: SessionActivityDTO['throttles'][number] | null = null;
    for (const e of this.ctx.store.list({ sessionId, types: ['throttle.hit', 'throttle.cleared'], limit: 10_000 })) {
      if (e.type === 'throttle.hit') {
        if (open) continue;
        open = { startAt: e.ts, endAt: null, resetAt: typeof e.meta.resetAt === 'string' ? e.meta.resetAt : null, idleMs: null };
        throttles.push(open);
      } else if (open) {
        open.endAt = e.ts;
        open.idleMs = typeof e.meta.idleMs === 'number' ? e.meta.idleMs : null;
        open = null;
      }
    }
    return {
      sessionId,
      minutes: rows.map((m) => ({ at: `${m.minute}:00.000Z`, count: m.count })),
      totalToolCalls: rows.reduce((n, m) => n + m.count, 0),
      throttles,
    };
  }

  detail(r: SessionRow, viewer: AuthContext): SessionDetail {
    const base = this.summary(r);
    const tokens = (
      this.ctx.db
        .prepare('SELECT model, SUM(input) input, SUM(output) output, SUM(cache_read) cache_read, SUM(cache_w5) cache_w5, SUM(cache_w1) cache_w1 FROM sess_usage_daily WHERE session_id = ? GROUP BY model')
        .all(r.session_id) as unknown as UsageRow[]
    ).map<SessionTokenRow>((u) => ({
      model: u.model,
      inputTokens: u.input,
      outputTokens: u.output,
      cacheReadTokens: u.cache_read,
      cacheWriteTokens: u.cache_w5 + u.cache_w1,
      notionalUsd: this.cost([u], this.today()),
    }));
    return { ...base, claudeSessionId: r.claude_session_id, cwd: r.cwd, readOnly: r.read_only === 1, turns: r.turns, tokens, contextWindowTokens: this.windowFor(r.model), predecessorSessionId: r.predecessor_id, successorSessionId: r.successor_id, actions: this.actions(r, viewer) };
  }

  private actions(r: SessionRow, viewer: AuthContext): SessionDetail['actions'] {
    const u = viewer.user;
    const canDrive = hasPermission(u.role, 'session.drive_any', u.flags) || (hasPermission(u.role, 'session.drive_own', u.flags) && r.owner_id === u.id);
    const supervisor = this.ctx.services.maybe('supervisor');
    const ledger = this.ctx.services.maybe('ledger');
    const off = (reason: string) => ({ enabled: false, reason });
    const on = { enabled: true, reason: null };
    if (r.mode === 'observed') {
      const o = off('Observed sessions are read-only');
      return { nudge: o, restart: o, stop: o, rollover: o, prompt: o };
    }
    if (!canDrive) {
      const o = off('Only the session owner (or an Approver) can drive this session');
      return { nudge: o, restart: o, stop: o, rollover: o, prompt: o };
    }
    const done = r.lifecycle === 'ended' || r.lifecycle === 'retired';
    const running = supervisor?.isRunning(r.session_id) ?? r.lifecycle === 'running';
    const boundary = ledger?.boundaryState(r.session_id) ?? { atBoundary: false, reason: 'ledger unavailable', openTasks: 0 };
    return {
      nudge: done ? off('Session has ended') : running || r.lifecycle === 'idle' ? on : off('Nothing to nudge: the session is not running'),
      restart: done ? off('Session has ended') : r.lifecycle === 'failed' || r.liveness === 'dead' || r.liveness === 'stalled' || r.lifecycle === 'idle' ? on : off('Restart is for dead, stalled or idle sessions'),
      stop: done ? off('Session has ended') : on,
      rollover:
        done || r.read_only === 1
          ? off(done ? 'Session has ended' : 'Read-only sessions do not roll over')
          : this.engine.openDecisionCount(r.session_id) > 0
            ? off('Resolve open decisions first')
            : boundary.atBoundary
              ? on
              : off(`Not at a clean task boundary${boundary.reason ? `: ${boundary.reason}` : ''}`),
      prompt: r.lifecycle === 'idle' ? on : off(done ? 'Session has ended' : 'Prompts can be sent when the session is idle'),
    };
  }
}

export function registerApiRoutes(app: App, ctx: ModuleContext, engine: SessionsEngine): void {
  const rm = new SessionReadModels(ctx, engine);

  app.get('/api/console', (c) => {
    requirePermission(c, 'session.view');
    return c.json(rm.console());
  });

  app.get('/api/sessions', (c) => {
    requirePermission(c, 'session.view');
    const q = parseQuery(c, z.object({ projectId: z.string().optional(), state: z.string().optional(), mode: z.enum(['managed', 'observed']).optional() }));
    const lifecycle = q.state ? (q.state.split(',') as SessionLifecycle[]) : undefined;
    return c.json(engine.rows({ projectId: q.projectId, lifecycle, mode: q.mode }).map((r) => rm.summary(r)));
  });

  app.get('/api/sessions/:id', (c) => {
    const auth = requirePermission(c, 'session.view');
    const r = engine.row(c.req.param('id'));
    if (!r) throw new HttpError(404, 'not_found', 'Session not found');
    return c.json(rm.detail(r, auth));
  });

  app.get('/api/sessions/:id/activity', (c) => {
    requirePermission(c, 'session.view');
    const id = c.req.param('id');
    if (!engine.row(id)) throw new HttpError(404, 'not_found', 'Session not found');
    return c.json(rm.activity(id));
  });

  app.get('/api/sessions/:id/events', (c) => {
    requirePermission(c, 'session.view');
    const id = c.req.param('id');
    if (!engine.row(id)) throw new HttpError(404, 'not_found', 'Session not found');
    const q = parseQuery(c, z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }));
    return c.json(ctx.store.list({ sessionId: id, order: 'desc', limit: q.limit }).map((e) => ({ ...EventStore.headerOf(e), hash: e.hash })));
  });
}
