#!/usr/bin/env node
// Build the AOC binaries (esbuild → dist/bin/*.mjs), the web UI (vite → dist/web) and the packaged
// default data files (dist/config). Usage: node scripts/build.mjs [--no-web] [entry names…]
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const binDir = join(dist, 'bin');

const ENTRIES = [
  { name: 'aocd', entry: 'packages/daemon/src/main.ts' },
  { name: 'aoc', entry: 'packages/cli/src/main.ts' },
  { name: 'aoc-hook', entry: 'packages/hooks/src/main.ts' },
  { name: 'aoc-mcp', entry: 'packages/mcp-server/src/main.ts' },
  { name: 'aoc-sidecar', entry: 'packages/sidecar/src/main.ts' },
  { name: 'claude-sim', entry: 'packages/claude-sim/src/cli.ts' },
];

/**
 * node:sqlite emits an ExperimentalWarning when it loads. A static import is linked before any bundle
 * code runs, so aocd could not filter it; loading it with process.getBuiltinModule on first evaluation
 * lets the filter installed first in aocd's main.ts drop just that warning.
 */
const lazyNodeSqlite = {
  name: 'lazy-node-sqlite',
  setup(b) {
    b.onResolve({ filter: /^node:sqlite$/ }, () => ({ path: 'node:sqlite', namespace: 'aoc-lazy-builtin' }));
    b.onLoad({ filter: /.*/, namespace: 'aoc-lazy-builtin' }, () => ({
      loader: 'js',
      contents: [
        "const sqlite = process.getBuiltinModule('node:sqlite');",
        'export const DatabaseSync = sqlite.DatabaseSync;',
        'export const StatementSync = sqlite.StatementSync;',
        'export const constants = sqlite.constants;',
        'export const backup = sqlite.backup;',
        'export default sqlite;',
      ].join('\n'),
    }));
  },
};

function banner(entryFile) {
  // esbuild keeps an entry's own hashbang; a second one would be a syntax error.
  const hasHashbang = readFileSync(entryFile, 'utf8').startsWith('#!');
  return [
    ...(hasHashbang ? [] : ['#!/usr/bin/env node']),
    "import { createRequire as __aocCreateRequire } from 'node:module';",
    'const require = __aocCreateRequire(import.meta.url);',
  ].join('\n');
}

async function bundle({ name, entry }) {
  const entryFile = join(root, entry);
  const outfile = join(binDir, `${name}.mjs`);
  rmSync(outfile, { force: true });
  rmSync(`${outfile}.map`, { force: true });
  if (!existsSync(entryFile)) {
    console.warn(`warning: skipped ${name}: ${entry} does not exist yet`);
    return null;
  }
  await build({
    absWorkingDir: root,
    entryPoints: [entryFile],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['node:*'],
    banner: { js: banner(entryFile) },
    minify: false,
    sourcemap: 'linked',
    logLevel: 'warning',
    plugins: [lazyNodeSqlite],
  });
  chmodSync(outfile, 0o755);
  return outfile;
}

function buildWeb() {
  const webRoot = join(root, 'packages', 'web');
  const out = join(dist, 'web');
  rmSync(out, { recursive: true, force: true });
  if (!existsSync(join(webRoot, 'index.html'))) {
    console.warn('warning: skipped web: packages/web/index.html does not exist yet');
    return null;
  }
  const vite = join(
    dirname(createRequire(join(webRoot, 'package.json')).resolve('vite/package.json')),
    'bin',
    'vite.js',
  );
  const r = spawnSync(process.execPath, [vite, 'build'], { cwd: webRoot, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`vite build failed (${r.signal ?? `exit ${r.status}`})`);
  cpSync(join(webRoot, 'dist'), out, { recursive: true });
  return out;
}

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    files++;
    bytes += statSync(join(e.parentPath, e.name)).size;
  }
  return { files, bytes };
}

const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

function printSizes(bundles, web) {
  const rows = bundles.map((f) => [
    relative(root, f),
    kb(statSync(f).size),
    existsSync(`${f}.map`) ? kb(statSync(`${f}.map`).size) : '-',
  ]);
  if (web) {
    const s = dirStats(web);
    rows.push([`${relative(root, web)}/ (${s.files} files)`, kb(s.bytes), '']);
  }
  const header = ['output', 'size', 'sourcemap'];
  const width = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => `  ${r[0].padEnd(width[0])}  ${r[1].padStart(width[1])}  ${r[2].padStart(width[2])}`;
  console.log(['', line(header), ...rows.map(line), ''].join('\n'));
}

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const names = args.filter((a) => !a.startsWith('--'));
const badFlags = flags.filter((f) => f !== '--no-web');
const badNames = names.filter((n) => !ENTRIES.some((e) => e.name === n));
if (badFlags.length || badNames.length) {
  console.error(
    `unknown ${[...badFlags, ...badNames].join(', ')}\nusage: node scripts/build.mjs [--no-web] [${ENTRIES.map((e) => e.name).join('|')}…]`,
  );
  process.exit(2);
}

const selected = names.length ? ENTRIES.filter((e) => names.includes(e.name)) : ENTRIES;
const results = await Promise.allSettled(selected.map(bundle));
const built = results.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [selected[i].name] : []));
cpSync(join(root, 'config'), join(dist, 'config'), { recursive: true });

let web = null;
let webFailed = false;
if (!flags.includes('--no-web') && !names.length) {
  try {
    web = buildWeb();
  } catch (err) {
    console.error(`error: ${err.message}`);
    webFailed = true;
  }
}

printSizes(built, web);
if (failed.length || webFailed) {
  console.error(`build failed: ${[...failed, ...(webFailed ? ['web'] : [])].join(', ')}`);
  process.exit(1);
}
