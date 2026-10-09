import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { runCli } from '../../src/cli';
import type { CliDeps } from '../../src/deps';

/** Fixed "now" for deterministic ages. */
export const NOW = Date.parse('2026-10-09T10:00:00.000Z');
export const TOKEN = 'aoc_u_test_token_0123456789';

export function tempDir(prefix = 'aoc-cli-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Deps with no real process access: spawn throws, git reports "not a repo", env is empty (never the real shell's). */
export function testDeps(over: Partial<CliDeps> = {}): CliDeps {
  return {
    stdout: () => {},
    stderr: () => {},
    env: {},
    homeDir: tempDir('aoc-home-'),
    cwd: tempDir('aoc-cwd-'),
    fetch: globalThis.fetch,
    now: () => NOW,
    sleep: async () => {},
    readStdin: async () => {
      throw new Error('stdin not expected');
    },
    spawn: vi.fn(() => {
      throw new Error('spawn not expected');
    }),
    git: vi.fn(() => ({ code: 128, stdout: '' })),
    argv1: '/nonexistent/aoc/aoc.mjs',
    execPath: process.execPath,
    platform: 'linux',
    signals: new EventEmitter(),
    ...over,
  };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  deps: CliDeps;
}

export async function aoc(argv: string[], over: Partial<CliDeps> = {}): Promise<RunResult> {
  let stdout = '';
  let stderr = '';
  const deps = testDeps({ ...over, stdout: (s) => void (stdout += s), stderr: (s) => void (stderr += s) });
  const code = await runCli(argv, deps);
  return { code, stdout, stderr, deps };
}

/** Write ~/.aoc/client.json as `aoc login` would. */
export function writeClientConfig(homeDir: string, cfg: Record<string, unknown>): string {
  mkdirSync(join(homeDir, '.aoc'), { recursive: true });
  const path = join(homeDir, '.aoc', 'client.json');
  writeFileSync(path, JSON.stringify(cfg), { mode: 0o600 });
  return path;
}

/** A logged-in home directory pointing at `daemonUrl`. */
export function loggedInHome(daemonUrl: string): string {
  const home = tempDir('aoc-home-');
  writeClientConfig(home, { daemonUrl, token: TOKEN });
  return home;
}
