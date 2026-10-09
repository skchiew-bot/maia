/**
 * The live launcher end to end: seed → aocd (child process) → real managed sessions on claude-sim through
 * POST /api/sessions → Ctrl-C. A small fleet for a shared host: the launcher runs only the decision slot
 * (--slots decision), next to the seeded Working, Thinking and Stalled sessions that aocd's startup recovery launches.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { demoLayout, type DemoTokens } from '../src/layout';
import { groupAlive } from '../src/process-group';
import { CLAUDE_SIM_BIN } from '../src/sim-guard';
import { DEMO_SRC, childEnv, claudeTripwire, eventsAfter, freePort, launchedArgv, removeTree, stopChild, tsxImport, waitFor } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'aoc-demo-live-'));
afterAll(() => removeTree(dir));

describe('pnpm --filter @aoc/demo live', () => {
  it('runs real managed sessions on claude-sim, never the claude CLI, and stops cleanly on Ctrl-C', async () => {
    const layout = demoLayout(join(dir, 'demo'));
    const trip = claudeTripwire(dir);
    const port = await freePort();
    let out = '';
    const live = spawn(
      process.execPath,
      ['--import', tsxImport(), join(DEMO_SRC, 'live.ts'), '--data-dir', layout.root, '--port', String(port), '--no-ui', '--slots', 'decision'],
      { env: childEnv(trip.binDir, {}), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    live.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    live.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    let seededHead = 0;
    let stopped: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    try {
      await waitFor('the launcher banner', () => (live.exitCode !== null ? Promise.reject(new Error(`launcher exited:\n${out}`)) : out.includes('Ctrl-C stops')), 300_000, 500);
      expect(out).toContain(`http://localhost:${port}/`);
      const tokens = JSON.parse(readFileSync(layout.tokens, 'utf8')) as DemoTokens;
      expect(out).toContain(tokens.tokens.ceo.token);
      seededHead = tokens.head.seq;
      const wanted = ['session.launched', 'tool.used', 'task.done', 'decision.requested'];
      const seen = await waitFor(
        'session.launched, tool.used, task.done and decision.requested from live sessions',
        () => {
          const types = new Set(eventsAfter(layout.aocData, seededHead).map((e) => e.type));
          return wanted.every((t) => types.has(t)) ? types : null;
        },
        240_000,
      );
      expect([...seen]).toEqual(expect.arrayContaining(wanted));
    } finally {
      // Ctrl-C: the launcher stops its sessions through the API, then aocd, by PID.
      stopped = await stopChild(live, 'SIGINT', 90_000);
    }
    expect(stopped, out).toEqual({ code: 0, signal: null });
    expect(out).toContain('Stopped.');
    // "Stopped." means nothing is left: aocd waits for its sidecars, and the launcher checks its process group.
    const daemonPid = Number(/aocd pid (\d+)/.exec(out)?.[1]);
    expect(daemonPid).toBeGreaterThan(0);
    expect(groupAlive(daemonPid)).toBe(false);

    const events = eventsAfter(layout.aocData, seededHead);
    const decision = events.find((e) => e.type === 'decision.requested');
    expect(decision?.meta).toMatchObject({ kind: 'agent_decision' });
    // The agent's decision came from a session the launcher started (a Builder, through POST /api/sessions).
    const launchedBy = events.filter((e) => e.type === 'session.launch_requested').map((e) => e.meta.sessionId);
    expect(launchedBy).toContain(decision!.meta.sessionId);
    expect(events.some((e) => e.type === 'task.done' && e.meta.evidenceVerified === true)).toBe(true);

    // Every managed process was claude-sim; nothing ran `claude` from PATH.
    const argvs = launchedArgv(layout.aocData, seededHead);
    expect(argvs.length).toBeGreaterThanOrEqual(4); // the decision run and the three seeded queued sessions
    for (const argv of argvs) expect(argv.slice(0, 2)).toEqual([process.execPath, CLAUDE_SIM_BIN]);
    expect(existsSync(trip.invoked)).toBe(false);

    // Clean shutdown: nothing is left running; sessions waiting on a human (no process) keep waiting.
    const last = new Map<string, string>();
    for (const e of events) if (e.type === 'session.lifecycle_changed') last.set(String(e.meta.sessionId), String(e.meta.to));
    expect([...last.values()].filter((l) => l === 'running' || l === 'launching')).toEqual([]);
    expect(out).not.toMatch(/killing it/);
  }, 720_000);
});
