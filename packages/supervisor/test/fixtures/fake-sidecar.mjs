#!/usr/bin/env node
// Fake per-session sidecar: `node fake-sidecar.mjs <log file> --session … --pid …`. Records argv and env names.
import { appendFileSync } from 'node:fs';

const [log, ...args] = process.argv.slice(2);
appendFileSync(log, JSON.stringify({ args, env: process.env }) + '\n');
