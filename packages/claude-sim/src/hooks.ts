import { spawn } from 'node:child_process';
import { DEFAULT_HOOK_TIMEOUT_SECONDS, TOOL_HOOK_EVENTS, type HookEventName } from './constants';
import { killGroup } from './process';
import type { HookCommand, HooksConfig } from './settings';

/**
 * Claude Code matcher semantics: empty or "*" matches everything; a plain name list ("Edit|Write", and for
 * tool events also "Edit, Write") must match exactly; anything else is an unanchored regex. Events without
 * a match target (Stop, UserPromptSubmit) run every configured hook.
 */
export function matcherMatches(
  matcher: string | undefined,
  value: string | undefined,
  toolEvent: boolean,
): boolean {
  if (value === undefined || !matcher || matcher === '*') return true;
  const simple = toolEvent ? /^[a-zA-Z0-9_|, -]+$/ : /^[a-zA-Z0-9_|]+$/;
  if (simple.test(matcher)) {
    return matcher
      .split(toolEvent ? /[|,]/ : '|')
      .map((part) => part.trim())
      .filter(Boolean)
      .includes(value);
  }
  try {
    return new RegExp(matcher).test(value);
  } catch {
    return false;
  }
}

export interface HookExecution {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  /** Parsed JSON object from stdout (exit 0 only). */
  json?: Record<string, unknown>;
}

export type PermissionBehavior = 'allow' | 'deny' | 'ask';

export interface HookOutcome {
  /** Display name used in transcript attachments, e.g. "PreToolUse:Edit" or "SessionStart:startup". */
  hookName: string;
  executions: HookExecution[];
  /**
   * Exit-2 errors and `decision: "block"` results. `text` is what Claude Code feeds back (`[command]: stderr`
   * for exit 2, the reason for a JSON block); `reason` is the bare stderr / reason.
   */
  blocking: { command: string; text: string; reason: string }[];
  permissionDecisions: { behavior: PermissionBehavior; reason?: string }[];
  preventContinuation: boolean;
  stopReason?: string;
  additionalContexts: string[];
  /** Non-zero (other than 2) exits, timeouts and hooks killed by an abort. */
  failures: HookExecution[];
}

export interface HookRunnerOptions {
  env: Readonly<Record<string, string>>;
  cwd: string;
  projectDir: string;
  disabled: boolean;
  debug?: (message: string) => void;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Plain (non-JSON) stdout of these events is added to the model's context, as in Claude Code. */
const PLAIN_STDOUT_IS_CONTEXT: ReadonlySet<HookEventName> = new Set(['SessionStart', 'UserPromptSubmit']);

export class HookRunner {
  constructor(
    private readonly config: HooksConfig,
    private readonly options: HookRunnerOptions,
  ) {}

  /** Commands configured for `event` whose matcher accepts `matchValue`, deduplicated like Claude Code does. */
  matching(event: HookEventName, matchValue?: string): HookCommand[] {
    if (this.options.disabled) return [];
    const seen = new Set<string>();
    const out: HookCommand[] = [];
    for (const group of this.config[event] ?? []) {
      if (!matcherMatches(group.matcher, matchValue, TOOL_HOOK_EVENTS.has(event))) continue;
      for (const hook of group.hooks) {
        if (seen.has(hook.command)) continue;
        seen.add(hook.command);
        out.push(hook);
      }
    }
    return out;
  }

