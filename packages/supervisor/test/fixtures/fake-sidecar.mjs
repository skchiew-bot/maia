#!/usr/bin/env node
// Fake per-session sidecar: `node fake-sidecar.mjs <log file> --session … --pid …`. Records argv and env names.
import { appendFileSync } from 'node:fs';

const [log, ...args] = process.argv.slice(2);
appendFileSync(log, JSON.stringify({ args, env: process.env }) + '\n');

// FAKE_SIDECAR_LINGER=1: like the real sidecar, stay up until SIGTERM, then record it (the final flush) and exit.
if (process.env.FAKE_SIDECAR_LINGER === '1') {
  process.on('SIGTERM', () => {
    appendFileSync(log, JSON.stringify({ sigterm: true, args }) + '\n');
    process.exit(0);
  });
  setInterval(() => {}, 60_000);
}
