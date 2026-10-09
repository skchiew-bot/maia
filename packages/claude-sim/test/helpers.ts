import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaudeSim, simCommand, transcriptPathFor } from '../src/index';

export interface Sandbox {
  root: string;
  /** Working directory of the simulated session (realpath'd, as the sim reports it). */
  cwd: string;
  configDir: string;
  home: string;
  file(name: string): string;
  cleanup(): void;
}

export function makeSandbox(): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sim-test-')));
  const cwd = path.join(root, 'work');
  const configDir = path.join(root, 'claude-config');
  const home = path.join(root, 'home');
  for (const dir of [cwd, configDir, home]) fs.mkdirSync(dir, { recursive: true });
  return {
    root,
    cwd,
    configDir,
    home,
    file: (name) => path.join(root, name),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Minimal, deterministic environment for a sim run. */
export function simEnv(box: Sandbox, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: box.home,
    CLAUDE_CONFIG_DIR: box.configDir,
    CLAUDE_SIM_SPEED: '0.01',
    TZ: 'UTC',
    ...extra,
  };
}

export interface SimRun {
  code: number;
  stdout: string;
  stderr: string;
}

class Capture {
  text = '';
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

export interface RunOptions {
  env?: Record<string, string>;
  stdin?: string;
  now?: () => number;
  signal?: AbortSignal;
}

/** Run the sim in-process (fast; used by most tests). */
export async function runSim(box: Sandbox, args: string[], options: RunOptions = {}): Promise<SimRun> {
  const stdout = new Capture();
  const stderr = new Capture();
  const code = await runClaudeSim(args, simEnv(box, options.env), {
    cwd: box.cwd,
    stdout,
    stderr,
    homeDir: box.home,
    ...(options.stdin !== undefined && { stdin: options.stdin }),
    ...(options.now && { now: options.now }),
    ...(options.signal && { signal: options.signal }),
  });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

export interface SpawnedSim {
  child: ReturnType<typeof spawn>;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
  stdout(): string;
}

/** Spawn the real launcher (bin/claude-sim.mjs) as a child process, the way other packages will. */
export function spawnSim(box: Sandbox, args: string[], env: Record<string, string> = {}): SpawnedSim {
  const { command, args: prefix } = simCommand();
  const child = spawn(command, [...prefix, ...args], {
    cwd: box.cwd,
    env: simEnv(box, env),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const done = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done, stdout: () => stdout };
}

export function parseLines(text: string): Record<string, any>[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, any>);
}

export function transcriptFile(box: Sandbox, sessionId: string): string {
  return transcriptPathFor(box.cwd, sessionId, box.configDir);
}

export function readTranscript(box: Sandbox, sessionId: string): Record<string, any>[] {
  return parseLines(fs.readFileSync(transcriptFile(box, sessionId), 'utf8'));
}

export function readJsonLines(file: string): Record<string, any>[] {
  return fs.existsSync(file) ? parseLines(fs.readFileSync(file, 'utf8')) : [];
}

const fakeServer = fileURLToPath(new URL('./fixtures/fake-aoc-mcp.ts', import.meta.url));

/**
 * `--mcp-config` JSON for the fake AOC server, logging its calls to `logFile`. The fixture only imports
 * packages, so Node's own type stripping runs it (about twice as fast to start as tsx).
 */
export function fakeAocConfig(logFile: string, env: Record<string, string> = {}, serverName = 'aoc'): string {
  return JSON.stringify({
    mcpServers: {
      [serverName]: {
        command: process.execPath,
        args: ['--experimental-strip-types', '--no-warnings', fakeServer],
        env: { FAKE_AOC_LOG: logFile, ...env },
      },
    },
  });
}

/** Run `tasks` with at most `limit` in flight (keeps process-heavy tests from starving the machine). */
export async function inBatches<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** Settings JSON with one command hook per event (matcher optional). */
export function hookSettings(
  hooks: Record<string, { matcher?: string; command: string; timeout?: number }[]>,
): string {
  const out: Record<string, unknown[]> = {};
  for (const [event, list] of Object.entries(hooks)) {
    out[event] = list.map(({ matcher, command, timeout }) => ({
      ...(matcher !== undefined && { matcher }),
      hooks: [{ type: 'command', command, ...(timeout !== undefined && { timeout }) }],
    }));
  }
  return JSON.stringify({ hooks: out });
}

export const SESSION_A = '11111111-2222-4333-8444-555555555555';
export const SESSION_B = '66666666-7777-4888-9999-aaaaaaaaaaaa';
