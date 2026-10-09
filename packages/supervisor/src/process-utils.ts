/** Process helpers: signalling process groups, verifying a pid still belongs to a session, isolated command runs. */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { constants } from 'node:os';
import { isAbsolute } from 'node:path';

export function signalProcess(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** Managed processes are group leaders (spawned detached): signal the whole tree, else the pid alone. */
export function signalTree(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    signalProcess(pid, signal);
  }
}

/**
 * True when `pid` is alive AND its command line contains `needle` (the claude session UUID). Guards against pid
 * reuse after a reboot: an unrelated process with a recycled pid is never treated (or signalled) as a session.
 */
export function processMatches(pid: number, needle: string): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(needle);
  } catch {
    const r = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.includes(needle);
  }
}

/** Bounded output capture (stdout/stderr of isolated runs). */
class Capture {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(b: Buffer): void {
    if (this.size >= this.max) {
      this.truncated = true;
      return;
    }
    const room = this.max - this.size;
    this.chunks.push(b.length > room ? b.subarray(0, room) : b);
    this.size += Math.min(b.length, room);
    if (b.length > room) this.truncated = true;
  }
  text(): string {
    return (
      Buffer.concat(this.chunks).toString('utf8') + (this.truncated ? '\n[output truncated by AOC]' : '')
    );
  }
}

export interface IsolatedRun {
  cwd: string;
  command: string[];
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputBytes?: number;
  /** Run as this user (aocd must be root). */
  uid?: number;
  gid?: number;
}

/** Run a command (never through a shell) with exactly `env`; exit 124 on timeout, 127 when it cannot start. */
export function runCommand(i: IsolatedRun): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const [bin, ...args] = i.command;
  if (!bin) return Promise.reject(new Error('runIsolated: command is required'));
  if (!isAbsolute(i.cwd) || !existsSync(i.cwd) || !statSync(i.cwd).isDirectory()) {
    return Promise.reject(new Error(`runIsolated: cwd must be an existing absolute directory (${i.cwd})`));
  }
  const max = i.maxOutputBytes ?? 4 * 1024 * 1024;
  return new Promise((resolve) => {
    const out = new Capture(max);
    const err = new Capture(max);
    let timedOut = false;
    let done = false;
    const finish = (exitCode: number, note?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const stderr = err.text();
      resolve({
        exitCode,
        stdout: out.text(),
        stderr: note ? `${stderr}${stderr ? '\n' : ''}${note}` : stderr,
      });
    };
    const child = spawn(bin, args, {
      cwd: i.cwd,
      env: i.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      ...(i.uid !== undefined ? { uid: i.uid, gid: i.gid } : {}),
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) signalTree(child.pid, 'SIGKILL');
    }, i.timeoutMs);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', (e) => finish(127, `[aoc] could not start ${bin}: ${e.message}`));
    child.on('close', (code, signal) => {
      if (timedOut) finish(124, `[aoc] timed out after ${i.timeoutMs} ms`);
      else finish(code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1));
    });
  });
}
