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
import { HttpError, readJson, requireIngest, sha256hex, type App, type Ctx, type ModuleContext } from '@aoc/kernel';
import { z } from 'zod';
import type { SessionsEngine } from './engine';

/** Chained as the event's sourceTs: a timestamp, never free text. */
const zSentAt = z.string().min(10).max(40).refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO-8601 timestamp');

/** How far before its receipt a usage batch may be dated: the sidecar ships every 10 s, a spool replay later. */
export const USAGE_MAX_AGE_MS = 3_600_000;

/**
 * Usage times decide the credit period and the metering day a batch counts in, and the client chooses them: they
 * are kept within [max(session start, receipt − USAGE_MAX_AGE_MS), receipt], so usage can neither be backdated into
 * a closed period nor dated into a future one. Times are returned as UTC ISO strings.
 */
export function boundUsageTimes(
  claimed: { firstAt: string; lastAt: string },
  bounds: { receivedAt: number; sessionStartedAt: number | null },
): { firstAt: string; lastAt: string; clamped: boolean } {
  const hi = bounds.receivedAt;
  const lo = Math.min(hi, Math.max(bounds.sessionStartedAt ?? -Infinity, hi - USAGE_MAX_AGE_MS));
  const clamp = (ms: number) => Math.min(hi, Math.max(lo, ms));
  const first = Date.parse(claimed.firstAt);
  const last = clamp(Date.parse(claimed.lastAt));
  const firstAt = Math.min(clamp(first), last);
  return {
    firstAt: new Date(firstAt).toISOString(),
    lastAt: new Date(last).toISOString(),
    clamped: firstAt !== first || last !== Date.parse(claimed.lastAt),
  };
}

const HookIngestSchema = z.object({
  mode: z.enum(['managed', 'observed']),
  aocSessionId: z.string().max(64).nullable(),
  hook: z.object({ session_id: z.string().min(1).max(128), hook_event_name: z.string(), cwd: z.string().default('') }).passthrough(),
  sentAt: zSentAt,
  idempotencyKey: z.string().min(8).max(200),
});

/**
 * Client idempotency keys never reach the chain verbatim: each is bound to the session it claims (so a token cannot
 * pre-claim or swallow another session's events with a colliding key) and hashed (so no client text is chained).
 */
