import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

/** The slice of a child process `aoc serve` needs. */
export interface ChildHandle {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: 'error', listener: (err: Error) => void): unknown;
}
export interface SpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  /** Own process group, so a terminal Ctrl-C reaches the child once — via our forwarding. */
  detached: boolean;
}
export type SpawnFn = (req: SpawnRequest) => ChildHandle;
export type GitRunner = (args: string[], cwd: string) => { code: number; stdout: string };
export interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

/**
 * Everything the CLI touches outside its own memory. Tests inject fakes; `nodeDeps()` is the real thing.
 * Only `serve` uses `spawn` and only `doctor` uses `git` — no other command (in particular `run`) may.
 */
export interface CliDeps {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  homeDir: string;
  cwd: string;
  fetch: typeof fetch;
  now(): number;
  sleep(ms: number): Promise<void>;
  readStdin(): Promise<string>;
  spawn: SpawnFn;
  git: GitRunner;
  /** process.argv[1] — locates binaries bundled next to this CLI (aocd.mjs, aoc-hook.mjs). */
  argv1: string;
  execPath: string;
  platform: NodeJS.Platform;
  signals: SignalSource;
}

export function nodeDeps(): CliDeps {
  return {
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
    env: process.env,
    homeDir: homedir(),
    cwd: process.cwd(),
    fetch: globalThis.fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    readStdin,
    spawn: (req) =>
      spawn(req.command, req.args, {
        cwd: req.cwd,
        detached: req.detached,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: process.env,
      }),
    git: (args, cwd) => {
      const r = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return { code: r.error ? 127 : (r.status ?? 1), stdout: r.stdout ?? '' };
    },
    argv1: process.argv[1] ?? '',
    execPath: process.execPath,
    platform: process.platform,
    signals: process,
  };
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(typeof c === 'string' ? Buffer.from(c) : (c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}
