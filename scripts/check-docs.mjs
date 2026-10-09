#!/usr/bin/env node
// Checks the documentation (README.md, packages/demo/README.md, docs/**) against itself and the code. No dependencies.
//   - every relative link points at a file that exists, and every #anchor at a heading of that file;
//   - traceability.md: each `path` exists, each :line is inside its file, each quoted test title is in its test file,
//     and the summary table equals the counts of the rows;
//   - gaps.md: the summary table equals the counts of the tables;
//   - G-, P-, O-, T-, F-, R-, W3-, W4- references name a row that exists; commit hashes in backticks exist.
// Usage: node scripts/check-docs.mjs      (exit 1 when anything is wrong; run from anywhere)
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const problem = (file, msg) => problems.push(`${relative(ROOT, file)}: ${msg}`);
const read = (p) => readFileSync(p, 'utf8');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'fixtures') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}
const docs = [join(ROOT, 'README.md'), join(ROOT, 'packages/demo/README.md'), ...walk(join(ROOT, 'docs'))].filter(existsSync);

/** Markdown without fenced code blocks (their lines blanked, so line numbers survive). */
const unfenced = (text) => {
  let fenced = false;
  return text
    .split('\n')
    .map((l) => {
      if (/^\s*```/.test(l)) fenced = !fenced;
      return fenced || /^\s*```/.test(l) ? '' : l;
    })
    .join('\n');
};

// ── links and anchors ───────────────────────────────────────────────────────
const slug = (heading) =>
  heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
const anchorCache = new Map();
function anchorsOf(file) {
  if (!anchorCache.has(file)) {
    const seen = new Map();
    const set = new Set();
    for (const l of unfenced(read(file)).split('\n')) {
      const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(l);
      if (!m) continue;
      const base = slug(m[1]);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      set.add(n ? `${base}-${n}` : base);
    }
    anchorCache.set(file, set);
  }
  return anchorCache.get(file);
}
let links = 0;
for (const file of docs) {
  const text = unfenced(read(file)).replace(/`[^`\n]*`/g, '``');
  for (const m of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)[^)]*\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|data:)/.test(target)) continue;
    links++;
    const [pathPart, anchor] = target.split('#');
    const dest = pathPart ? resolve(dirname(file), decodeURIComponent(pathPart)) : file;
    if (!existsSync(dest)) {
      problem(file, `broken link ${target}`);
      continue;
    }
    if (anchor && dest.endsWith('.md') && !anchorsOf(dest).has(decodeURIComponent(anchor)))
      problem(file, `no heading for ${target}`);
  }
}

// ── traceability ────────────────────────────────────────────────────────────
const norm = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\\'/g, "'").replace(/\s+/g, ' ');
const fileCache = new Map();
const fileText = (p) => (fileCache.has(p) ? fileCache.get(p) : fileCache.set(p, norm(read(p))).get(p));
const traceFile = join(ROOT, 'docs/compliance/traceability.md');
const SECTIONS = new Map();
const STATUS = ['Built', 'Partial', 'Missing', 'Process: done', 'Process: open'];
let rows = 0;
let refs = 0;
let titles = 0;
if (existsSync(traceFile)) {
  for (const row of read(traceFile).split('\n').filter((l) => /^\| (S\d|UI-|R\d)/.test(l))) {
    rows++;
    const cells = row.split(/ \| /).map((c) => c.trim().replace(/^\|\s*/, ''));
    const id = cells[0];
    const sec = /^S(\d+)/.exec(id)?.[1] ?? (id.startsWith('UI-') ? '12' : '16');
    const status = cells[2];
    if (!STATUS.includes(status)) problem(traceFile, `${id}: unknown status "${status}"`);
    const c = SECTIONS.get(sec) ?? Object.fromEntries(STATUS.map((s) => [s, 0]));
    c[status]++;
    SECTIONS.set(sec, c);
    for (const m of (cells[3] ?? '').matchAll(/`((?:packages|config|docs|scripts|mocks|\.github)\/[^`:\s]+?)(?::([\d,-]+))?`/g)) {
      refs++;
      const p = join(ROOT, m[1]);
      if (!existsSync(p)) {
        problem(traceFile, `${id}: missing path ${m[1]}`);
        continue;
      }
      if (m[2] && statSync(p).isFile()) {
        const n = read(p).split('\n').length;
        for (const part of m[2].split(',')) if (Number(part.split('-').pop()) > n) problem(traceFile, `${id}: ${m[1]}:${part} is beyond the end of the file (${n} lines)`);
      }
    }
    for (const m of (cells[4] ?? '').matchAll(/`(packages\/[^`]+?\.test\.tsx?)`((?:\s*(?:\(block\s*)?›?\s*"(?:[^"\\]|\\.)*"\)?[,;]?\s*(?:and\s*)?)*)/g)) {
      const p = join(ROOT, m[1]);
      if (!existsSync(p)) {
        problem(traceFile, `${id}: missing test file ${m[1]}`);
        continue;
      }
      for (const t of m[2].matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        titles++;
        const title = norm(t[1].replace(/\\"/g, '"'));
        for (const part of title.split('…').map((s) => s.trim()).filter(Boolean))
          if (!fileText(p).includes(part)) problem(traceFile, `${id}: no test titled "${part.slice(0, 80)}" in ${m[1]}`);
      }
    }
  }
  const header = read(traceFile).split('\n').filter((l) => /^\| §\d+ /.test(l));
  const total = Object.fromEntries(STATUS.map((s) => [s, 0]));
  for (const l of header) {
    const cells = l.split('|').map((c) => c.trim());
    const sec = /§(\d+)/.exec(cells[1])[1];
    const want = SECTIONS.get(sec) ?? Object.fromEntries(STATUS.map((s) => [s, 0]));
    const got = cells.slice(2, 8).map(Number);
    const exp = [...STATUS.map((s) => want[s]), STATUS.reduce((a, s) => a + want[s], 0)];
    // The summary lists Built, Partial, Missing, Process: done, Process: open, Total.
    if (got.join() !== exp.join()) problem(traceFile, `summary row ${cells[1]} says ${got.join('/')} but the rows give ${exp.join('/')}`);
    for (const s of STATUS) total[s] += want[s];
  }
  const sum = /^\| \*\*Total\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \|/m.exec(read(traceFile));
  if (!sum || sum.slice(1).map(Number).join() !== [...STATUS.map((s) => total[s]), rows].join())
    problem(traceFile, `the Total row does not match the ${rows} rows (${STATUS.map((s) => `${s} ${total[s]}`).join(', ')})`);
}

// ── gaps ────────────────────────────────────────────────────────────────────
const gapsFile = join(ROOT, 'docs/compliance/gaps.md');
const ids = { G: new Set(), P: new Set(), O: new Set(), T: new Set(), F: new Set(), R: new Set(), W3: new Set(), W4: new Set() };
if (existsSync(gapsFile)) {
  const lines = read(gapsFile).split('\n');
  const between = (from, to) => {
    const a = lines.findIndex((l) => l.startsWith(from));
    const b = to ? lines.findIndex((l, i) => i > a && l.startsWith(to)) : lines.length;
    return a < 0 ? [] : lines.slice(a + 1, b < 0 ? lines.length : b);
  };
  const tableRows = (ls, re) => ls.filter((l) => re.test(l));
  for (const l of lines) {
    const m = /^\| (G|P)-(\d+) \|/.exec(l);
    if (m) ids[m[1]].add(`${m[1]}-${m[2]}`);
  }
  const procRows = tableRows(lines, /^\| P-\d+ \|/);
  const counts = {
    'Open software gaps, P0': tableRows(between('### P0', '### P1'), /^\| G-/).length,
    'Open software gaps, P1': tableRows(between('### P1', '### P2'), /^\| G-/).length,
    'Open software gaps, P2': tableRows(between('### P2', '## '), /^\| G-/).length,
    'Residual risks of closed gaps': between('## Residual risks', '## Process').filter((l) => /^\| /.test(l) && !/^\| (Residual risk|---)/.test(l)).length,
    'Process items not yet done': procRows.filter((l) => !/^\*{0,2}Done\b/.test(l.split(' | ').pop() ?? '')).length,
    'Process items done': procRows.filter((l) => /^\*{0,2}Done\b/.test(l.split(' | ').pop() ?? '')).length,
    'Software gaps resolved since': tableRows(between('## Resolved since', '## Resolved before'), /^\| G-/).length,
    'Software gaps resolved before': tableRows(between('## Resolved before', null), /^\| G-/).length,
  };
  for (const l of between('## Summary', '## Open')) {
    const m = /^\| (.+?) \| (\d+) \|/.exec(l);
    if (!m) continue;
    const key = Object.keys(counts).find((k) => m[1].replace(/ `[0-9a-f]+`$/, '').startsWith(k));
    if (key && counts[key] !== Number(m[2])) problem(gapsFile, `summary says ${m[2]} for "${m[1]}" but the tables hold ${counts[key]}`);
  }
}
const modelFile = join(ROOT, 'docs/security/threat-model.md');
if (existsSync(modelFile)) {
  for (const m of read(modelFile).matchAll(/^\| O-(\d+) \|/gm)) ids.O.add(`O-${m[1]}`);
  for (const m of read(modelFile).matchAll(/^### T-(\d+)\./gm)) ids.T.add(`T-${m[1]}`);
}
for (let i = 1; i <= 18; i++) ids.F.add(`F-${String(i).padStart(2, '0')}`);
for (let i = 1; i <= 13; i++) ids.R.add(`R-${String(i).padStart(2, '0')}`);
ids.W3.add('W3-01');
for (let i = 1; i <= 13; i++) ids.W4.add(`W4-${String(i).padStart(2, '0')}`);

let idRefs = 0;
for (const file of docs) {
  if (/docs\/(spec|research)\//.test(file)) continue;
  const text = unfenced(read(file));
  for (const m of text.matchAll(/\b(G|P|O|T|F|R|W3|W4)-(\d{1,3})\b/g)) {
    const id = `${m[1]}-${m[1] === 'W3' || m[1] === 'W4' || m[1] === 'F' || m[1] === 'R' ? m[2].padStart(2, '0') : m[2]}`;
    idRefs++;
    if (!ids[m[1]].has(id)) problem(file, `${m[0]} is not defined anywhere`);
  }
}

// ── commits ─────────────────────────────────────────────────────────────────
const commitCache = new Map();
const commitExists = (h) => {
  if (!commitCache.has(h)) {
    try {
      execFileSync('git', ['-C', ROOT, 'cat-file', '-e', `${h}^{commit}`], { stdio: 'ignore' });
      commitCache.set(h, true);
    } catch {
      commitCache.set(h, false);
    }
  }
  return commitCache.get(h);
};
let commits = 0;
for (const file of docs) {
  if (/docs\/(spec|research)\//.test(file)) continue;
  for (const m of unfenced(read(file)).matchAll(/`([0-9a-f]{7,12})`/g)) {
    if (!/[a-f]/.test(m[1]) || !/\d/.test(m[1]) || /^0+$/.test(m[1])) continue;
    commits++;
    if (!commitExists(m[1])) problem(file, `commit ${m[1]} does not exist in this repository`);
  }
}

console.log(`checked ${docs.length} documents: ${links} links, ${rows} traceability rows (${refs} code references, ${titles} test titles), ${idRefs} gap/process/threat/review ids, ${commits} commit hashes`);
if (problems.length) {
  console.error(`${problems.length} problem(s):\n${problems.map((p) => `  ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('ok');
