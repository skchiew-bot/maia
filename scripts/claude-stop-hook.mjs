#!/usr/bin/env node
/*
 * Claude Code Stop hook (.claude/settings.json): a session may not finish while scripts/check-docs.mjs fails. The
 * first time, the stop is blocked and the problems go back to Claude to fix (exit 2, stderr). If they are still there
 * on the stop that follows (stop_hook_active), the session is let go with a warning to the user, so a problem Claude
 * cannot fix in-session never loops.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  // no or unreadable hook input: treat as a first stop
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync(process.execPath, [join(root, 'scripts', 'check-docs.mjs')], { cwd: root, encoding: 'utf8' });
if (r.status === 0) process.exit(0);

const problems = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
if (input.stop_hook_active) {
  process.stdout.write(
    JSON.stringify({ systemMessage: `scripts/check-docs.mjs still fails; fix before merging:\n${problems}` }),
  );
  process.exit(0);
}
process.stderr.write(
  `${problems}\n\nThe compliance docs no longer match the code (CLAUDE.md, "Lessons from past mistakes"). ` +
    'Fix these before finishing, then re-run `node scripts/check-docs.mjs`.\n',
);
process.exit(2);
