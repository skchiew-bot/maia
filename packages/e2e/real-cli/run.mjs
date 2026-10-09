#!/usr/bin/env node
// Entry of `pnpm --filter @aoc/e2e real-cli` (happy path + decision round trip) and `real-cli:full` (every scenario).
// These checks drive the real `claude` CLI on a cheap model and spend a few cents of the logged-in plan, so nothing
// here runs unless AOC_REAL_CLI=1 is set; `pnpm test` never reaches this file.
import { spawnSync } from 'node:child_process';

const full = process.argv.includes('--full');
const passthrough = process.argv.slice(2).filter((a) => a !== '--full');

if (process.env.AOC_REAL_CLI !== '1') {
  console.error(
    [
      'The real-CLI checks run the real `claude` CLI against this platform and spend model tokens (Haiku, a few cents',
      'per scenario). They are opt-in:',
      '',
      '  AOC_REAL_CLI=1 pnpm --filter @aoc/e2e real-cli          happy path + decision round trip (2 sessions)',
      '  AOC_REAL_CLI=1 pnpm --filter @aoc/e2e real-cli:full     every scenario (about 10 sessions, ~15 minutes)',
      '',
      'Optional: AOC_REAL_CLI_CLAUDE=<path to claude>, AOC_REAL_CLI_CLAUDE_CONFIG_DIR=<logged-in config dir>,',
      'AOC_REAL_CLI_CAPTURE=<dir for raw stream-json, hook inputs and event dumps>, AOC_REAL_CLI_KEEP=1,',
      'AOC_REAL_CLI_RUNS=<n> (compliance sampling over n two-task sessions). See docs/research/claude-code-integration.md.',
    ].join('\n'),
  );
  process.exit(1);
}

const claude = process.env.AOC_REAL_CLI_CLAUDE ?? 'claude';
const version = spawnSync(claude, ['--version'], { encoding: 'utf8' });
if (version.status !== 0) {
  console.error(`Cannot run \`${claude} --version\`: install Claude Code or set AOC_REAL_CLI_CLAUDE.`);
  process.exit(1);
}
console.log(`Real CLI: ${version.stdout.trim()}`);

const files = full ? [] : ['real-cli/happy.test.ts', 'real-cli/decision.test.ts'];
const run = spawnSync('vitest', ['run', '--config', 'vitest.real-cli.config.ts', ...files, ...passthrough], { stdio: 'inherit', env: process.env });
process.exit(run.status ?? 1);
