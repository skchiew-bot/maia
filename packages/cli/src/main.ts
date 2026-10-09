#!/usr/bin/env node
import { runCli } from './cli';
import { nodeDeps } from './deps';

// `aoc sessions | head` closes the pipe early; that is not an error.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

process.exitCode = await runCli(process.argv.slice(2), nodeDeps());
