// @aoc/hooks — Claude Code hook binary (managed: relay + fail closed; observed: report-only with local buffer),
// hook settings install/uninstall, and the managed-workspace git hooks. Binary entry: src/main.ts.
export { HOOKS_ENV, type Env } from './constants';
export { hookIdempotencyKey, usageIdempotencyKey, type HookKeyParts } from './idempotency';
export {
  readObserverConfig,
  resolveMode,
  type HookMode,
  type ManagedMode,
  type ObservedMode,
  type OffMode,
} from './mode';
export {
  GIT_HOOK_ENV,
  GIT_HOOK_NAMES,
  PROTECTED_BRANCHES,
  evaluatePrePush,
  gitHooksDir,
  installGitHooks,
  isProtectedRef,
} from './prepush';
export {
  HOOK_TIMEOUT_MS,
  PRE_TOOL_USE_TIMEOUT_MS,
  hookTimeoutMs,
  runHook,
  type HookResult,
  type RunHookOptions,
} from './run';
export {
  HOOK_TIMEOUT_SECONDS,
  OBSERVED_HOOK_PREFIX,
  REGISTERED_HOOK_EVENTS,
  buildHookSettings,
  isObservedHookCommand,
  mergeObservedHooks,
  removeObservedHooks,
  shellJoin,
  validateHookSettings,
  type BuildHookSettingsOptions,
  type HookCommandEntry,
  type HookMatcherGroup,
  type HookSettings,
} from './settings';
export {
  cursorFile,
  loadCursor,
  readObservedUsage,
  readTranscriptUsage,
  saveCursor,
  type ObservedUsageRead,
  type TranscriptCursor,
  type UsageReadResult,
} from './usage';
