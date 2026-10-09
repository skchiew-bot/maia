#!/usr/bin/env node
// Fake per-session sidecar: `node fake-sidecar.mjs <log file> [--hold <dir> | --stubborn] --session … --pid …`. Records
// argv and env. With --hold it runs until SIGTERM (announced ready like the real one), records the signal in
// <log>.signals, then exits once <dir>/release exists (or after 3 s): the window in which a real sidecar posts its
// turn's last report. With --stubborn it records every SIGTERM and never exits on its own: a sidecar stuck in its flush.
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [log, ...args] = process.argv.slice(2);
appendFileSync(log, JSON.stringify({ args, env: process.env }) + '\n');
const hold = args.indexOf('--hold');
if (hold >= 0) {
  const release = join(args[hold + 1], 'release');
  const keepAlive = setInterval(() => {}, 1000);
  process.on('SIGTERM', () => {
    appendFileSync(`${log}.signals`, JSON.stringify({ pid: process.pid, signal: 'SIGTERM', at: Date.now() }) + '\n');
    const started = Date.now();
    const poll = setInterval(() => {
      if (!existsSync(release) && Date.now() - started < 3000) return;
      clearInterval(poll);
      clearInterval(keepAlive);
    }, 10);
  });
  process.stdout.write('aoc-sidecar ready\n'); // SIDECAR_READY_LINE
}

if (args.includes('--stubborn')) {
  setInterval(() => {}, 1000);
  process.on('SIGTERM', () => appendFileSync(`${log}.signals`, JSON.stringify({ pid: process.pid, signal: 'SIGTERM', at: Date.now() }) + '\n'));
  process.stdout.write('aoc-sidecar ready\n'); // SIDECAR_READY_LINE
}

// FAKE_SIDECAR_LINGER=1: like a real sidecar that never announces it is ready: up until SIGTERM, then record it (the
// final flush) and exit.
if (process.env.FAKE_SIDECAR_LINGER === '1') {
  process.on('SIGTERM', () => {
    appendFileSync(log, JSON.stringify({ sigterm: true, args }) + '\n');
    process.exit(0);
  });
  setInterval(() => {}, 60_000);
}
