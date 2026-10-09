/**
 * Facts about Claude Code that AOC components rely on (hooks protocol, transcript format, CLI flags).
 * Verified against Claude Code 2.1.x. Keep this the single source of truth for the sim, hooks, sidecar and supervisor.
 */
// Browser-safe: no node: imports in contracts (the web bundle imports this package).

/** ~/.claude/projects/<slug>/<sessionId>.jsonl — slug = cwd with every non-alphanumeric char replaced by '-'. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}
/** Resolve the Claude Code config dir: $CLAUDE_CONFIG_DIR, else $HOME/.claude. */
export function claudeConfigDir(env: Record<string, string | undefined>, homeDir: string): string {
  return env.CLAUDE_CONFIG_DIR || `${env.HOME || homeDir}/.claude`;
}
export function transcriptPathFor(cwd: string, claudeSessionId: string, configDir: string): string {
  return `${configDir.replace(/\/+$/, '')}/projects/${projectSlug(cwd)}/${claudeSessionId}.jsonl`;
}

/**
 * Hook events AOC registers. Verified on 2.1.295 (docs/research/claude-code-integration.md §1 C1):
 * PostToolUseFailure fires INSTEAD of PostToolUse when a tool fails; StopFailure ends turns on API errors
 * (e.g. rate_limit); Notification never fires in -p mode.
 */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'PermissionRequest',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'SessionEnd',
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Common stdin JSON for every hook invocation. */
export interface HookInputBase {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: HookEventName;
  permission_mode?: string;
  prompt_id?: string;
  effort?: { level: string };
}
export interface PreToolUseInput extends HookInputBase {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  mcp_server?: { name: string; source: string };
}
export interface PostToolUseInput extends HookInputBase {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
  tool_use_id?: string;
  duration_ms?: number;
  mcp_server?: { name: string; source: string };
}
/** Fires instead of PostToolUse when a tool fails (no tool_response). */
export interface PostToolUseFailureInput extends HookInputBase {
  hook_event_name: 'PostToolUseFailure';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
  error: string;
  is_interrupt?: boolean;
  duration_ms?: number;
}
/** Turn ended on an API error (error: 'rate_limit' → Throttled). */
export interface StopFailureInput extends HookInputBase {
  hook_event_name: 'StopFailure';
  error: string;
  last_assistant_message?: string;
}
export interface UserPromptSubmitInput extends HookInputBase {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
}
export interface StopInput extends HookInputBase {
  hook_event_name: 'Stop' | 'SubagentStop';
  stop_hook_active: boolean;
  last_assistant_message?: string;
  agent_id?: string;
  agent_type?: string;
  agent_transcript_path?: string;
}
export interface SessionStartInput extends HookInputBase {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume' | 'clear' | 'compact' | 'fork';
  context_tokens?: number;
  model?: string;
}
/** Other events AOC only observes (PostToolBatch, PermissionRequest, SubagentStart, PostCompact). */
export interface GenericHookInput extends HookInputBase {
  hook_event_name: 'PostToolBatch' | 'PermissionRequest' | 'SubagentStart' | 'PostCompact';
  [k: string]: unknown;
}
export interface SessionEndInput extends HookInputBase {
  hook_event_name: 'SessionEnd';
  reason: string;
}
export interface NotificationInput extends HookInputBase {
  hook_event_name: 'Notification';
  message: string;
  notification_type?: string;
  title?: string;
}
export interface PreCompactInput extends HookInputBase {
  hook_event_name: 'PreCompact';
  trigger: 'manual' | 'auto';
  custom_instructions?: string | null;
}
export type HookInput =
  | PreToolUseInput
  | PostToolUseInput
  | PostToolUseFailureInput
  | StopFailureInput
  | GenericHookInput
  | UserPromptSubmitInput
  | StopInput
  | SessionStartInput
  | SessionEndInput
  | NotificationInput
  | PreCompactInput;

/**
 * Hook output: exit 0 = ok (stdout JSON optional); exit 2 = blocking error (stderr is shown to Claude for
 * PreToolUse / Stop / UserPromptSubmit); other non-zero = non-blocking error.
 */
