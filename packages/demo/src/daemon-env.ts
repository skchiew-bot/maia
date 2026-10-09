import type { DemoLayout } from './layout';

/** Never handed to aocd or its sessions: claude-sim needs no credentials. */
export const SECRET_ENV: ReadonlySet<string> = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']);

/**
 * claude-sim settings every managed session of a demo needs (the demo config allowlists them): transcripts stay in
 * the demo, prompts without a scenario marker run the demo's default scenario, and the git steps of builds really run
 * (a session may run only what its process type grants: config/process-types.json, `tools`).
 */
export function simEnv(layout: DemoLayout): Record<string, string> {
  return {
    CLAUDE_CONFIG_DIR: layout.claudeConfig,
    CLAUDE_SIM_SCENARIO: layout.simDefaultScenario,
    CLAUDE_SIM_EXEC: '1',
  };
}

/** aocd's environment for a demo: the caller's, minus credentials and AOC_* overrides, plus the demo's own. */
export function daemonEnv(layout: DemoLayout, port: number, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('AOC_') && !SECRET_ENV.has(k)) env[k] = v;
  return {
    ...env,
    AOC_CONFIG: layout.config,
    AOC_PORT: String(port),
    AOC_LOG_LEVEL: base.AOC_LOG_LEVEL ?? 'info',
    ...simEnv(layout),
  };
}
