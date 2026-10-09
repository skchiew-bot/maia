import crash from '../scenarios/crash.json' with { type: 'json' };
import creditBurn from '../scenarios/credit-burn.json' with { type: 'json' };
import decision from '../scenarios/decision.json' with { type: 'json' };
import demoCsatResume from '../scenarios/demo-csat-resume.json' with { type: 'json' };
import demoDecision from '../scenarios/demo-decision.json' with { type: 'json' };
import demoDedupeResume from '../scenarios/demo-dedupe-resume.json' with { type: 'json' };
import demoDeepThink from '../scenarios/demo-deep-think.json' with { type: 'json' };
import demoFeatureBuild from '../scenarios/demo-feature-build.json' with { type: 'json' };
import demoRollover from '../scenarios/demo-rollover.json' with { type: 'json' };
import demoRolloverSuccessor from '../scenarios/demo-rollover-successor.json' with { type: 'json' };
import demoRunbookRestart from '../scenarios/demo-runbook-restart.json' with { type: 'json' };
import demoStall from '../scenarios/demo-stall.json' with { type: 'json' };
import demoThrottle from '../scenarios/demo-throttle.json' with { type: 'json' };
import demoTriage from '../scenarios/demo-triage.json' with { type: 'json' };
import drift from '../scenarios/drift.json' with { type: 'json' };
import evidenceMissing from '../scenarios/evidence-missing.json' with { type: 'json' };
import happyPath from '../scenarios/happy-path.json' with { type: 'json' };
import longContext from '../scenarios/long-context.json' with { type: 'json' };
import noPlanEdit from '../scenarios/no-plan-edit.json' with { type: 'json' };
import protectedPush from '../scenarios/protected-push.json' with { type: 'json' };
import stall from '../scenarios/stall.json' with { type: 'json' };
import throttle from '../scenarios/throttle.json' with { type: 'json' };
import triageLowConfidence from '../scenarios/triage-low-confidence.json' with { type: 'json' };
import triage from '../scenarios/triage.json' with { type: 'json' };
import { parseScenario, type Scenario } from './scenario-schema';

// Imported statically (not read from disk) so a bundled claude-sim binary carries its scenarios.
const RAW_BUILT_INS: Readonly<Record<string, unknown>> = {
  'happy-path': happyPath,
  decision,
  stall,
  crash,
  throttle,
  'no-plan-edit': noPlanEdit,
  'protected-push': protectedPush,
  'evidence-missing': evidenceMissing,
  triage,
  'triage-low-confidence': triageLowConfidence,
  'credit-burn': creditBurn,
  'long-context': longContext,
  drift,
  // Live demo (packages/demo): every state of the operator console, driven by real managed sessions.
  'demo-csat-resume': demoCsatResume,
  'demo-decision': demoDecision,
  'demo-dedupe-resume': demoDedupeResume,
  'demo-deep-think': demoDeepThink,
  'demo-feature-build': demoFeatureBuild,
  'demo-rollover': demoRollover,
  'demo-rollover-successor': demoRolloverSuccessor,
  'demo-runbook-restart': demoRunbookRestart,
  'demo-stall': demoStall,
  'demo-throttle': demoThrottle,
  'demo-triage': demoTriage,
};

export const DEFAULT_SCENARIO = 'happy-path';

const parsed = new Map<string, Scenario>();

/** Names of the scenarios shipped with the sim. */
export function listBuiltInScenarios(): string[] {
  return Object.keys(RAW_BUILT_INS);
}

export function isBuiltInScenario(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(RAW_BUILT_INS, name);
}

/** A validated built-in scenario, or undefined for an unknown name. */
export function builtInScenario(name: string): Scenario | undefined {
  if (!isBuiltInScenario(name)) return undefined;
  let scenario = parsed.get(name);
  if (!scenario) {
    scenario = parseScenario(RAW_BUILT_INS[name], `built-in "${name}"`);
    parsed.set(name, scenario);
  }
  return scenario;
}
