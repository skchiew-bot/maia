/**
 * The live launcher end to end: seed → aocd (child process) → real managed sessions on claude-sim through
 * POST /api/sessions → Ctrl-C. Scenarios run at 5x speed (CLAUDE_SIM_SPEED) so the decision arrives quickly.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { demoLayout, type DemoTokens } from '../src/layout';
import { CLAUDE_SIM_BIN } from '../src/sim-guard';
import { DEMO_SRC, childEnv, claudeTripwire, eventsAfter, freePort, launchedArgv, stopChild, tsxImport, waitFor } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'aoc-demo-live-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('pnpm --filter @aoc/demo live', () => {
  it('runs real managed sessions on claude-sim, never the claude CLI, and stops cleanly on Ctrl-C', async () => {
    const layout = demoLayout(join(dir, 'demo'));
    const trip = claudeTripwire(dir);
    const port = await freePort();
    let out = '';
    const live = spawn(
      process.execPath,
      ['--import', tsxImport(), join(DEMO_SRC, 'live.ts'), '--data-dir', layout.root, '--port', String(port), '--no-ui', '--relaunch-after', '2'],
      { env: childEnv(trip.binDir, { CLAUDE_SIM_SPEED: '0.2' }), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    live.stdout!.on('data', (d: Buffer) => (out += d.toString()));
    live.stderr!.on('data', (d: Buffer) => (out += d.toString()));
    let seededHead = 0;
    let stopped: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    try {
      await waitFor('the launcher banner', () => (live.exitCode !== null ? Promise.reject(new Error(`launcher exited:\n${out}`)) : out.includes('Ctrl-C stops')), 120_000, 500);
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
        150_000,
      );
      expect([...seen]).toEqual(expect.arrayContaining(wanted));
    } finally {
      // Ctrl-C: the launcher stops its sessions through the API, then aocd, by PID.
      stopped = await stopChild(live, 'SIGINT', 90_000);
    }
    expect(stopped, out).toEqual({ code: 0, signal: null });
    expect(out).toContain('Stopped.');

    const events = eventsAfter(layout.aocData, seededHead);
    const decision = events.find((e) => e.type === 'decision.requested');
    expect(decision?.meta).toMatchObject({ kind: 'agent_decision' });
    // The agent's decision came from a session the launcher started (a Builder, through POST /api/sessions).
    const launchedBy = events.filter((e) => e.type === 'session.launch_requested').map((e) => e.meta.sessionId);
    expect(launchedBy).toContain(decision!.meta.sessionId);
    expect(events.some((e) => e.type === 'task.done' && e.meta.evidenceVerified === true)).toBe(true);

    // Every managed process was claude-sim; nothing ran `claude` from PATH.
    const argvs = launchedArgv(layout.aocData, seededHead);
    expect(argvs.length).toBeGreaterThanOrEqual(7);
    for (const argv of argvs) expect(argv.slice(0, 2)).toEqual([process.execPath, CLAUDE_SIM_BIN]);
    expect(existsSync(trip.invoked)).toBe(false);

    // Clean shutdown: nothing is left running; sessions waiting on a human (no process) keep waiting.
    const last = new Map<string, string>();
    for (const e of events) if (e.type === 'session.lifecycle_changed') last.set(String(e.meta.sessionId), String(e.meta.to));
    expect([...last.values()].filter((l) => l === 'running' || l === 'launching')).toEqual([]);
    expect(out).not.toMatch(/killing it/);
  }, 420_000);
});
