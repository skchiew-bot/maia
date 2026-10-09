/*
 * `aoc-hook <HookEventName>`: relays one Claude Code hook invocation to aocd. The daemon decides; this only relays
 * (managed) or reports (observed). Hot path: no runtime imports from @aoc/contracts (see constants.ts); @aoc/client
 * only imports contract types, and the transcript reader loads lazily on the events that report usage.
 */
import { agentIdOfTranscript } from '@aoc/client';
import type {
  HookIngestRequest,
  HookIngestResponse,
  HookInput,
  HookOutput,
  UsageRequest,
} from '@aoc/contracts';
import { ENV, HOOKS_ENV, PATHS, type Env } from './constants';
import { hookIdempotencyKey, usageIdempotencyKey } from './idempotency';
import { resolveMode, type ManagedMode, type ObservedMode } from './mode';
import { flushSpoolBounded, spoolRequest, type SpoolTarget } from './spool';
import { postJson, type PostResult } from './transport';

export interface HookResult {
  exitCode: 0 | 2;
  /** Written verbatim to stdout (Claude Code parses it as the hook's JSON output). */
  stdout?: string;
  stderr?: string;
}

export interface RunHookOptions {
  /** argv[2], the event this command was registered for; stdin's hook_event_name wins when present. */
  event: string;
  stdin: string;
  env: Env;
  homeDir: string;
  now?: () => Date;
  pid?: number;
}

export const PRE_TOOL_USE_TIMEOUT_MS = 2500;
export const HOOK_TIMEOUT_MS = 5000;

export function hookTimeoutMs(event: string): number {
  return event === 'PreToolUse' ? PRE_TOOL_USE_TIMEOUT_MS : HOOK_TIMEOUT_MS;
}

interface Ctx {
  now: () => Date;
  pid: number;
}

type ParsedInput = { ok: true; event: string; hook: HookInput } | { ok: false; event: string; error: string };

const SILENT: HookResult = { exitCode: 0 };

/** Never rejects: every failure maps to a HookResult (fail closed for managed PreToolUse, silent for observed). */
export async function runHook(o: RunHookOptions): Promise<HookResult> {
  try {
    const ctx: Ctx = { now: o.now ?? (() => new Date()), pid: o.pid ?? process.pid };
    const mode = resolveMode(o.env, o.homeDir);
    if (mode.kind === 'off') return SILENT;
    const input = parseHookInput(o.stdin, o.event);
    if (mode.kind === 'observed') {
      try {
        if (input.ok) await runObserved(mode, input.event, input.hook, ctx);
      } catch {
        // observed hooks must never disturb the developer's session
      }
      return SILENT;
    }
    try {
      return await runManaged(mode, input, ctx);
    } catch (err) {
      return managedFailure(input.event, 'AOC hook failed', errorText(err));
    }
  } catch (err) {
    return hookFailureResult(o.event, o.env, err);
  }
}

/** Last-resort result when the hook breaks before it knows its mode: decided from the raw env. */
export function hookFailureResult(event: string, env: Env, err: unknown): HookResult {
  const managed = env[ENV.mode] === 'managed' && env[HOOKS_ENV.hookScope] !== 'observed';
  return managed ? managedFailure(event, 'AOC hook failed', errorText(err)) : SILENT;
}

