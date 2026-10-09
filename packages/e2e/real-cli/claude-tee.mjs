#!/usr/bin/env node
/*
 * Capture wrapper for the real-CLI checks: runs the real `claude` with the arguments the supervisor built and copies
 * its stdout (stream-json) and stderr to files, so a run can be replayed and turned into fixtures. It forwards signals
 * and the exit status unchanged, so the supervisor sees what it would see from claude itself.
 *
 *   claude-tee.mjs --capture-dir <dir> --claude <path-to-claude> -- <claude arguments>
 *
 * Files: <dir>/<AOC_SESSION_ID>.turn-<n>.{argv.json,stream.jsonl,stderr.txt}. The environment is never recorded.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i < dd ? argv[i + 1] : undefined;
};
const dir = flag('--capture-dir');
const claude = flag('--claude') ?? 'claude';
const claudeArgs = argv.slice(dd + 1);
if (!dir || dd < 0) {
  process.stderr.write('usage: claude-tee.mjs --capture-dir <dir> --claude <bin> -- <args>\n');
  process.exit(2);
}
mkdirSync(dir, { recursive: true });

const session = (process.env.AOC_SESSION_ID ?? 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
const turn = readdirSync(dir).filter((f) => f.startsWith(`${session}.turn-`) && f.endsWith('.argv.json')).length + 1;
const base = join(dir, `${session}.turn-${turn}`);
writeFileSync(`${base}.argv.json`, JSON.stringify({ at: new Date().toISOString(), argv: claudeArgs }, null, 2));

const child = spawn(claude, claudeArgs, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
child.stdout.on('data', (chunk) => {
  appendFileSync(`${base}.stream.jsonl`, chunk);
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  appendFileSync(`${base}.stderr.txt`, chunk);
  process.stderr.write(chunk);
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('error', (err) => {
  process.stderr.write(`claude-tee: could not start ${claude}: ${err.message}\n`);
  process.exit(127);
});
child.on('close', (code, signal) => {
  appendFileSync(`${base}.exit.json`, JSON.stringify({ at: new Date().toISOString(), code, signal }) + '\n');
  // A signal death is re-raised, so the parent sees the same status claude had (143 for SIGTERM, ...).
  if (signal) process.exit(128 + (constants.signals[signal] ?? 0));
  process.exit(code ?? 1);
});
