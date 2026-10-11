/**
 * Credential isolation for every CLI command (§3, R1): no command can create a process or read a secret
 * from the shell environment. Statically: no command's module graph imports child_process, reaches
 * src/deps.ts (the one module that spawns and reads process.env, injected only by main.ts) or touches
 * process.env. Dynamically: each command reads only AOC's own variables from the injected env, and planted
 * secrets never reach the daemon, the terminal or a file.
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command, Option } from 'commander';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AOC_ENV } from '@aoc/contracts';
import { buildProgram } from '../src/cli';
import { ENV_DAEMON_URL, ENV_TOKEN } from '../src/config';
import { CommandContext } from '../src/context';
import { DEPLOY_SECRET_ENV_PATTERNS } from '../src/doctor';
import { aoc, tempDir, testDeps, TOKEN } from './helpers/cli';
import { startFakeDaemon, type FakeDaemon } from './helpers/fake-daemon';

const cp = vi.hoisted(() => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  exec: vi.fn(),
  execSync: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  fork: vi.fn(),
}));
vi.mock('node:child_process', () => ({ ...cp, default: cp }));

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const PACKAGES = resolve(SRC, '../..');
const DEPS = join(SRC, 'deps.ts');
const COMMAND_FILES = readdirSync(join(SRC, 'commands'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => join(SRC, 'commands', f));
const rel = (file: string) => relative(PACKAGES, file);

// ── static: module graphs ────────────────────────────────────────────────────
/** Import specifiers that load code: static and re-export `from`, side-effect and dynamic imports (type-only skipped). */
function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const specs: string[] = [];
  for (const m of src.matchAll(/^(?:import|export)\s+(type\s+)?[^;]*?\sfrom\s+['"]([^'"]+)['"]/gm))
    if (!m[1]) specs.push(m[2]!);
  for (const m of src.matchAll(/^import\s+['"]([^'"]+)['"]/gm)) specs.push(m[1]!);
  for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]!);
  return specs;
}

/** A workspace package's TS entry (package.json "exports" point at source). */
function workspaceEntry(spec: string): string | null {
  const name = /^@aoc\/([^/]+)$/.exec(spec)?.[1];
  if (!name) return null;
  const dir = join(PACKAGES, name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    exports?: string | Record<string, string>;
  };
  const entry = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.'];
  return entry ? resolve(dir, entry) : null;
}

/** Every source file a module loads, following relative imports and @aoc/* workspace packages. */
function moduleGraph(entry: string): { files: Set<string>; external: Set<string> } {
  const files = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of importsOf(file)) {
      if (spec.startsWith('.')) {
        const base = resolve(dirname(file), spec);
        const target = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), base].find(
          (p) => /\.tsx?$/.test(p) && existsSync(p),
        );
        if (target) queue.push(target);
      } else {
        const ws = workspaceEntry(spec);
        if (ws) queue.push(ws);
        else external.add(spec);
      }
    }
  }
  return { files, external };
}

