import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const E2E_DIR = fileURLToPath(new URL('..', import.meta.url));
export const REPO_ROOT = resolve(E2E_DIR, '..', '..');

/** The real binary entries, run from source exactly as the supervisor does in a dev checkout. */
export const HOOK_MAIN = join(REPO_ROOT, 'packages', 'hooks', 'src', 'main.ts');
export const MCP_MAIN = join(REPO_ROOT, 'packages', 'mcp-server', 'src', 'main.ts');
export const SIDECAR_MAIN = join(REPO_ROOT, 'packages', 'sidecar', 'src', 'main.ts');

/** Absolute `--import` specifier: helpers run with a session workspace as cwd, where a bare `tsx` would not resolve. */
export const TSX_IMPORT = pathToFileURL(createRequire(join(REPO_ROOT, 'package.json')).resolve('tsx')).href;

export const tsNode = (entry: string, ...args: string[]): string[] => ['--import', TSX_IMPORT, entry, ...args];
