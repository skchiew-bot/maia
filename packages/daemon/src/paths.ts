import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Directory of the running daemon code: `packages/daemon/src` from source, `dist/bin` when bundled. */
export const moduleDir = dirname(fileURLToPath(import.meta.url));

/** Nearest ancestor holding pnpm-workspace.yaml (the source checkout), or null for a detached bundle. */
export function findRepoRoot(from: string): string | null {
  let dir = from;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * `--import` specifier for tsx. Resolved to an absolute file URL because helpers are spawned with the
 * session workspace as cwd, where a bare `tsx` would not resolve.
 */
export function resolveTsxImport(repoRoot: string): string {
  try {
    return pathToFileURL(createRequire(join(repoRoot, 'package.json')).resolve('tsx')).href;
  } catch {
    return 'tsx';
  }
}