const SPAWNING_MODULES = /^(node:)?(child_process|cluster)$/;
const READS_PROCESS_ENV = /\bprocess\s*(?:\.\s*env\b|\[\s*['"]env['"]\s*\])/;

describe('no command can reach process creation or the shell environment (static)', () => {
  it('covers every command module and finds the deps boundary', () => {
    expect(COMMAND_FILES.map(rel)).toEqual(
      expect.arrayContaining(
        [
          'audit',
          'auth',
          'decisions',
          'doctor',
          'hooks',
          'projects',
          'run',
          'serve',
          'sessions',
          'users',
        ].map((c) => `cli/src/commands/${c}.ts`),
      ),
    );
    // The boundary itself is what the checks below keep out of reach.
    expect(importsOf(DEPS)).toContain('node:child_process');
    expect(readFileSync(DEPS, 'utf8')).toMatch(READS_PROCESS_ENV);
  });

  it.each(COMMAND_FILES.map((f) => [rel(f), f]))('%s', (_name, file) => {
    const { files, external } = moduleGraph(file);
    expect(files.size).toBeGreaterThan(1);
    expect([...external].filter((s) => SPAWNING_MODULES.test(s))).toEqual([]);
    expect([...files].map(rel)).not.toContain(rel(DEPS));
    expect([...files].filter((f) => READS_PROCESS_ENV.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([]);
  });

  it('the whole program (cli.ts) defines commands only in checked modules, never as executable subcommands', () => {
    const { files, external } = moduleGraph(join(SRC, 'cli.ts'));
    expect([...files]).toEqual(expect.arrayContaining(COMMAND_FILES));
    expect([...files].map(rel)).not.toContain(rel(DEPS));
    expect([...external].filter((s) => SPAWNING_MODULES.test(s))).toEqual([]);
    // Workspace code is followed too (e.g. @aoc/client reads the client config for every command).
    expect([...files].map(rel)).toEqual(
      expect.arrayContaining(['contracts/src/index.ts', 'client/src/index.ts']),
    );
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(READS_PROCESS_ENV.test(src), rel(f)).toBe(false);
      if (/\.command\(/.test(src)) expect(COMMAND_FILES, rel(f)).toContain(f);
      // commander spawns a separate executable for `.command(name, description)` and executableDir().
      expect(src, rel(f)).not.toMatch(/\.command\(\s*['"][^'"]*['"]\s*,\s*['"]|\.executableDir\(/);
    }
  });
});

// ── dynamic: every leaf command against a canary environment ─────────────────
/** Secrets a developer shell may hold: none may be read (outside doctor's names-only check) or leave the CLI. */
const CANARIES: Record<string, string> = {
  GITHUB_TOKEN: 'canary-github-0001',
  GH_TOKEN: 'canary-gh-0002',
  AWS_ACCESS_KEY_ID: 'canary-aws-id-0003',
  AWS_SECRET_ACCESS_KEY: 'canary-aws-secret-0004',
  PROD_DEPLOY_KEY: 'canary-deploy-0005',
  NPM_TOKEN: 'canary-npm-0006',
  ANTHROPIC_API_KEY: 'canary-anthropic-0007',
  AOC_MASTER_KEY: 'canary-kek-0008',
  AOC_INGEST_TOKEN: 'canary-ingest-0009',
  DATABASE_URL: 'postgres://canary-db-0010',
  SSH_AUTH_SOCK: '/tmp/canary-ssh-agent-0011',
};
/** The only variables a command may read. */
const ALLOWED_READS = new Set([
  AOC_ENV.sessionId,
  ENV_DAEMON_URL,
  ENV_TOKEN,
  'CLAUDE_CONFIG_DIR',
  'HOME',
  'XDG_CONFIG_HOME',
]);
const deployPattern = (name: string) =>
  DEPLOY_SECRET_ENV_PATTERNS.some((p) =>
    new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i').test(name),
  );

/** Arguments that take a command past its own validation (values only need to be well-formed). */
const EXTRA_ARGS: Record<string, string[]> = {
  login: ['--token', TOKEN],
  'hooks install-observed': ['--command', 'node /opt/aoc/aoc-hook.mjs'],
};
const OPTION_VALUES: Record<string, string> = { '--from': '2026-10-01', '--to': '2026-10-02' };
const ARG_VALUES: Record<string, string> = { seq: '1' };

interface Leaf {
  path: string[];
  argv: string[];
}

function leaves(cmd: Command, path: string[] = []): Leaf[] {
  if (cmd.commands.length) return cmd.commands.flatMap((c) => leaves(c, [...path, c.name()]));
  const args = cmd.registeredArguments.filter((a) => a.required).map((a) => ARG_VALUES[a.name()] ?? `x-${a.name()}`);
  const opts = (cmd.options as readonly Option[])
    .filter((o) => o.mandatory)
    .flatMap((o) => [o.long!, o.argChoices?.[0] ?? OPTION_VALUES[o.long!] ?? 'x-value']);
  return [{ path, argv: [...path, ...args, ...opts, ...(EXTRA_ARGS[path.join(' ')] ?? [])] }];
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

const LEAVES = leaves(buildProgram(new CommandContext(testDeps())));

describe('every command reads only AOC variables and never leaks a planted secret (dynamic)', () => {
  let d: FakeDaemon;
  beforeAll(async () => {
    d = await startFakeDaemon();
    d.on('GET', '/api/auth/me', {
      json: { user: { id: 'usr_dev', name: 'Dev', role: 'builder', flags: {}, email: null, active: true } },
    });
  });
  const made: string[] = [];
  afterAll(async () => {
    await d.stop();
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('enumerates every leaf command', () => {
    expect(LEAVES.map((l) => l.path.join(' '))).toEqual(
      expect.arrayContaining(['run', 'serve', 'doctor', 'login', 'decide', 'hooks install-observed']),
    );
    expect(LEAVES.length).toBeGreaterThanOrEqual(25);
  });

  it.each(LEAVES.map((l) => [l.path.join(' '), l]))('aoc %s', async (name, leaf) => {
    const reads = new Set<string>();
    let enumerated = false;
    const env = new Proxy<Record<string, string | undefined>>(
      { ...CANARIES, [ENV_DAEMON_URL]: d.url, [ENV_TOKEN]: TOKEN },
      {
        get(target, key) {
          if (typeof key === 'string') reads.add(key);
          return Reflect.get(target, key);
        },
        has(target, key) {
          if (typeof key === 'string') reads.add(key);
          return Reflect.has(target, key);
        },
        ownKeys(target) {
          enumerated = true;
          return Reflect.ownKeys(target);
        },
      },
    );
    const homeDir = tempDir('aoc-iso-home-');
    const cwd = tempDir('aoc-iso-cwd-');
    made.push(homeDir, cwd);
    const before = d.requests.length;
    for (const fn of Object.values(cp)) fn.mockClear();

    const r = await aoc(leaf.argv, { env, homeDir, cwd, readStdin: async () => '' });
    // The command's own action ran (a usage error would make every check below vacuous): extend EXTRA_ARGS.
    expect(r.code, r.stderr).not.toBe(2);

    const doctor = name === 'doctor';
    const unexpected = [...reads].filter((k) => !ALLOWED_READS.has(k) && !(doctor && deployPattern(k)));
    expect(unexpected, 'env variables read').toEqual([]);
    expect(enumerated, 'env enumerated').toBe(doctor); // doctor lists variable names, never values
    for (const fn of Object.values(cp)) expect(fn).not.toHaveBeenCalled();
    expect(r.deps.spawn).not.toHaveBeenCalled();
    if (!doctor) expect(r.deps.git).not.toHaveBeenCalled();

    const sent = JSON.stringify(d.requests.slice(before));
    const written = [...filesUnder(homeDir), ...filesUnder(cwd)]
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    for (const value of Object.values(CANARIES)) {
      expect(sent, `${value} sent to the daemon`).not.toContain(value);
      expect(r.stdout + r.stderr, `${value} printed`).not.toContain(value);
      expect(written, `${value} written to a file`).not.toContain(value);
    }
  });
});
