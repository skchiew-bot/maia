import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventStore, createLogger, loadOrCreateMasterKey, systemClock } from '@aoc/kernel';
import { daemonEnv } from '../src/daemon-env';
import type { DemoLayout } from '../src/layout';

export const REPO = fileURLToPath(new URL('../../..', import.meta.url));
export const DEMO_SRC = fileURLToPath(new URL('../src', import.meta.url));

export const tsxImport = (): string => pathToFileURL(createRequire(join(REPO, 'package.json')).resolve('tsx')).href;

/** A free port picked by the OS (aocd needs it up front: sessions are told its URL). */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

/**
 * A `claude` executable first on PATH that records every invocation: anything that spawns the real CLI by name
 * (a misconfigured supervisor, the claude-cli LLM extractor) trips it instead.
 */
export function claudeTripwire(dir: string): { binDir: string; invoked: string } {
  const binDir = join(dir, 'tripwire');
  const invoked = join(binDir, 'invoked');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'claude'), `#!/bin/sh\necho "$@" >> '${invoked}'\nexit 97\n`);
  chmodSync(join(binDir, 'claude'), 0o755);
  return { binDir, invoked };
}

/** The parent env without credentials, AOC_* overrides or sim settings, with the tripwire first on PATH. */
export function childEnv(tripwireBin: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('AOC_') || k.startsWith('CLAUDE_SIM_') || ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'].includes(k)) continue;
    env[k] = v;
  }
  return { ...env, PATH: `${tripwireBin}:${process.env.PATH ?? ''}`, ...extra };
}

/** aocd on a demo directory, as `live` starts it (./src/daemon-env.ts), with the tripwire first on PATH. */
export function daemonChildEnv(layout: DemoLayout, port: number, tripwireBin: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...daemonEnv(layout, port, childEnv(tripwireBin, {})), ...extra };
}

/** Bearer-token JSON request against a local aocd. */
export async function call<T>(base: string, method: string, path: string, token: string, body?: unknown): Promise<{ status: number; data: T }> {
  const r = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, data: (text ? JSON.parse(text) : null) as T };
}

/**
 * Polls until `probe` yields a value. The e2e budgets are upper bounds for a loaded host, where every session runs
 * several node processes (claude-sim, hooks, MCP server, sidecar); an idle machine needs a fraction of them.
 */
export async function waitFor<T>(what: string, probe: () => Promise<T | null> | T | null, timeoutMs: number, everyMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== null && v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Event headers (clear meta) appended after `afterSeq`; read-only, safe while aocd writes (WAL). */
export function eventsAfter(aocData: string, afterSeq: number): { seq: number; type: string; meta: Record<string, unknown> }[] {
  const db = new DatabaseSync(join(aocData, 'aoc.db'), { readOnly: true });
  try {
    return (db.prepare('SELECT seq, type, meta FROM events WHERE seq > ? ORDER BY seq').all(afterSeq) as { seq: number; type: string; meta: string }[]).map((r) => ({
      seq: r.seq,
      type: r.type,
      meta: JSON.parse(r.meta) as Record<string, unknown>,
    }));
  } finally {
    db.close();
  }
}

/** argv of every `session.launched` after `afterSeq` (decrypted payloads; only once aocd has stopped). */
export function launchedArgv(aocData: string, afterSeq: number): string[][] {
  const store = new EventStore({ dataDir: aocData, clock: systemClock, log: createLogger({ level: 'error' }), masterKey: loadOrCreateMasterKey(join(aocData, 'master.key'), {}).key });
  try {
    return store.list({ types: ['session.launched'], fromSeq: afterSeq + 1, limit: 10_000 }).map((e) => {
      const p = store.readPayload(e) as { argv?: string[] } | null;
      return p?.argv ?? [];
    });
  } finally {
    store.close();
  }
}

/**
 * Seeds a demo directory in a child process. Asynchronous on purpose: a spawnSync would block the test worker for the
 * whole seed, and vitest's worker RPC times out on a busy machine.
 */
export function seedDemo(layout: DemoLayout, env: NodeJS.ProcessEnv): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', tsxImport(), join(DEMO_SRC, 'seed.ts'), '--data-dir', layout.root], {
      cwd: join(REPO, 'packages/demo'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout!.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr!.on('data', (d: Buffer) => (output += d.toString()));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

/** Signals the child we spawned (its own PID) and waits for it to exit. */
export async function stopChild(child: ChildProcess, signal: NodeJS.Signals, ms: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, signal: child.signalCode };
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('exit', (code, sig) => r({ code, signal: sig })));
  child.kill(signal);
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), ms).unref());
  const result = await Promise.race([exited, timeout]);
  if (result) return result;
  child.kill('SIGKILL');
  return exited;
}
