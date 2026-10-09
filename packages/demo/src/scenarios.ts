import { isBuiltInScenario } from '@aoc/claude-sim';

/**
 * A managed-session prompt for claude-sim: the first line is the session's title, the last line a
 * `[[scenario:<name>]]` marker that makes claude-sim run that built-in scenario (packages/claude-sim/scenarios).
 */
export function simPrompt(title: string, details: string, scenario: string): string {
  if (!isBuiltInScenario(scenario)) throw new Error(`claude-sim has no built-in scenario "${scenario}"`);
  return `${title}\n\n${details}\n\n[[scenario:${scenario}]]`;
}

/** What claude-sim runs for a prompt without a marker; in the live demo that is a rollover successor. */
export const DEFAULT_LIVE_SCENARIO = 'demo-rollover-successor';
