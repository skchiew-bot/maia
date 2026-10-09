/**
 * Facts about Claude Code that the sim reproduces. Copied (not imported) from @aoc/contracts on purpose:
 * the sim must model Claude Code independently of the platform it is used to test.
 */

/** Version string the sim reports in transcripts, the init message and `--version`. */
export const CLAUDE_CODE_VERSION = '2.1.295';

/** Model aliases accepted by `--model`; full model ids pass through unchanged. */
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
  fable: 'claude-fable-5-1',
  default: 'claude-sonnet-5-5',
  opusplan: 'claude-opus-5-5',
};
export const DEFAULT_MODEL_ALIAS = 'sonnet';

/** Context window assumed for every model (tokens). */
export const CONTEXT_WINDOW_TOKENS = 1_000_000;
export const MAX_OUTPUT_TOKENS = 64_000;

/**
 * Built-in tools of Claude Code 2.1.x that the sim advertises (the `--tools` universe). LS, MultiEdit and
 * TodoWrite no longer exist there; the subagent tool is `Agent`.
 */
export const BUILTIN_TOOLS = [
  'Agent',
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read',
  'Skill',
  'WebFetch',
  'WebSearch',
  'Write',
] as const;

/** Tools that change files; they are confined to the working directory. */
export const FILE_EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit'];
/** Tools that never need a permission grant (path-based ones only inside the working directories). */
export const NO_PERMISSION_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'Agent'];

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'Stop',
  'StopFailure',
  'PreCompact',
  'SessionEnd',
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Hook events whose matcher is a tool name (comma-separated alternatives are allowed there). */
export const TOOL_HOOK_EVENTS: ReadonlySet<HookEventName> = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
]);

export const DEFAULT_HOOK_TIMEOUT_SECONDS = 60;

/** `source` of servers loaded from --mcp-config (system/init and the hooks' `mcp_server` field). */
export const MCP_CONFIG_SOURCE = 'dynamic';
