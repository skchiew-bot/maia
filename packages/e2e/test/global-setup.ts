/**
 * Bundles the binaries under test once per run, the way scripts/build.mjs ships them (dist/bin/*.mjs, which aocd
 * prefers over source entries), into a temp dir. Every hook call, MCP server, sidecar and claude-sim turn then starts
 * a single plain-JS file instead of compiling TypeScript through tsx: about 7x cheaper per spawn, which keeps the
 * suite inside its time budget on a busy machine.
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import type { TestProject } from 'vitest/node';
import { BINARIES, REPO_ROOT } from './paths';

export default async function setup(project: TestProject): Promise<() => void> {
  const dir = mkdtempSync(join(tmpdir(), 'aoc-e2e-bin-'));
  await Promise.all(
    Object.entries(BINARIES).map(async ([name, entry]) => {
      const outfile = join(dir, `${name}.mjs`);
      await build({
        absWorkingDir: REPO_ROOT,
        entryPoints: [join(REPO_ROOT, entry)],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node22',
        external: ['node:*'],
        // As in scripts/build.mjs: bundled CommonJS dependencies call require().
        banner: { js: "import { createRequire as __aocCreateRequire } from 'node:module';\nconst require = __aocCreateRequire(import.meta.url);" },
        logLevel: 'warning',
      });
      chmodSync(outfile, 0o755);
    }),
  );
  project.provide('binDir', dir);
  return () => rmSync(dir, { recursive: true, force: true });
}

declare module 'vitest' {
  export interface ProvidedContext {
    binDir: string;
  }
}
