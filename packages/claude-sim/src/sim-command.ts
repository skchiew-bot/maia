import { fileURLToPath } from 'node:url';

/**
 * How to spawn the sim as a `claude` executable from tests and sibling packages (no build needed):
 * `spawn(command, [...args, '-p', ...claudeArgs])`. The launcher registers tsx and runs src/cli.ts.
 */
export function simCommand(): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [fileURLToPath(new URL('../bin/claude-sim.mjs', import.meta.url))],
  };
}
