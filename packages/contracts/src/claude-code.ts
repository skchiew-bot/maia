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

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
  'PreCompact',
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
}
export interface PreToolUseInput extends HookInputBase {
  hook_event_name: 'PreToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id?: string;
}
export interface PostToolUseInput extends HookInputBase {
  hook_event_name: 'PostToolUse';
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_response: unknown;
  tool_use_id?: string;
}
export interface UserPromptSubmitInput extends HookInputBase {
  hook_event_name: 'UserPromptSubmit';
  prompt: string;
}
export interface StopInput extends HookInputBase {
  hook_event_name: 'Stop' | 'SubagentStop';
  stop_hook_active: boolean;
}
export interface SessionStartInput extends HookInputBase {
  hook_event_name: 'SessionStart';
  source: 'startup' | 'resume' | 'clear' | 'compact';
}
export interface SessionEndInput extends HookInputBase {
  hook_event_name: 'SessionEnd';
  reason: string;
}
export interface NotificationInput extends HookInputBase {
  hook_event_name: 'Notification';
  message: string;
}
export interface PreCompactInput extends HookInputBase {
  hook_event_name: 'PreCompact';
  trigger: 'manual' | 'auto';
  custom_instructions?: string;
}
export type HookInput =
  | PreToolUseInput
  | PostToolUseInput
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
        permissionDecision: 'allow' | 'deny' | 'ask';
        permissionDecisionReason?: string;
      }
    | { hookEventName: 'SessionStart' | 'UserPromptSubmit' | 'PostToolUse'; additionalContext?: string };
}

/** Tools whose successful use changes files (used for the "task closed with no file change" flag, §4). */
export const FILE_CHANGING_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;
/** Read-only tools a session may use before declaring a plan, and the only built-ins triage sessions get. */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite'] as const;

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

/** Substrings / patterns that identify a plan usage-limit hit in Claude Code output (stream-json result or transcript). */
export const THROTTLE_PATTERNS: RegExp[] = [
  /Claude AI usage limit reached\|(\d{9,13})/i, // legacy "...|<epoch seconds>"
  /usage limit reached/i,
  /(?:5-hour|weekly|session|opus)\s+limit reached/i,
  /limit (?:will )?resets? (?:at|in)\s+([^\n.]+)/i,
  /rate_limit_error/i,
];

/** Context window sizes used by the rollover policy (tokens). */
export const MODEL_CONTEXT_TOKENS: Record<string, number> = {
  opus: 1_000_000,
  sonnet: 1_000_000,
  haiku: 1_000_000,
  fable: 1_000_000,
};
