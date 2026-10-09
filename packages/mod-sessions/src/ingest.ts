import {
  FILE_CHANGING_TOOLS,
  INGEST_PATHS,
  newId,
  type Actor,
  type HookIngestRequest,
  type HookIngestResponse,
  type HookInput,
  type IngestPrincipal,
  type PreToolContext,
  type SessionInfo,
  type SpoolFlushResponse,
  type SpoolItem,
} from '@aoc/contracts';
import { HttpError, readJson, requireIngest, type App, type Ctx, type ModuleContext } from '@aoc/kernel';
import { z } from 'zod';
import type { SessionsEngine } from './engine';

const HookIngestSchema = z.object({
  mode: z.enum(['managed', 'observed']),
  aocSessionId: z.string().max(64).nullable(),
  hook: z.object({ session_id: z.string().min(1).max(128), hook_event_name: z.string(), cwd: z.string().default('') }).passthrough(),
  sentAt: z.string(),
  idempotencyKey: z.string().min(8).max(200),
});
const HeartbeatSchema = z.object({
  sessionId: z.string(),
  pid: z.number().int().nullable(),
  alive: z.boolean(),
  at: z.string(),
  transcriptBytes: z.number().min(0),
  lastTranscriptWriteAt: z.string().nullable(),
});
const ActivitySchema = z.object({ sessionId: z.string(), kind: z.enum(['stream', 'transcript']), at: z.string() });
const UsageSchema = z.object({
  sessionId: z.string(),
  idempotencyKey: z.string().min(8).max(200),
  batches: z
    .array(
      z.object({
        model: z.string().min(1).max(80),
        inputTokens: z.number().min(0),
        outputTokens: z.number().min(0),
        cacheReadTokens: z.number().min(0),
        cacheWrite5mTokens: z.number().min(0),
        cacheWrite1hTokens: z.number().min(0),
        messageIds: z.array(z.string()).min(1).max(5000),
        firstAt: z.string(),
        lastAt: z.string(),
        contextTokens: z.number().min(0),
      }),
    )
    .max(200),
});
const ThrottleSchema = z.object({ sessionId: z.string(), resetAt: z.string().nullable(), message: z.string().max(2000), source: z.enum(['stream', 'transcript', 'exit']) });
const ProcessSchema = z.object({ sessionId: z.string(), event: z.literal('exited'), exitCode: z.number().int().nullable(), signal: z.string().nullable(), at: z.string() });
const SpoolSchema = z.object({ items: z.array(z.object({ path: z.string(), body: z.unknown(), queuedAt: z.string() })).max(500) });

const READ_ONLY_PREFIX = /^\s*(ls|cat|head|tail|wc|grep|rg|pwd|echo|which|file|stat|du|df|tree|git\s+(log|show|diff|status|blame|branch|rev-parse))\b/;

export function summarize(v: unknown, max = 500): string {
  let s: string;
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function toolFailed(resp: unknown): boolean {
  if (!resp || typeof resp !== 'object') return false;
  const r = resp as Record<string, unknown>;
  return r.is_error === true || r.isError === true || r.success === false || typeof r.error === 'string';
}

function filePathsOf(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const k of ['file_path', 'notebook_path', 'path']) if (typeof input[k] === 'string') out.push(input[k] as string);
  return out;
}

