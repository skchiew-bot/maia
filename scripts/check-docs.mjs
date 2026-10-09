#!/usr/bin/env node
/*
 * Keeps the compliance docs honest against the code (see "Lessons" in CLAUDE.md). Fails when:
 *  1. a gap id has two rows in the open tables of docs/compliance/gaps.md;
 *  2. a gap has a commit whose subject starts with "G-nn:" yet is listed open with no row in a Resolved table and
 *     its open row names none of those commits (it closed in code but the list still says open; a commit that only
 *     narrows a gap is acknowledged by citing its short hash in the open row);
 *  3. a test cited as `path` › "title" in gaps.md or traceability.md does not exist, or the file has no such title;
 *  4. a repo path cited in backticks in those files does not exist.
 * Usage: node scripts/check-docs.mjs   (exit 1 on any finding)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const GAPS = 'docs/compliance/gaps.md';
const TRACE = 'docs/compliance/traceability.md';
const problems = [];
const read = (p) => readFileSync(join(root, p), 'utf8');

// ── 1 and 2: open vs resolved gap rows ────────────────────────────────────────────────────────────────────────────
const gaps = read(GAPS);
const resolved = new Set();
const open = new Map();
const openText = new Map();
let section = '';
for (const line of gaps.split('\n')) {
  if (line.startsWith('## ')) section = line;
  const m = /^\| (G-\d+(?: \/ G-\d+)*) \|/.exec(line);
  if (!m) continue;
  const ids = m[1].split(' / ');
  if (section.startsWith('## Resolved')) ids.forEach((id) => resolved.add(id));
  else
    for (const id of ids) {
      open.set(id, (open.get(id) ?? 0) + 1);
      openText.set(id, (openText.get(id) ?? '') + line);
    }
}
for (const [id, n] of open) if (n > 1) problems.push(`${GAPS}: ${id} has ${n} open rows`);

let subjects = [];
try {
  subjects = execFileSync('git', ['log', '--format=%h %s'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n');
  if (execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: root, encoding: 'utf8' }).trim() === 'true')
    console.warn('check-docs: shallow clone, commit history check is partial');
} catch {
  console.warn('check-docs: no git history, commit history check skipped');
}
const commits = new Map();
for (const s of subjects) {
  const m = /^(\w+) (G-\d+):/.exec(s);
  if (m) commits.set(m[2], [...(commits.get(m[2]) ?? []), m[1]]);
}
for (const id of open.keys())
  if (commits.has(id) && !resolved.has(id) && !commits.get(id).some((sha) => openText.get(id).includes(sha)))
    problems.push(
      `${GAPS}: ${id} has a "${id}:" commit but no Resolved row; move it there (or narrow it to what remains, with a Resolved row for what closed)`,
    );

// ── 3 and 4: cited tests and paths ────────────────────────────────────────────────────────────────────────────────
const norm = (s) => s.replace(/[’‘]/g, "'").replace(/\\(.)/g, '$1');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * A cited title may wrap across lines, abbreviate with "…" and name its describe blocks as "outer › inner"; an
 * `it.each` title is matched against its `%s` / `%d` template.
 */
const titleFound = (source, title) =>
  norm(title)
    .replace(/\s+/g, ' ')
    .split(/…| › /)
    .map((part) => part.trim())
    .filter(Boolean)
    .every(
      (part) =>
        source.includes(part) ||
        [...source.matchAll(/'([^'\n]*%[sdi][^'\n]*)'/g)].some((t) =>
          new RegExp('^' + t[1].split(/%[sdi]/).map(escapeRe).join('.+') + '$').test(part),
        ),
    );
for (const doc of [GAPS, TRACE]) {
  const text = read(doc);
  for (const m of text.matchAll(/`((?:packages|docs|scripts)\/[^`\s:]+?)(?::[\d,-]+)?`/g)) {
    const path = m[1].replace(/[),.;]+$/, '');
    if (path.includes('*') || path.includes('<')) continue;
    if (!existsSync(join(root, path))) problems.push(`${doc}: cited path does not exist: ${path}`);
  }
  // `file` › "title", › "title" … — every title after a test file, until the next backticked path.
  const quoted = '"(?:[^"\\\\]|\\\\.)+"';
  const cite = new RegExp('`(packages/[^`\\s]+?\\.test\\.tsx?)`((?:\\s*,?\\s*›\\s*' + quoted + ')+)', 'g');
  for (const m of text.matchAll(cite)) {
    const file = join(root, m[1]);
    if (!existsSync(file)) continue;
    const source = norm(readFileSync(file, 'utf8'));
    for (const t of m[2].matchAll(new RegExp('›\\s*(' + quoted + ')', 'g'))) {
      const title = t[1].slice(1, -1);
      if (!titleFound(source, title)) problems.push(`${doc}: no test titled "${title.replace(/\s+/g, ' ')}" in ${m[1]}`);
    }
  }
}

if (problems.length) {
  console.error(`check-docs: ${problems.length} problem(s)\n` + problems.map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('check-docs ok');