  /**
   * Run every matching hook for `event` in parallel and fold their results (config order is kept). An abort
   * (`signal`) kills the hook processes still running.
   */
  async run(
    event: HookEventName,
    input: Record<string, unknown>,
    matchValue?: string,
    signal?: AbortSignal,
  ): Promise<HookOutcome> {
    const hookName = matchValue !== undefined ? `${event}:${matchValue}` : event;
    const commands = this.matching(event, matchValue);
    const payload = JSON.stringify(input);
    const executions = await Promise.all(commands.map((hook) => this.execute(hook, payload, signal)));
    const outcome: HookOutcome = {
      hookName,
      executions,
      blocking: [],
      permissionDecisions: [],
      preventContinuation: false,
      additionalContexts: [],
      failures: [],
    };
    for (const execution of executions) {
      this.options.debug?.(
        `hook ${hookName} [${execution.command}] exit=${execution.exitCode}${execution.timedOut ? ' (timed out)' : ''}`,
      );
      if (execution.timedOut || execution.exitCode === null) {
        outcome.failures.push(execution);
        continue;
      }
      if (execution.exitCode === 2) {
        const stderr = execution.stderr.trim() || 'No stderr output';
        outcome.blocking.push({
          command: execution.command,
          text: `[${execution.command}]: ${stderr}`,
          reason: stderr,
        });
        continue;
      }
      if (execution.exitCode !== 0) {
        outcome.failures.push(execution);
        continue;
      }
      const json = execution.json;
      if (!json) {
        const text = execution.stdout.trim();
        if (text && PLAIN_STDOUT_IS_CONTEXT.has(event)) outcome.additionalContexts.push(text);
        continue;
      }
      if (json.continue === false) {
        outcome.preventContinuation = true;
        if (typeof json.stopReason === 'string' && outcome.stopReason === undefined)
          outcome.stopReason = json.stopReason;
      }
      const reason = typeof json.reason === 'string' ? json.reason : undefined;
      if (json.decision === 'block') {
        outcome.blocking.push({
          command: execution.command,
          text: reason || 'Blocked by hook',
          reason: reason || 'Blocked by hook',
        });
        outcome.permissionDecisions.push({ behavior: 'deny', ...(reason !== undefined && { reason }) });
      } else if (json.decision === 'approve') {
        outcome.permissionDecisions.push({ behavior: 'allow' });
      }
      const specific = asRecord(json.hookSpecificOutput);
      if (specific) {
        const decision = specific.permissionDecision;
        if (decision === 'allow' || decision === 'deny' || decision === 'ask') {
          const why = specific.permissionDecisionReason;
          outcome.permissionDecisions.push({
            behavior: decision,
            ...(typeof why === 'string' && { reason: why }),
          });
        }
        if (typeof specific.additionalContext === 'string' && specific.additionalContext.trim()) {
          outcome.additionalContexts.push(specific.additionalContext);
        }
      }
    }
    return outcome;
  }

  private execute(hook: HookCommand, payload: string, signal?: AbortSignal): Promise<HookExecution> {
    const timeoutMs = (hook.timeout ?? DEFAULT_HOOK_TIMEOUT_SECONDS) * 1000;
    const started = Date.now();
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killed = false;
      let settled = false;
      let exitCode: number | null = null;
      const child = spawn('/bin/sh', ['-c', hook.command], {
        cwd: this.options.cwd,
        env: { ...this.options.env, CLAUDE_PROJECT_DIR: this.options.projectDir },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      });
      const onAbort = (): void => {
        killed = true;
        killGroup(child, 'SIGTERM');
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        const execution: HookExecution = {
          command: hook.command,
          exitCode: timedOut || killed ? null : exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - started,
          timedOut,
        };
        if (execution.exitCode === 0 && stdout.trim().startsWith('{')) {
          try {
            const parsed = asRecord(JSON.parse(stdout));
            if (parsed) execution.json = parsed;
          } catch {
            // not JSON after all: treated as plain output
          }
        }
        resolve(execution);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup(child, 'SIGTERM');
        setTimeout(() => killGroup(child, 'SIGKILL'), 1000).unref();
      }, timeoutMs);
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.stdin.on('error', () => {
        // the hook exited without reading its input
      });
      child.on('error', (error) => {
        stderr += error.message;
        finish();
      });
      child.on('exit', (code) => {
        exitCode = code;
        // A background grandchild may keep the pipes open; do not wait for it forever.
        setTimeout(finish, 250).unref();
      });
      child.on('close', finish);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      child.stdin.end(payload);
    });
  }
}
