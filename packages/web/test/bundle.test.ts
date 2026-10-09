import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const WEB = resolve(__dirname, '..');
const out = mkdtempSync(join(tmpdir(), 'aoc-web-bundle-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe('production bundle', () => {
  // @aoc/contracts builds its zod event schemas when it is imported; pages that import a label from it as a value
  // (the §6 assurance labels) must not pull them into the browser bundle. vite.config.ts marks the package's sources
  // as free of side effects so only the modules whose exports are used ship. Built in a child process like
  // scripts/build.mjs does: esbuild does not run inside the jsdom environment.
  it(
    'ships the contracts labels the UI imports as values without the package zod schemas',
    { timeout: 120_000 },
    () => {
      const vite = join(dirname(createRequire(join(WEB, 'package.json')).resolve('vite/package.json')), 'bin', 'vite.js');
      const build = spawnSync(
        process.execPath,
        [vite, 'build', '--logLevel', 'error', '--outDir', out, '--emptyOutDir'],
        // vitest sets NODE_ENV=test, which would build React's development JSX into the bundle.
        { cwd: WEB, encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } },
      );
      expect(build.stderr, build.stdout).toBe('');
      expect(build.status).toBe(0);

      const assets = join(out, 'assets');
      const bundle = readdirSync(assets)
        .filter((f) => f.endsWith('.js'))
        .map((f) => readFileSync(join(assets, f), 'utf8'))
        .join('\n');
      expect(bundle).toContain('Attribution (bearer token)');
      // zod's issue codes are string literals that survive minification; nothing in the UI uses zod itself.
      expect(bundle).not.toContain('invalid_type');
    },
  );
});
