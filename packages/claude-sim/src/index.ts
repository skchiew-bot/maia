// @aoc/claude-sim — deterministic fake `claude` CLI for e2e tests, CI and demo data.
export { runClaudeSim, type SimIO } from './run';
export { simCommand } from './sim-command';
export { builtInScenario, DEFAULT_SCENARIO, isBuiltInScenario, listBuiltInScenarios } from './builtins';
export {
  loadScenario,
  loadScenarioFile,
  resolveScenarioRef,
  scenarioMarker,
  type LoadedScenario,
  type ScenarioRef,
} from './scenario';
export {
  parseScenario,
  ScenarioError,
  ScenarioSchema,
  ScenarioStepSchema,
  type Scenario,
  type ScenarioInput,
  type ScenarioStep,
  type ScenarioStepKind,
  type StepOf,
} from './scenario-schema';
export { CLAUDE_CODE_VERSION, MODEL_ALIASES } from './constants';
export { claudeConfigDir, projectSlug, simStatePathFor, transcriptPathFor } from './paths';
export { resolveModel, type Usage } from './usage';
export { loadState, type SimState } from './state';
export { mcpToolName } from './mcp';
export {
  decidePermission,
  parseRules,
  type PermissionMode,
  type PermissionPolicy,
  type PermissionVerdict,
} from './permissions';
