/**
 * The supervisor while history is written: aocd is not running, so no session can start. This stand-in is what the
 * modules that call the `supervisor` service need from it, nothing more.
 *
 * - `launch` records a queued launch (lifecycle `launching`, no turn yet), exactly what the real supervisor records
 *   before it spawns `claude`. Intake's own flow (triage on submit, build after the fix plan) therefore runs
 *   unchanged; the seeder plays the part of the session's process afterwards, or leaves the launch queued for aocd's
 *   startup recovery to start on claude-sim.
 * - `runIsolated` really runs the command (rollback verification, promotion, break-glass), in a clean environment
 *   with git's host configuration switched off. The demo's credential profiles have empty environments (see
 *   `credential-profiles.json`), so promotions need no real credentials: nothing is injected. The seeding clock
 *   moves on by the time the command really took, so a verification report shows a real duration.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import type { Actor, LaunchRequest, SupervisorService } from '@aoc/contracts';
import type { FakeClock } from '@aoc/kernel';

export interface IsolatedRun {
  cwd: string;
  command: string[];
  credentialProfile: string | null;
  timeoutMs: number;
  env?: Record<string, string>;
}

export class SeedSupervisor implements SupervisorService {
  readonly runs: IsolatedRun[] = [];

  constructor(
    private readonly clock: FakeClock,
    /** Records the queued launch and returns the new session's id. */
    private readonly queueLaunch: (req: LaunchRequest, actor: Actor) => string,
    /** Credential profiles the demo defines (all with empty environments). */
    private readonly profiles: ReadonlySet<string>,
  ) {}

  async launch(req: LaunchRequest, actor: Actor): Promise<{ sessionId: string }> {
    return { sessionId: this.queueLaunch(req, actor) };
  }

  async stop(): Promise<void> {}
  isRunning(): boolean {
    return false;
  }
  stopRequested(): boolean {
    return false;
  }

  async resume(): Promise<void> {
    throw new Error('no session process exists while the seeder writes history');
  }
  async nudge(): Promise<void> {
    throw new Error('no session process exists while the seeder writes history');
  }
  async restart(): Promise<void> {
    throw new Error('no session process exists while the seeder writes history');
  }
  async rollover(): Promise<{ refused: string[] }> {
    return { refused: ['no session process exists while the seeder writes history'] };
  }

  runIsolated(input: IsolatedRun): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.runs.push(input);
    if (input.credentialProfile && !this.profiles.has(input.credentialProfile)) {
      return Promise.reject(new Error(`credential profile "${input.credentialProfile}" is not defined for the demo`));
    }
    // Commits the platform makes while seeding carry the seeding clock's time, never the wall clock's.
    const date = `${Math.floor(this.clock.now() / 1000)} +0000`;
    const [bin, ...args] = input.command;
    const began = performance.now();
    const finish = (r: { exitCode: number; stdout: string; stderr: string }) => {
      this.clock.advance(Math.max(1, Math.round(performance.now() - began)));
      return r;
    };
    return new Promise((resolve) => {
      const child = spawn(bin!, args, {
        cwd: input.cwd,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: tmpdir(),
          LANG: 'C.UTF-8',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
          ...input.env,
        },
        timeout: input.timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err) => resolve(finish({ exitCode: 127, stdout, stderr: `${stderr}${String(err)}` })));
      child.on('close', (code) => resolve(finish({ exitCode: code ?? 1, stdout, stderr })));
    });
  }
}
