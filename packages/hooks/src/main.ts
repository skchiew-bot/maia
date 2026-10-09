#!/usr/bin/env node
/** Entry for `aoc-hook <HookEventName>` (registered by settings.ts; stdin = Claude Code hook JSON). */
import { homedir } from 'node:os';
import { hookFailureResult, runHook, type HookResult } from './run';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Resolves once the bytes are handed to the OS (process.exit right after a pipe write can truncate it). */
function write(stream: NodeJS.WriteStream, text: string | undefined): Promise<void> {
  return text ? new Promise((resolve) => stream.write(text, () => resolve())) : Promise.resolve();
}

async function emit(result: HookResult): Promise<never> {
  await write(process.stdout, result.stdout);
  await write(process.stderr, result.stderr);
  process.exit(result.exitCode);
}

async function main(): Promise<never> {
  let stdin = '';
  try {
    stdin = await readStdin();
  } catch {
    // an unreadable stdin fails input parsing below: closed for managed PreToolUse, silent otherwise
  }
  return emit(await runHook({ event: process.argv[2] ?? '', stdin, env: process.env, homeDir: homedir() }));
}

// A closed pipe on Claude Code's side must not turn into an uncaught EPIPE (exit 1 = non-blocking, i.e. fail open).
process.stdout.on('error', () => {});
process.stderr.on('error', () => {});
main().catch((err: unknown) => emit(hookFailureResult(process.argv[2] ?? '', process.env, err)));
