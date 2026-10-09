import fs from 'node:fs';
import path from 'node:path';
import { builtInScenario, isBuiltInScenario, listBuiltInScenarios } from './builtins';
import { parseScenario, ScenarioError, type Scenario, type StepOf } from './scenario-schema';

/** Where a session's scenario came from; persisted in the sim state so a resume replays the same one. */
export type ScenarioRef = { kind: 'builtin'; name: string } | { kind: 'file'; path: string };

export interface LoadedScenario {
  ref: ScenarioRef;
  scenario: Scenario;
  labels: ReadonlyMap<string, number>;
}

const MARKER = /\[\[scenario:([^\]\s]+)\]\]/;
/** AOC fences untrusted data (ticket text, a rollover's handoff brief) as `<<<TAG_<hex> … TAG_<hex>>>>`. */
const FENCED_DATA = /<<<([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_[0-9a-f]{6,})[\s\S]*?\1>>>/g;

/**
 * The `[[scenario:<name>]]` marker in a prompt, if any. A marker inside fenced data does not count: a handoff brief
 * quotes the thread's title, which is the predecessor's launch prompt, and a successor must not replay its scenario.
 */
export function scenarioMarker(prompt: string): string | undefined {
  return MARKER.exec(prompt.replace(FENCED_DATA, ''))?.[1];
}

/** A built-in name, or a path to a scenario JSON file (relative paths resolve against `cwd`). */
export function resolveScenarioRef(spec: string, cwd: string): ScenarioRef {
  const trimmed = spec.trim();
  if (isBuiltInScenario(trimmed)) return { kind: 'builtin', name: trimmed };
  const looksLikePath = trimmed.includes('/') || trimmed.includes('\\') || trimmed.endsWith('.json');
  const file = path.resolve(cwd, trimmed);
  if (looksLikePath && fs.existsSync(file)) return { kind: 'file', path: file };
  throw new ScenarioError(
    looksLikePath
      ? `scenario file not found: ${file}`
      : `unknown scenario "${trimmed}" (built-ins: ${listBuiltInScenarios().join(', ')})`,
  );
}

export function loadScenarioFile(file: string): Scenario {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ScenarioError(`cannot read scenario ${file}: ${(error as Error).message}`);
  }
  return parseScenario(raw, file);
}

export function loadScenario(ref: ScenarioRef): LoadedScenario {
  const scenario = ref.kind === 'builtin' ? builtInScenario(ref.name) : loadScenarioFile(ref.path);
  if (!scenario)
    throw new ScenarioError(`unknown scenario "${ref.kind === 'builtin' ? ref.name : ref.path}"`);
  const labels = new Map<string, number>();
  scenario.steps.forEach((step, index) => {
    if (step.label !== undefined) labels.set(step.label, index);
  });
  return { ref, scenario, labels };
}

export function gotoIndex(loaded: LoadedScenario, step: StepOf<'branch'>): number {
  const target = typeof step.goto === 'number' ? step.goto : loaded.labels.get(step.goto);
  if (target === undefined) throw new ScenarioError(`unknown goto target ${JSON.stringify(step.goto)}`);
  return target;
}