/** Defence in depth for read-only (triage) sessions; primary enforcement is the supervisor's --tools/--disallowedTools. */
export function isReadOnlyBash(command: string): boolean {
  if (/[>|;&`$]|\b(rm|mv|cp|tee|sed\s+-i|chmod|chown|mkdir|touch|dd|truncate|git\s+(commit|push|checkout|reset|merge|rebase|apply|stash|tag))\b/.test(command)) {
    return false;
  }
  if (/\bfind\b.*\s-(delete|exec|execdir|ok)\b/.test(command)) return false;
  return READ_ONLY_PREFIX.test(command);
}

export interface IngestDeps {
  ctx: ModuleContext;
  engine: SessionsEngine;
}

export class HookDispatcher {
  constructor(private readonly d: IngestDeps) {}

  private get ctx() {
    return this.d.ctx;
  }

  private agent(sessionId: string): Actor {
    return { kind: 'agent', id: sessionId };
  }

  private setLifecycle(s: SessionInfo, to: SessionInfo['lifecycle'], reason: string, key?: string): void {
    const cur = this.d.engine.row(s.sessionId);
    if (!cur || cur.lifecycle === to) return;
    this.ctx.store.append({
      type: 'session.lifecycle_changed',
      actor: { kind: 'system', id: 'sessions' },
      scope: { sessionId: s.sessionId, projectId: s.projectId ?? undefined },
      meta: { sessionId: s.sessionId, from: cur.lifecycle, to, reason },
      source: 'hook',
      idempotencyKey: key,
    });
    this.d.engine.refresh(s.sessionId);
  }

  private projectForCwd(cwd: string): string | null {
    const rows = this.ctx.db.prepare('SELECT project_id, repo_path FROM sess_projects WHERE repo_path IS NOT NULL').all() as {
      project_id: string;
      repo_path: string;
    }[];
    let best: { id: string; len: number } | null = null;
    for (const r of rows) {
      const root = r.repo_path.replace(/\/+$/, '');
      if ((cwd === root || cwd.startsWith(root + '/')) && (!best || root.length > best.len)) best = { id: r.project_id, len: root.length };
    }
    return best?.id ?? null;
  }

  /** Resolve (or create, for observed) the session a hook belongs to. */
  private resolve(req: HookIngestRequest, p: IngestPrincipal): SessionInfo | { error: HookIngestResponse } {
    if (req.mode === 'managed') {
      if (p.kind === 'observer') throw new HttpError(403, 'forbidden', 'Observer tokens cannot post managed events');
      const s = req.aocSessionId ? this.d.engine.get(req.aocSessionId) : null;
      if (!s || s.mode !== 'managed') {
        return { error: { exitCode: 2, stderr: 'AOC: unknown managed session — failing closed (AOC-SPEC-003 §2). Ask the operator.' } };
      }
      if (p.kind === 'session' && p.sessionId !== s.sessionId) throw new HttpError(403, 'forbidden', 'Token not valid for this session');
      return s;
    }
    const existing = this.d.engine.byClaudeSessionId(req.hook.session_id);
    if (existing) return existing;
    const sessionId = newId('session', this.ctx.clock.now());
    this.ctx.store.append({
      type: 'session.observed',
      actor: { kind: 'system', id: 'sessions' },
      scope: { sessionId },
      meta: { sessionId, claudeSessionId: req.hook.session_id, projectId: this.projectForCwd(req.hook.cwd) },
      payload: { cwd: req.hook.cwd, transcriptPath: req.hook.transcript_path ?? '' },
      source: 'hook',
      sourceTs: req.sentAt,
      idempotencyKey: `${req.idempotencyKey}:observed`,
    });
    this.d.engine.refresh(sessionId);
    return this.d.engine.get(sessionId)!;
  }

  dispatch(req: HookIngestRequest, p: IngestPrincipal): HookIngestResponse {
    const resolved = this.resolve(req, p);
    if ('error' in resolved) return resolved.error;
    const s = resolved;
    const h = req.hook as HookInput;
    const now = this.ctx.clock.now();
    const key = req.idempotencyKey;
    const scope = { sessionId: s.sessionId, projectId: s.projectId ?? undefined };
    switch (h.hook_event_name) {
      case 'SessionStart':
        if (s.mode === 'observed' && (s.lifecycle === 'ended' || s.lifecycle === 'idle')) this.setLifecycle(s, 'running', 'session_start', `${key}:lc`);
        this.d.engine.recordActivity(s.sessionId, 'stream', now);
        return { exitCode: 0 };
      case 'UserPromptSubmit':
        this.ctx.store.append({
          type: 'prompt.submitted',
          actor: s.mode === 'observed' ? this.agent(s.sessionId) : { kind: 'system', id: 'supervisor' },
          scope,
          meta: { sessionId: s.sessionId, origin: s.mode === 'observed' ? 'terminal' : 'supervisor' },
          payload: { text: summarize(h.prompt, 4000) },
          source: 'hook',
          sourceTs: req.sentAt,
          idempotencyKey: `${key}:prompt`,
        });
        if (s.mode === 'observed') this.setLifecycle(s, 'running', 'prompt', `${key}:lc`);
        this.d.engine.recordActivity(s.sessionId, 'stream', now);
        return { exitCode: 0 };
      case 'PreToolUse':
        return this.preToolUse(s, h, req);
      case 'PostToolUse': {
        const input = (h.tool_input ?? {}) as Record<string, unknown>;
        const ok = !toolFailed(h.tool_response);
        this.ctx.store.append({
          type: 'tool.used',
          actor: this.agent(s.sessionId),
          scope,
          meta: {
            sessionId: s.sessionId,
            toolName: h.tool_name.slice(0, 128),
            fileChanging: ok && (FILE_CHANGING_TOOLS as readonly string[]).includes(h.tool_name),
            ok,
            toolUseId: h.tool_use_id?.slice(0, 128) ?? null,
          },
          payload: { inputSummary: summarize(input), outputSummary: summarize(h.tool_response), filePaths: filePathsOf(input) },
          source: 'hook',
          sourceTs: req.sentAt,
          idempotencyKey: `${key}:tool`,
        });
        this.d.engine.toolFinished(s.sessionId, now);
        return { exitCode: 0 };
      }
      case 'PostToolUseFailure': {
        const f = h as Extract<HookInput, { hook_event_name: 'PostToolUseFailure' }>;
        const input = (f.tool_input ?? {}) as Record<string, unknown>;
        this.ctx.store.append({
          type: 'tool.used',
          actor: this.agent(s.sessionId),
          scope,
          meta: { sessionId: s.sessionId, toolName: f.tool_name.slice(0, 128), fileChanging: false, ok: false, toolUseId: f.tool_use_id?.slice(0, 128) ?? null },
          payload: { inputSummary: summarize(input), outputSummary: summarize(f.error ?? 'tool failed'), filePaths: filePathsOf(input) },
          source: 'hook',
          sourceTs: req.sentAt,
          idempotencyKey: `${key}:tool`,
        });
        this.d.engine.toolFinished(s.sessionId, now);
        return { exitCode: 0 };
      }
      case 'StopFailure': {
        const f = h as Extract<HookInput, { hook_event_name: 'StopFailure' }>;
        const row = this.d.engine.row(s.sessionId);
        if (/rate_limit/i.test(f.error ?? '') && row && !row.throttle_started_at) {
          this.ctx.store.append({
            type: 'throttle.hit',
            actor: this.agent(s.sessionId),
            scope,
            meta: { sessionId: s.sessionId, resetAt: null, source: 'exit' },
            payload: { message: summarize(f.last_assistant_message ?? f.error, 500) },
            source: 'hook',
            idempotencyKey: `${key}:throttle`,
          });
          if (s.mode === 'observed') this.setLifecycle(s, 'throttled', 'plan_limit', `${key}:lc`);
        }
        this.d.engine.recordActivity(s.sessionId, 'stream', now);
        return { exitCode: 0 };
      }
      case 'Stop':
      case 'SubagentStop':
        if (s.mode === 'observed' && h.hook_event_name === 'Stop') this.setLifecycle(s, 'idle', 'turn_ended', `${key}:lc`);
        this.d.engine.recordActivity(s.sessionId, 'stream', now);
        return { exitCode: 0 };
      case 'SessionEnd':
        if (s.mode === 'observed') {
          this.ctx.store.append({
            type: 'session.ended',
            actor: { kind: 'system', id: 'sessions' },
            scope,
            meta: { sessionId: s.sessionId, outcome: 'completed' },
            source: 'hook',
            idempotencyKey: `${key}:end`,
          });
          this.d.engine.refresh(s.sessionId);
          this.d.engine.forget(s.sessionId);
        }
        return { exitCode: 0 };
      default:
        this.d.engine.recordActivity(s.sessionId, 'stream', now);
        return { exitCode: 0 };
    }
  }

  private preToolUse(s: SessionInfo, h: Extract<HookInput, { hook_event_name: 'PreToolUse' }>, req: HookIngestRequest): HookIngestResponse {
    const now = this.ctx.clock.now();
    if (s.mode === 'observed') {
      this.d.engine.toolStarted(s.sessionId, now);
      return { exitCode: 0 };
    }
    const policy = this.ctx.services.get('policy');
    const pre: PreToolContext = { session: s, mode: s.mode, toolName: h.tool_name, toolInput: (h.tool_input ?? {}) as Record<string, unknown>, cwd: h.cwd };
    const r = policy.evaluate(pre);
    if (r.decision === 'allow') {
      this.d.engine.toolStarted(s.sessionId, now);
      return { exitCode: 0 };
    }
    const scope = { sessionId: s.sessionId, projectId: s.projectId ?? undefined };
    let decisionId: string | null = null;
    const decisions = this.ctx.services.maybe('decisions');
    if (r.raiseDecision && decisions) {
      const card = decisions.request(
        { ...r.raiseDecision, requesterId: `session:${s.sessionId}`, sessionId: s.sessionId, projectId: s.projectId },
        this.agent(s.sessionId),
      );
      decisionId = card.id;
    }
    this.ctx.store.append({
      type: 'tool.denied',
      actor: this.agent(s.sessionId),
      scope,
      meta: { sessionId: s.sessionId, toolName: h.tool_name.slice(0, 128), guard: r.guard.slice(0, 80), decision: r.decision === 'ask' ? 'ask' : 'deny', decisionId },
      payload: { reason: r.reason, inputSummary: summarize(h.tool_input) },
      source: 'hook',
      sourceTs: req.sentAt,
      idempotencyKey: `${req.idempotencyKey}:denied`,
    });
    if (r.blockReason) {
      this.ctx.store.append({
        type: 'session.blocked',
        actor: { kind: 'system', id: 'sessions' },
        scope,
        meta: { sessionId: s.sessionId, reason: r.blockReason },
        source: 'hook',
        idempotencyKey: `${req.idempotencyKey}:blocked`,
      });
    }
    this.d.engine.refresh(s.sessionId);
    const reason = decisionId
      ? `${r.reason}\nAOC turned this attempt into decision card ${decisionId}. END YOUR TURN NOW — the supervisor resumes this session with the human answer.`
      : r.reason;
    return { exitCode: 0, stdout: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } } };
  }
}

export function registerIngestRoutes(app: App, d: IngestDeps): void {
  const { ctx, engine } = d;
  const hooks = new HookDispatcher(d);

  /** The session an ingest body is about, as the principal may address it (observers only know the claude session id). */
  const sessionOf = (p: IngestPrincipal, sessionId: string, opts: { allowObserver?: boolean } = {}): string => {
    if (p.kind === 'observer') {
      if (!opts.allowObserver) throw new HttpError(403, 'forbidden', 'Token kind not allowed here');
      const s = engine.byClaudeSessionId(sessionId) ?? engine.get(sessionId);
      if (!s || s.mode !== 'observed') throw new HttpError(404, 'not_found', 'Unknown observed session');
      return s.sessionId;
    }
    if (p.kind === 'session' && p.sessionId !== sessionId) throw new HttpError(403, 'forbidden', 'Token not valid for this session');
    if (!engine.row(sessionId)) throw new HttpError(404, 'not_found', 'Unknown session');
    return sessionId;
  };

  const sessionFor = (c: Ctx, sessionId: string, opts: { allowObserver?: boolean } = {}): string =>
    sessionOf(requireIngest(c, { sessionId, allowObserver: opts.allowObserver }), sessionId, opts);

  const handleHook = (body: HookIngestRequest, p: IngestPrincipal): HookIngestResponse => {
    if (body.mode === 'observed' && p.kind === 'session') throw new HttpError(403, 'forbidden', 'Session tokens post managed events only');
    return hooks.dispatch(body, p);
  };

  /** Usage batches not seen before (by message id); returns how many batches were recorded / skipped. */
  const recordUsage = (b: z.infer<typeof UsageSchema>, sessionId: string): { recorded: number; skipped: number } => {
    const row = engine.row(sessionId)!;
    const seen = ctx.db.prepare('SELECT 1 FROM sess_seen_messages WHERE session_id = ? AND message_id = ?');
    let recorded = 0;
    let skipped = 0;
    b.batches.forEach((batch, i) => {
      const fresh = batch.messageIds.filter((id) => !seen.get(sessionId, id));
      if (!fresh.length) {
        skipped++;
        return;
      }
      ctx.store.append({
        type: 'usage.recorded',
        actor: { kind: 'agent', id: sessionId },
        scope: { sessionId, projectId: row.project_id ?? undefined },
        meta: {
          sessionId,
          model: batch.model,
          inputTokens: batch.inputTokens,
          outputTokens: batch.outputTokens,
          cacheReadTokens: batch.cacheReadTokens,
          cacheWrite5mTokens: batch.cacheWrite5mTokens,
          cacheWrite1hTokens: batch.cacheWrite1hTokens,
          messages: batch.messageIds.length,
          contextTokens: batch.contextTokens,
          firstAt: batch.firstAt,
          lastAt: batch.lastAt,
        },
        payload: { messageIds: batch.messageIds },
        source: row.mode === 'observed' ? 'hook' : 'sidecar',
        idempotencyKey: `${b.idempotencyKey}:${i}`,
      });
      recorded++;
    });
    return { recorded, skipped };
  };

  /** Opens a throttle episode unless one is already open; returns whether it did. */
  const recordThrottle = (b: z.infer<typeof ThrottleSchema>, sessionId: string): boolean => {
    const row = engine.row(sessionId)!;
    const fresh = !row.throttle_started_at;
    if (fresh) {
      ctx.store.append({
        type: 'throttle.hit',
        actor: { kind: 'agent', id: sessionId },
        scope: { sessionId, projectId: row.project_id ?? undefined },
        meta: { sessionId, resetAt: b.resetAt, source: b.source },
        payload: { message: b.message },
        source: row.mode === 'observed' ? 'hook' : 'sidecar',
      });
      if (row.mode === 'observed' && row.lifecycle !== 'throttled') {
        ctx.store.append({
          type: 'session.lifecycle_changed',
          actor: { kind: 'system', id: 'sessions' },
          scope: { sessionId },
          meta: { sessionId, from: row.lifecycle, to: 'throttled', reason: 'plan_limit' },
          source: 'hook',
        });
      }
    }
    engine.refresh(sessionId);
    return fresh;
  };

  /**
   * One spooled request, replayed under the flusher's principal. Clients spool hook events (hooks), observed usage
   * (observed hooks) and usage / throttle / process exits (sidecar): each goes through its live route's handler.
   */
  const replay = (item: SpoolItem, p: IngestPrincipal): 'accepted' | 'duplicate' => {
    switch (item.path) {
      case INGEST_PATHS.hook: {
        const req = HookIngestSchema.parse(item.body) as unknown as HookIngestRequest;
        if (ctx.store.findByIdempotencyKey(`${req.idempotencyKey}:tool`) || ctx.store.findByIdempotencyKey(`${req.idempotencyKey}:prompt`)) {
          return 'duplicate';
        }
        if (p.kind === 'session' && (req.mode !== 'managed' || req.aocSessionId !== p.sessionId)) {
          throw new HttpError(403, 'forbidden', 'Token not valid for this session');
        }
        handleHook(req, p);
        return 'accepted';
      }
      case INGEST_PATHS.usage: {
        const b = UsageSchema.parse(item.body);
        return recordUsage(b, sessionOf(p, b.sessionId, { allowObserver: true })).recorded > 0 ? 'accepted' : 'duplicate';
      }
      case INGEST_PATHS.throttle: {
        const b = ThrottleSchema.parse(item.body);
        return recordThrottle(b, sessionOf(p, b.sessionId, { allowObserver: true })) ? 'accepted' : 'duplicate';
      }
      case INGEST_PATHS.process: {
        const b = ProcessSchema.parse(item.body);
        engine.recordProcess(sessionOf(p, b.sessionId), false, null);
        return 'accepted';
      }
      default:
        throw new HttpError(422, 'invalid', 'This request cannot be replayed from a spool');
    }
  };

  app.post(INGEST_PATHS.hook, async (c) => {
    const body = (await readJson(c, HookIngestSchema)) as unknown as HookIngestRequest;
    const p = requireIngest(c, { sessionId: body.mode === 'managed' ? body.aocSessionId : null, allowObserver: body.mode === 'observed' });
    return c.json(handleHook(body, p));
  });

  app.post(INGEST_PATHS.spool, async (c) => {
    const body = await readJson(c, SpoolSchema);
    const p = requireIngest(c, { allowObserver: true });
    const res: SpoolFlushResponse = { accepted: 0, duplicates: 0, rejected: 0 };
    for (const item of body.items as SpoolItem[]) {
      try {
        if (replay(item, p) === 'duplicate') res.duplicates++;
        else res.accepted++;
      } catch {
        res.rejected++;
      }
    }
    return c.json(res);
  });

  app.post(INGEST_PATHS.heartbeat, async (c) => {
    const b = await readJson(c, HeartbeatSchema);
    const sessionId = sessionFor(c, b.sessionId);
    engine.heartbeat(sessionId, ctx.clock.now(), b.alive, b.pid);
    if (b.lastTranscriptWriteAt) engine.recordActivity(sessionId, 'transcript', Math.min(ctx.clock.now(), Date.parse(b.lastTranscriptWriteAt)));
    return c.json({ ok: true });
  });

  app.post(INGEST_PATHS.activity, async (c) => {
    const b = await readJson(c, ActivitySchema);
    const sessionId = sessionFor(c, b.sessionId);
    engine.recordActivity(sessionId, b.kind, ctx.clock.now());
    return c.json({ ok: true });
  });

  app.post(INGEST_PATHS.usage, async (c) => {
    const b = await readJson(c, UsageSchema);
    return c.json({ ok: true, ...recordUsage(b, sessionFor(c, b.sessionId, { allowObserver: true })) });
  });

  app.post(INGEST_PATHS.throttle, async (c) => {
    const b = await readJson(c, ThrottleSchema);
    recordThrottle(b, sessionFor(c, b.sessionId, { allowObserver: true }));
    return c.json({ ok: true });
  });

  app.post(INGEST_PATHS.process, async (c) => {
    const b = await readJson(c, ProcessSchema);
    engine.recordProcess(sessionFor(c, b.sessionId), false, null);
    return c.json({ ok: true });
  });
}