function hookKey(req: HookIngestRequest, suffix: string): string {
  return `hook:${sha256hex([req.mode, req.aocSessionId ?? '', req.hook.session_id, req.idempotencyKey].join('\n'))}:${suffix}`;
}
function usageKey(sessionId: string, clientKey: string, batch: number): string {
  return `usage:${sha256hex([sessionId, clientKey].join('\n'))}:${batch}`;
}
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
        firstAt: zSentAt,
        lastAt: zSentAt,
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
  // Two independent tests rather than `find.*-exec`: that backtracks quadratically, on the daemon thread.
  if (/\bfind\b/.test(command) && /\s-(delete|exec|execdir|ok)\b/.test(command)) return false;
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
    // Managed sessions also carry a claude session id (visible on the console). Observed-mode events must never
    // reach them, or any holder of the shared observer token could forge a managed session's audit trail.
    if (existing && existing.mode !== 'observed') throw new HttpError(403, 'forbidden', 'Observed events cannot target a managed session');
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
      idempotencyKey: hookKey(req, 'observed'),
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
    const key = (suffix: string) => hookKey(req, suffix);
    const scope = { sessionId: s.sessionId, projectId: s.projectId ?? undefined };
    switch (h.hook_event_name) {
      case 'SessionStart':
        if (s.mode === 'observed' && (s.lifecycle === 'ended' || s.lifecycle === 'idle')) this.setLifecycle(s, 'running', 'session_start', key('lc'));
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
          idempotencyKey: key('prompt'),
        });
        if (s.mode === 'observed') this.setLifecycle(s, 'running', 'prompt', key('lc'));
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
          idempotencyKey: key('tool'),
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
          idempotencyKey: key('tool'),
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
            idempotencyKey: key('throttle'),
          });
          if (s.mode === 'observed') this.setLifecycle(s, 'throttled', 'plan_limit', key('lc'));
        }
        this.d.engine.recordActivity(s.sessionId, 'stream', now);
        return { exitCode: 0 };
      }
      case 'Stop':
      case 'SubagentStop':
        if (s.mode === 'observed' && h.hook_event_name === 'Stop') this.setLifecycle(s, 'idle', 'turn_ended', key('lc'));
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
            idempotencyKey: key('end'),
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
      idempotencyKey: hookKey(req, 'denied'),
    });
    if (r.blockReason) {
      this.ctx.store.append({
        type: 'session.blocked',
        actor: { kind: 'system', id: 'sessions' },
        scope,
        meta: { sessionId: s.sessionId, reason: r.blockReason },
        source: 'hook',
        idempotencyKey: hookKey(req, 'blocked'),
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

  const sessionFor = (c: Ctx, sessionId: string, opts: { allowObserver?: boolean } = {}): { p: IngestPrincipal; sessionId: string } => {
    const p = requireIngest(c, { sessionId, allowObserver: opts.allowObserver });
    if (p.kind === 'observer') {
      // Observed senders only know the claude session id.
      const s = engine.byClaudeSessionId(sessionId) ?? engine.get(sessionId);
      if (!s || s.mode !== 'observed') throw new HttpError(404, 'not_found', 'Unknown observed session');
      return { p, sessionId: s.sessionId };
    }
    if (!engine.row(sessionId)) throw new HttpError(404, 'not_found', 'Unknown session');
    return { p, sessionId };
  };

  const handleHook = (body: HookIngestRequest, p: IngestPrincipal): HookIngestResponse => {
    if (body.mode === 'observed' && p.kind === 'session') throw new HttpError(403, 'forbidden', 'Session tokens post managed events only');
    return hooks.dispatch(body, p);
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
        if (item.path !== INGEST_PATHS.hook) {
          res.rejected++;
          continue;
        }
        const parsed = HookIngestSchema.safeParse(item.body);
        if (!parsed.success) {
          res.rejected++;
          continue;
        }
        const req = parsed.data as unknown as HookIngestRequest;
        if (ctx.store.findByIdempotencyKey(hookKey(req, 'tool')) || ctx.store.findByIdempotencyKey(hookKey(req, 'prompt'))) {
          res.duplicates++;
          continue;
        }
        if (p.kind === 'session' && (req.mode !== 'managed' || req.aocSessionId !== p.sessionId)) {
          res.rejected++;
          continue;
        }
        handleHook(req, p);
        res.accepted++;
      } catch {
        res.rejected++;
      }
    }
    return c.json(res);
  });

  app.post(INGEST_PATHS.heartbeat, async (c) => {
    const b = await readJson(c, HeartbeatSchema);
    const { sessionId } = sessionFor(c, b.sessionId);
    engine.heartbeat(sessionId, ctx.clock.now(), b.alive, b.pid);
    if (b.lastTranscriptWriteAt) engine.recordActivity(sessionId, 'transcript', Math.min(ctx.clock.now(), Date.parse(b.lastTranscriptWriteAt)));
    return c.json({ ok: true });
  });

  app.post(INGEST_PATHS.activity, async (c) => {
    const b = await readJson(c, ActivitySchema);
    const { sessionId } = sessionFor(c, b.sessionId);
    engine.recordActivity(sessionId, b.kind, ctx.clock.now());
    return c.json({ ok: true });
  });

  app.post(INGEST_PATHS.usage, async (c) => {
    const b = await readJson(c, UsageSchema);
    const { sessionId } = sessionFor(c, b.sessionId, { allowObserver: true });
    const row = engine.row(sessionId)!;
    const seen = ctx.db.prepare('SELECT 1 FROM sess_seen_messages WHERE session_id = ? AND message_id = ?');
    const bounds = { receivedAt: ctx.clock.now(), sessionStartedAt: Date.parse(row.started_at) };
    let recorded = 0;
    let skipped = 0;
    b.batches.forEach((batch, i) => {
      const fresh = batch.messageIds.filter((id) => !seen.get(sessionId, id));
      if (!fresh.length) {
        skipped++;
        return;
      }
      const at = boundUsageTimes(batch, bounds);
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
          firstAt: at.firstAt,
          lastAt: at.lastAt,
        },
        payload: { messageIds: batch.messageIds, ...(at.clamped ? { claimed: { firstAt: batch.firstAt, lastAt: batch.lastAt } } : {}) },
        source: row.mode === 'observed' ? 'hook' : 'sidecar',
        idempotencyKey: usageKey(sessionId, b.idempotencyKey, i),
      });
      recorded++;
    });
    return c.json({ ok: true, recorded, skipped });
  });

  app.post(INGEST_PATHS.throttle, async (c) => {
    const b = await readJson(c, ThrottleSchema);
    const { sessionId } = sessionFor(c, b.sessionId, { allowObserver: true });
    const row = engine.row(sessionId)!;
    if (!row.throttle_started_at) {
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
    return c.json({ ok: true });
  });

  app.post(INGEST_PATHS.process, async (c) => {
    const b = await readJson(c, ProcessSchema);
    const { sessionId } = sessionFor(c, b.sessionId);
    engine.recordProcess(sessionId, false, null);
    return c.json({ ok: true });
  });
}