function parseHookInput(stdin: string, argvEvent: string): ParsedInput {
  let data: unknown;
  try {
    data = JSON.parse(stdin);
  } catch (err) {
    return { ok: false, event: argvEvent, error: `hook input is not JSON (${errorText(err)})` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    return { ok: false, event: argvEvent, error: 'hook input is not a JSON object' };
  const h = data as Record<string, unknown>;
  const event = typeof h.hook_event_name === 'string' && h.hook_event_name ? h.hook_event_name : argvEvent;
  if (!event) return { ok: false, event, error: 'no hook event name in argv or hook input' };
  if (typeof h.session_id !== 'string' || !h.session_id)
    return { ok: false, event, error: 'hook input has no session_id' };
  return { ok: true, event, hook: { ...h, hook_event_name: event } as unknown as HookInput };
}

// ---------------------------------------------------------------------------------------------------- managed

async function runManaged(mode: ManagedMode, input: ParsedInput, ctx: Ctx): Promise<HookResult> {
  if (!input.ok) return managedFailure(input.event, 'AOC hook could not read its input', input.error);
  const { event, hook } = input;
  if (!mode.aocSessionId)
    return managedFailure(event, 'AOC managed session is misconfigured', `${ENV.sessionId} is not set`);
  if (event === 'SessionStart' && !mode.readOnly) await installWorkspaceGitHooks(hook);
  const req = hookRequest('managed', mode.aocSessionId, event, hook, ctx);
  const target: SpoolTarget = { spoolDir: mode.spoolDir, daemonUrl: mode.daemonUrl, token: mode.token };
  const r: PostResult<unknown> = mode.daemonUrl
    ? await postJson(mode.daemonUrl, PATHS.hook, req, { token: mode.token, timeoutMs: hookTimeoutMs(event) })
    : { ok: false, status: null, error: `${ENV.daemonUrl} is not set`, retryable: true };

  if (r.ok) {
    const res = asHookIngestResponse(r.data);
    if (!res) {
      return managedFailure(
        event,
        'AOC daemon returned an invalid hook response',
        `HTTP ${r.status}`,
        'reached the daemon but its answer was ignored',
      );
    }
    // Replaying the spool would delay the tool call, so PreToolUse never flushes.
    if (event !== 'PreToolUse') await flushSpoolBounded(target);
    return {
      exitCode: res.exitCode,
      stdout: res.stdout ? JSON.stringify(res.stdout) : undefined,
      stderr: res.stderr ? res.stderr : undefined,
    };
  }
  if (!r.retryable)
    return managedFailure(event, `AOC daemon rejected the ${event} hook (HTTP ${r.status})`, r.error);
  if (event === 'PreToolUse') return failClosed('AOC daemon unreachable', r.error);
  const spooled = await spoolRequest(target, PATHS.hook, req, ctx.now());
  return systemMessage(
    spooled
      ? `AOC daemon unreachable (${r.error}): the ${event} event was spooled to ${mode.spoolDir} and will be replayed when the daemon is back.`
      : `AOC daemon unreachable (${r.error}) and the local spool failed: the ${event} event was not recorded.`,
  );
}

/** Best effort: a workspace without the git hooks still works, and the session must start regardless. */
async function installWorkspaceGitHooks(hook: HookInput): Promise<void> {
  if (!hook.cwd) return;
  try {
    const { ensureGitHooks } = await import('./prepush');
    ensureGitHooks(hook.cwd);
  } catch {
    // unwritable hooks directory: commits simply carry no trailers
  }
}

/** Managed sessions fail loudly (AOC-SPEC-003 §2): PreToolUse is blocked, every other event warns the user. */
function managedFailure(
  event: string,
  what: string,
  detail: string,
  effect = 'was not recorded',
): HookResult {
  if (event === 'PreToolUse') return failClosed(what, detail);
  return systemMessage(`${what} (${detail}): the ${event || 'hook'} event ${effect}.`);
}

function failClosed(what: string, detail: string): HookResult {
  return {
    exitCode: 2,
    stderr: `${what} — managed sessions fail closed (AOC-SPEC-003 §2). Ask the operator.\nDetail: ${detail}\n`,
  };
}

function systemMessage(message: string): HookResult {
  return { exitCode: 0, stdout: JSON.stringify({ systemMessage: message } satisfies HookOutput) };
}

function asHookIngestResponse(data: unknown): HookIngestResponse | null {
  const r = data as Partial<HookIngestResponse> | null;
  if (!r || typeof r !== 'object') return null;
  if (r.exitCode !== 0 && r.exitCode !== 2) return null;
  if (r.stdout != null && (typeof r.stdout !== 'object' || Array.isArray(r.stdout))) return null;
  if (r.stderr != null && typeof r.stderr !== 'string') return null;
  return r as HookIngestResponse;
}

// --------------------------------------------------------------------------------------------------- observed

/** Report-only: whatever the daemon answers, the hook prints nothing and exits 0. */
async function runObserved(mode: ObservedMode, event: string, hook: HookInput, ctx: Ctx): Promise<void> {
  const target: SpoolTarget = { spoolDir: mode.spoolDir, daemonUrl: mode.daemonUrl, token: mode.token };
  const req = hookRequest('observed', null, event, hook, ctx);
  const r = await postJson(mode.daemonUrl, PATHS.hook, req, {
    token: mode.token,
    timeoutMs: hookTimeoutMs(event),
  });
  if (!r.ok && r.retryable) await spoolRequest(target, PATHS.hook, req, ctx.now());
  let delivered = r.ok;
  const transcript = usageTranscript(event, hook);
  if (transcript) {
    const daemonDown = !r.ok && r.retryable;
    delivered =
      (await reportObservedUsage(mode, target, hook.session_id, transcript, !daemonDown, ctx)) || delivered;
  }
  if (delivered) await flushSpoolBounded(target);
}

interface UsageTranscript {
  path: string;
  agentId: string | null;
}

/**
 * Stop / StopFailure (turn ended on an API error) / SessionEnd read the main transcript; SubagentStop reads the
 * subagent's own transcript (<session>/subagents/agent-<id>.jsonl) — subagent usage never reaches the main one.
 */
function usageTranscript(event: string, hook: HookInput): UsageTranscript | null {
  const h = hook as unknown as Record<string, unknown>;
  if (event === 'Stop' || event === 'StopFailure' || event === 'SessionEnd') {
    return typeof h.transcript_path === 'string' && h.transcript_path
      ? { path: h.transcript_path, agentId: null }
      : null;
  }
  if (event === 'SubagentStop' && typeof h.agent_transcript_path === 'string' && h.agent_transcript_path) {
    const agentId =
      typeof h.agent_id === 'string' && h.agent_id
        ? h.agent_id
        : agentIdOfTranscript(h.agent_transcript_path);
    return { path: h.agent_transcript_path, agentId };
  }
  return null;
}

/** True when usage reached the daemon. The cursor only advances once the batches are delivered or spooled. */
async function reportObservedUsage(
  mode: ObservedMode,
  target: SpoolTarget,
  claudeSessionId: string,
  t: UsageTranscript,
  tryNetwork: boolean,
  ctx: Ctx,
): Promise<boolean> {
  const { readObservedUsage } = await import('./usage');
  const now = ctx.now();
  const read = readObservedUsage({
    stateDir: mode.stateDir,
    claudeSessionId,
    agentId: t.agentId,
    transcriptPath: t.path,
    now,
  });
  if (!read) return false;
  if (read.batches.length === 0) {
    read.commit();
    return false;
  }
  // Observed sessions have no AOC session id client-side: the daemon maps the claude session id (observer token).
  const body: UsageRequest = {
    sessionId: claudeSessionId,
    batches: read.batches,
    idempotencyKey: usageIdempotencyKey(claudeSessionId, t.agentId, read.messageIds),
  };
  if (tryNetwork) {
    const r = await postJson(mode.daemonUrl, PATHS.usage, body, {
      token: mode.token,
      timeoutMs: HOOK_TIMEOUT_MS,
    });
    if (r.ok) {
      read.commit();
      return true;
    }
    // Rejected (4xx): keep the cursor so the range is re-sent once the daemon accepts it.
    if (!r.retryable) return false;
  }
  if (await spoolRequest(target, PATHS.usage, body, now)) read.commit();
  return false;
}

// ----------------------------------------------------------------------------------------------------- shared

function hookRequest(
  mode: 'managed' | 'observed',
  aocSessionId: string | null,
  event: string,
  hook: HookInput,
  ctx: Ctx,
): HookIngestRequest {
  const sentAt = ctx.now().toISOString();
  const h = hook as unknown as Record<string, unknown>;
  const idempotencyKey = hookIdempotencyKey({
    aocSessionId,
    claudeSessionId: hook.session_id,
    event,
    toolUseId: typeof h.tool_use_id === 'string' ? h.tool_use_id : null,
    agentId: typeof h.agent_id === 'string' ? h.agent_id : null,
    sentAt,
    pid: ctx.pid,
  });
  return { mode, aocSessionId, hook, sentAt, idempotencyKey };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
