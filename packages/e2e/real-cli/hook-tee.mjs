#!/usr/bin/env node
/*
 * Capture wrapper for the real-CLI checks: sits between Claude Code and the aoc-hook binary. It records the hook
 * input exactly as Claude Code sent it, the hook's answer and how long the hook took, then passes stdout, stderr and
 * the exit code through unchanged.
 *
 *   hook-tee.mjs <capture-dir> <hook command...> <HookEventName>
 *
 * Appends one JSON line per invocation to <dir>/hooks.jsonl. The environment is never recorded (it holds the
 * session's ingest token).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [dir, cmd, ...rest] = process.argv.slice(2);
if (!dir || !cmd || rest.length === 0) {
  process.stderr.write('usage: hook-tee.mjs <capture-dir> <hook command...> <HookEventName>\n');
  process.exit(2);
}
const event = rest[rest.length - 1];
mkdirSync(dir, { recursive: true });

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const stdin = Buffer.concat(chunks).toString('utf8');

const t0 = performance.now();
const child = spawn(cmd, rest, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
let stdout = '';
let stderr = '';
child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
child.stderr.on('data', (c) => (stderr += c.toString('utf8')));
child.stdin.on('error', () => {});
child.stdin.end(stdin);
child.on('close', (code) => {
  const elapsedMs = Math.round(performance.now() - t0);
  let input;
  try {
    input = JSON.parse(stdin);
  } catch {
    input = { unparsed: stdin.slice(0, 2000) };
  }
  appendFileSync(
    join(dir, 'hooks.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), event, elapsedMs, exitCode: code, input, stdout, stderr }) + '\n',
  );
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code ?? 1);
});
