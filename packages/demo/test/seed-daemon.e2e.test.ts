/**
 * The plain flow: `seed`, then aocd on the seeded config (AOC_CONFIG). Right after start the console shows all six
 * liveness states, and Working / Thinking / Stalled come from real claude-sim processes the supervisor launched.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { demoLayout, type DemoTokens, type LiveKind } from '../src/layout';
import { CLAUDE_SIM_BIN } from '../src/sim-guard';
import { REPO, childEnv, claudeTripwire, daemonChildEnv, eventsAfter, freePort, launchedArgv, seedDemo, stopChild, tsxImport, waitFor } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'aoc-demo-seed-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const EXPECTED: Partial<Record<LiveKind, string>> = {
  working: 'working',
  thinking: 'thinking',
  stalled: 'stalled',
  dead: 'dead',
  throttled: 'throttled',
  waiting: 'waiting_on_you',
};

describe('seed + aocd', () => {
  it('shows all six liveness states, the live ones from real managed sessions on claude-sim', async () => {
    const layout = demoLayout(join(dir, 'demo'));
    const trip = claudeTripwire(dir);
    const seeded = await seedDemo(layout, childEnv(trip.binDir, {}));
    expect(seeded.code, seeded.output).toBe(0);
    const tokens = JSON.parse(readFileSync(layout.tokens, 'utf8')) as DemoTokens;

    // Test only: a 15 s stall threshold instead of the 10 minutes the demo keeps, so the stall session's real
    // silence is observable here. Same derivation, same process, shorter wait.
    const config = JSON.parse(readFileSync(layout.config, 'utf8')) as Record<string, unknown>;
    writeFileSync(layout.config, JSON.stringify({ ...config, liveness: { stallAfterMs: 15_000 } }, null, 2));

    const port = await freePort();
    let log = '';
    const aocd = spawn(process.execPath, ['--import', tsxImport(), join(REPO, 'packages/daemon/src/main.ts')], {
      cwd: REPO,
      env: daemonChildEnv(layout, port, trip.binDir),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    aocd.stdout!.on('data', (d: Buffer) => (log += d.toString()));
    aocd.stderr!.on('data', (d: Buffer) => (log += d.toString()));
    const kindOf = new Map(Object.entries(tokens.sessions).map(([k, id]) => [id, k as LiveKind]));
    let snapshot: Record<string, string | null> = {};
    let stopped: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    try {
      await waitFor('aocd to listen', () => (aocd.exitCode !== null ? Promise.reject(new Error(`aocd exited:\n${log}`)) : log.includes('aocd listening')), 180_000, 250);
      await waitFor(
        'the six liveness states at once, the stall after its plan',
        async () => {
          // On a loaded host a slow process start alone can outlast the 15 s threshold. The log is read before the
          // states, so Stalled counts only once the scenario has declared its plan: then it is the scenario's silence.
          const planned = eventsAfter(layout.aocData, tokens.head.seq).some((e) => e.type === 'plan.declared' && e.meta.sessionId === tokens.sessions.stalled);
          const r = await fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { authorization: `Bearer ${tokens.tokens.ceo.token}` } });
          const rows = (await r.json()) as { sessionId: string; liveness: { state: string | null } | null }[];
          snapshot = Object.fromEntries(rows.filter((s) => kindOf.has(s.sessionId)).map((s) => [kindOf.get(s.sessionId)!, s.liveness?.state ?? null]));
          return planned && Object.entries(EXPECTED).every(([k, state]) => snapshot[k] === state) ? snapshot : null;
        },
        240_000,
      ).catch((err: Error) => {
        throw new Error(`${err.message}; last snapshot ${JSON.stringify(snapshot)}`);
      });
      expect(snapshot.observed).toBe('stalled');
    } finally {
      stopped = await stopChild(aocd, 'SIGTERM', 60_000);
    }
    expect(stopped, log).toEqual({ code: 0, signal: null });

    // Working, Thinking and Stalled were real processes: the supervisor launched the seeded queued sessions on
    // claude-sim at startup and their hooks reported in (UserPromptSubmit).
    const events = eventsAfter(layout.aocData, tokens.head.seq);
    const of = (type: string, kind: LiveKind) => events.filter((e) => e.type === type && e.meta.sessionId === tokens.sessions[kind]);
    for (const kind of ['working', 'thinking', 'stalled'] as const) {
      expect(of('session.launched', kind), kind).not.toEqual([]);
      expect(of('prompt.submitted', kind), kind).not.toEqual([]);
    }
    // Working and Stalled acted through tools and the AOC MCP server before the stall went silent. Thinking makes no
    // tool call for minutes: it read Thinking in the snapshot, taken after the stall session's 15 s of silence, so
    // its own stream output had kept it from Stalled.
    expect(of('tool.used', 'working')).not.toEqual([]);
    expect(of('plan.declared', 'stalled')).not.toEqual([]);
    expect(of('session.liveness_changed', 'stalled').some((e) => e.meta.to === 'stalled' && e.meta.reason === 'no_activity')).toBe(true);
    for (const argv of launchedArgv(layout.aocData, tokens.head.seq)) expect(argv.slice(0, 2)).toEqual([process.execPath, CLAUDE_SIM_BIN]);
    expect(existsSync(trip.invoked)).toBe(false);
  }, 720_000);
});
