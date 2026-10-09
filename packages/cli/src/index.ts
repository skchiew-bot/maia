// @aoc/cli — the `aoc` command-line interface (entry: src/main.ts)
export { buildProgram, runCli, VERSION } from './cli';
export { CommandContext } from './context';
export {
  nodeDeps,
  type CliDeps,
  type ChildHandle,
  type GitRunner,
  type SignalSource,
  type SpawnFn,
  type SpawnRequest,
} from './deps';
export { CliError, EXIT, UsageError, type ExitCode } from './errors';
export { Api, ApiError } from './http';
export { API_PATHS, API_QUERY, CONSOLE_PATHS } from './paths';
export {
  clientConfigPath,
  DEFAULT_DAEMON_URL,
  resolveTarget,
  saveClientConfig,
  type ClientConfig,
  type Target,
} from './config';
export { livenessBadge, LIVENESS_SYMBOL, renderTable, renderTimeline, sanitize } from './format';
export {
  AOC_HOOK_TAG,
  defaultSettingsPath,
  inspectObservedHooks,
  installObservedHooks,
  isAocHandler,
  mergeObservedHooks,
  removeObservedHooks,
  uninstallObservedHooks,
} from './observed-hooks';
export {
  DEPLOY_SECRET_ENV_PATTERNS,
  deploySecretEnvNames,
  PRE_PUSH_GUARD_MARKER,
  RUNBOOK_PATH,
  runDoctor,
  type DoctorCheck,
  type DoctorFs,
  type DoctorInput,
} from './doctor';
