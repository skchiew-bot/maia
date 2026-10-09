#!/usr/bin/env node
// Packaging smoke test: builds the bundles (without the web UI), copies dist/ outside the checkout (so nothing can
// fall back to the sources) and runs each bundle from there. Usage: node scripts/smoke-dist.mjs [--no-build].
// Exits non-zero on the first failed check.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'aoc-smoke-'));
const dist = join(tmp, 'install');
const bin = (name) => join(dist, 'bin', `${name}.mjs`);
const BUNDLES = ['aoc', 'aocd', 'aoc-hook', 'aoc-mcp', 'aoc-sidecar'];
/** Only what a fresh shell would have: no AOC_* (or other) settings leak in from the caller. */
const cleanEnv = { PATH: process.env.PATH ?? '', HOME: tmp, LANG: 'C.UTF-8' };

let checks = 0;
let daemon = null;
function check(what, ok, detail = '') {
  if (!ok) {
    console.error(`FAIL ${what}${detail ? `\n${detail}` : ''}`);
    if (daemon && daemon.exitCode === null) daemon.kill('SIGKILL');
    rmSync(tmp, { recursive: true, force: true });
    process.exit(1);
  }
  checks++;
  console.log(`ok   ${what}`);
}

function run(args, o = {}) {
  const r = spawnSync(process.execPath, args, {
    cwd: tmp,
    env: { ...cleanEnv, ...o.env },
    input: o.input ?? '',
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const show = (r) => `exit ${r.code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`;

if (!process.argv.includes('--no-build')) {
  const b = spawnSync(process.execPath, [join(root, 'scripts', 'build.mjs'), '--no-web'], {
    cwd: root,
    stdio: 'inherit',
  });
  check('pnpm build (bundles)', b.status === 0, `build exited ${b.status}`);
}
cpSync(join(root, 'dist'), dist, { recursive: true });

for (const name of BUNDLES) {
  let executable = true;
  try {
    accessSync(bin(name), constants.X_OK);
  } catch {
    executable = false;
  }
  check(`dist/bin/${name}.mjs is executable`, executable);
}
for (const hook of ['pre-push', 'prepare-commit-msg']) {
  let executable = true;
  try {
    accessSync(join(dist, 'git', hook), constants.X_OK);
  } catch {
    executable = false;
  }
  check(`dist/git/${hook} ships next to the bundles`, executable);
}
for (const file of ['process-types.json', 'rate-card.json', 'iso42001-mapping.json']) {
  let readable = true;
  try {
    accessSync(join(dist, 'config', file), constants.R_OK);
  } catch {
    readable = false;
  }
  check(`dist/config/${file}`, readable);
}

const help = run([bin('aoc'), '--help']);
check('aoc --help', help.code === 0 && help.stdout.includes('Usage: aoc'), show(help));
const version = run([bin('aoc'), '--version']);
check('aoc --version', version.code === 0 && /^\d+\.\d+\.\d+/.test(version.stdout.trim()), show(version));
const dVersion = run([bin('aocd'), '--version']);
check(
  'aocd --version',
  dVersion.code === 0 && /^aocd \d+\.\d+\.\d+$/.test(dVersion.stdout.trim()),
  show(dVersion),
);
const dHelp = run([bin('aocd'), '--help']);
check('aocd --help', dHelp.code === 0 && dHelp.stdout.includes('Usage: aocd'), show(dHelp));

const hookInput = JSON.stringify({
  session_id: 's',
  transcript_path: '/none.jsonl',
  cwd: '/',
  hook_event_name: 'Stop',
});
const hook = run([bin('aoc-hook'), 'Stop'], { input: hookInput, env: { AOC_INTERNAL_LLM: '1' } });
check(
  'aoc-hook stands down for internal LLM calls',
  hook.code === 0 && !hook.stdout && !hook.stderr,
  show(hook),
);
const sidecar = run([bin('aoc-sidecar')]);
check(
  'aoc-sidecar prints its usage',
  sidecar.code === 2 && sidecar.stderr.includes('usage: aoc-sidecar'),
  show(sidecar),
);
const mcp = run([bin('aoc-mcp')]);
check(
  'aoc-mcp refuses to start unauthenticated',
  mcp.code === 1 && mcp.stderr.includes('refusing to start'),
  show(mcp),
);
const push = spawnSync('sh', [join(dist, 'git', 'pre-push'), 'origin', 'url'], {
  input: 'refs/heads/fix abc refs/heads/main def\n',
  env: cleanEnv,
  encoding: 'utf8',
});
check(
  'dist/git/pre-push refuses a protected branch',
  push.status === 1,
  `exit ${push.status}: ${push.stderr}`,
);

// aocd from the copied bundle: listens, answers /api/health, finds its helpers and default data files next to it
// (there is no source checkout to fall back to), stops cleanly on SIGTERM.
daemon = spawn(process.execPath, [bin('aocd')], {
  cwd: tmp,
  env: {
    ...cleanEnv,
    AOC_HOST: '127.0.0.1',
    AOC_PORT: '0',
    AOC_DATA_DIR: join(tmp, 'data'),
    AOC_LOG_LEVEL: 'debug',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
let err = '';
daemon.stdout.on('data', (d) => (out += d));
daemon.stderr.on('data', (d) => (err += d));
const exited = new Promise((resolve) => daemon.on('exit', (code) => resolve(code)));
const url = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), 20_000);
  daemon.stdout.on('data', () => {
    const m = out.match(/aocd listening on (http:\/\/\S+)/);
    if (m) {
      clearTimeout(timer);
      resolve(m[1]);
    }
  });
  void exited.then(() => resolve(null));
});
check('aocd starts from dist/bin', url !== null, `stdout: ${out}\nstderr: ${err}`);
const health = await fetch(`${url}/api/health`)
  .then(async (r) => ({ ok: r.ok, body: await r.json() }))
  .catch((e) => ({ ok: false, body: String(e) }));
check(
  'aocd serves /api/health',
  health.ok && Array.isArray(health.body.modules) && health.body.modules.at(-1) === 'aocd',
  JSON.stringify(health.body),
);
check('aocd resolved its helper bundles', !/supervisor\.(hook|mcp|sidecar)Command/.test(err), err);
check(
  'aocd loads the ISO 42001 mapping packaged next to it, and says so',
  out.includes(`  mapping  ${join(dist, 'config', 'iso42001-mapping.json')} (version `),
  out,
);
daemon.kill('SIGTERM');
check('aocd stops cleanly on SIGTERM', (await exited) === 0, `stderr: ${err}`);
check('aocd loads node:sqlite without the experimental warning', !err.includes('ExperimentalWarning'), err);
rmSync(tmp, { recursive: true, force: true });
console.log(`dist smoke: ${checks} checks passed`);