export interface HookOutput {
  continue?: boolean;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  /** Stop / SubagentStop / UserPromptSubmit / PostToolUse */
  decision?: 'block';
  reason?: string;
  hookSpecificOutput?:
    | {
        hookEventName: 'PreToolUse';
        /** 'defer' ends a -p turn cleanly (terminal_reason tool_deferred); `--resume` re-runs the same call. */
        permissionDecision: 'allow' | 'deny' | 'ask' | 'defer';
        permissionDecisionReason?: string;
        additionalContext?: string;
      }
    | { hookEventName: 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse'; additionalContext?: string };
}

/** Tools whose successful use changes files. MultiEdit is kept for older CLI versions. Bash can change files too —
 *  evidence of change must come from git (working-tree fingerprint / commits), not tool names alone (§4). */
export const FILE_CHANGING_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;
/** Read-only tools allowed before a plan is declared. (LS / TodoWrite do not exist in 2.1.x.) */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ToolSearch'] as const;
/** Built-in tool set for read-only triage sessions: launch with `--tools "Read,Glob,Grep"`. */
export const TRIAGE_TOOLS = ['Read', 'Glob', 'Grep'] as const;
/** The subagent tool is named `Agent` in hooks/tool_use (and `Task` in init.tools / older versions). */
export const SUBAGENT_TOOL_NAMES = ['Agent', 'Task'] as const;

/** Transcript line (subset). Assistant API responses are split into one line per content block, each line
 *  repeating the same `message.id`, `requestId` and `message.usage` — metering MUST dedupe by message.id. */
export interface TranscriptUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}
export interface TranscriptLine {
  type: 'user' | 'assistant' | 'system' | 'summary' | 'attachment' | string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;
  requestId?: string;
  cwd?: string;
  isSidechain?: boolean;
  message?: {
    id?: string;
    role?: 'user' | 'assistant';
    model?: string;
    content?: unknown;
    stop_reason?: string | null;
    usage?: TranscriptUsage;
  };
  toolUseResult?: unknown;
}

/**
 * Plan usage-limit detection — TEXT FALLBACK only (docs/research §9). Prefer, in order: stream-json
 * `rate_limit_event` with `rate_limit_info.status === 'rejected'` (resetsAt = epoch seconds), the `StopFailure`
 * hook with `error: 'rate_limit'`, `result.api_error_status === 429`. Warnings ("You've used 90% …",
 * "Approaching …") are NOT throttles.
 */
export const THROTTLE_PATTERNS: RegExp[] = [
  /You['’]ve hit your (?:[\w'’ ]{1,40} )?(?:limit|budget)/i,
  /You['’]ve reached your [\w ]{1,40} limit/i,
  /You['’]re out of (?:usage credits|extra usage)/i,
  /Your org is out of usage/i,
  /Claude AI usage limit reached\|(\d{9,13})/i,
  /(?:\d+-hour|weekly|session|opus(?: weekly)?)\s+limit reached/i,
  /usage limit reached/i,
];
/** Reset time: group 1 = "3pm" | "12:50am" | "Oct 14, 3pm" | "Nov 13"; group 2 = IANA zone if present. */
export const THROTTLE_RESET =
  /(?:[·∙•-]\s*resets?|Resets? at|reset at)\s+((?:[A-Z][a-z]{2} \d{1,2}(?:, \d{4})?(?:, \d{1,2}(?::\d{2})?\s?(?:am|pm))?)|\d{1,2}(?::\d{2})?\s?(?:am|pm))(?:\s*\(([^)]+)\))?/i;
/** Short-term API rate limit (HTTP 429) — Throttled with an unknown reset. */
export const RATE_LIMIT_429 = /API Error: Rate limit reached|rate_limit_error/i;

/** stream-json rate limit line (one per run): the best throttle signal. */
export interface RateLimitEvent {
  type: 'rate_limit_event';
  rate_limit_info: {
    status: 'allowed' | 'allowed_warning' | 'rejected';
    resetsAt?: number;
    rateLimitType?: string;
    unifiedWindows?: Record<string, { utilization: number; resetsAt: number }>;
  };
  session_id?: string;
}

/** Context window sizes used by the rollover policy (tokens). */
export const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  opus: 1_000_000,
  sonnet: 1_000_000,
  haiku: 1_000_000,
  fable: 1_000_000,
};
