import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const E2E_DIR = fileURLToPath(new URL('..', import.meta.url));
export const REPO_ROOT = resolve(E2E_DIR, '..', '..');

/** The real binaries under test (bundled by global-setup.ts): name → source entry. */
export const BINARIES = {
  'aoc-hook': 'packages/hooks/src/main.ts',
  'aoc-mcp': 'packages/mcp-server/src/main.ts',
  'aoc-sidecar': 'packages/sidecar/src/main.ts',
  'claude-sim': 'packages/claude-sim/src/cli.ts',
} as const;
