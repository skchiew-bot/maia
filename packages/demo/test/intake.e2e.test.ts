/**
 * The intake path end to end on a seeded demo (§7): the receipts ticket's fix plan is approved, intake launches the
 * build on claude-sim, the build commits to uat/<ticket>, the requester signs UAT off and go-live is requested.
 * Scenarios run at 5x speed (CLAUDE_SIM_SPEED).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { demoLayout, type DemoTokens } from '../src/layout';
import { groupExited } from '../src/process-group';
import { REPO, call, childEnv, claudeTripwire, daemonChildEnv, diagnostics, eventsAfter, freePort, removeTree, seedDemo, stopChild, tsxImport, waitFor } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'aoc-demo-intake-'));
// A failed run keeps its directory (the daemon log, the event log, the repos) for inspection.
let kept = false;
afterAll(() => {
  if (!kept) removeTree(dir);
});

const git = (repo: string, ...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim();

describe('intake on a seeded demo', () => {
  it("builds the approved fix onto uat/<ticket>, reaches UAT and, after the requester's sign-off, the go-live gate", async () => {
    const layout = demoLayout(join(dir, 'demo'));
    const trip = claudeTripwire(dir);
    const seeded = await seedDemo(layout, childEnv(trip.binDir, {}));
    expect(seeded.code, seeded.output).toBe(0);
    const tokens = JSON.parse(readFileSync(layout.tokens, 'utf8')) as DemoTokens;
    const ticketId = tokens.tickets.find((t) => t.key === 'receipts')!.ticketId;
    const repo = join(layout.repos, 'claims-bot');

    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    let log = '';
    const aocd = spawn(process.execPath, ['--import', tsxImport(), join(REPO, 'packages/daemon/src/main.ts')], {
      cwd: REPO,
      env: daemonChildEnv(layout, port, trip.binDir, { CLAUDE_SIM_SPEED: '0.2' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // its own process group: the sidecars it leaves behind are found through it
    });
    aocd.stdout!.on('data', (d: Buffer) => (log += d.toString()));
    aocd.stderr!.on('data', (d: Buffer) => (log += d.toString()));
    const ticketEvent = (type: string) => eventsAfter(layout.aocData, tokens.head.seq).find((e) => e.type === type && e.meta.ticketId === ticketId) ?? null;
    let stopped: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    try {
      await waitFor('aocd to listen', () => (aocd.exitCode !== null ? Promise.reject(new Error(`aocd exited:\n${log}`)) : log.includes('aocd listening')), 180_000, 250);
      const ceo = tokens.tokens.ceo.token;
      // The seeded Working, Thinking and Stalled sessions are not part of this flow: stopping them keeps the test to
      // the intake sessions, a lighter load on a shared host.
      for (const kind of ['working', 'thinking', 'stalled'] as const) {
        const stop = await call(base, 'POST', `/api/sessions/${tokens.sessions[kind]}/stop`, ceo, { immediate: true, reason: 'not part of the intake test' });
        expect(stop.status, JSON.stringify(stop.data)).toBe(200);
      }

      // The seeded triage left the fix plan with the Approver: approve it.
      const open = await call<{ decisions: { id: string }[] }>(base, 'GET', `/api/decisions?status=open&kind=fix_plan&subjectId=${ticketId}`, ceo);
      expect(open.data.decisions).toHaveLength(1);
      const approved = await call(base, 'POST', `/api/decisions/${open.data.decisions[0]!.id}/resolve`, ceo, { optionId: 'approve' });
      expect(approved.status, JSON.stringify(approved.data)).toBe(200);

      const build = await waitFor('ticket.build_started', () => ticketEvent('ticket.build_started'), 120_000);
      const uat = await waitFor('ticket.uat_ready', () => ticketEvent('ticket.uat_ready'), 360_000);
      // The build committed the fix on uat/<ticket>, traced to its session, and left the shared checkout on main.
      expect(uat.meta).toMatchObject({ uatRef: `uat/${ticketId}`, uatSha: git(repo, 'rev-parse', `uat/${ticketId}`) });
      const message = git(repo, 'log', '-1', '--format=%B', `uat/${ticketId}`);
      expect(message).toContain(`AOC-Session: ${String(build.meta.sessionId)}`);
      expect(message).toContain(`AOC-Ticket: ${ticketId}`);
      expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

      // The requester tests on UAT and signs off on the portal.
      const signoff = await call(base, 'POST', `/portal/api/tickets/${ticketId}/uat`, tokens.tokens.daniel.token, { verdict: 'pass' });
      expect(signoff.status, JSON.stringify(signoff.data)).toBe(200);
      const golive = await waitFor('ticket.golive_requested', () => ticketEvent('ticket.golive_requested'), 120_000);
      expect(golive.meta.decisionId).not.toBe('none');
      const events = eventsAfter(layout.aocData, tokens.head.seq);
      expect(events.some((e) => e.type === 'promotion.requested' && e.meta.ticketId === ticketId)).toBe(true);
      expect(events.filter((e) => e.type === 'promotion.refused')).toEqual([]);
      expect(events.filter((e) => e.type === 'selfmod.blocked')).toEqual([]);
      expect(events.some((e) => e.type === 'task.done' && e.meta.sessionId === build.meta.sessionId && e.meta.evidenceKind === 'commit' && e.meta.evidenceVerified === true)).toBe(true);
    } catch (err) {
      kept = true;
      if (err instanceof Error) err.message += `\n\nkept ${dir}\n${diagnostics(layout.aocData, tokens.head.seq, log, ticketId)}`;
      throw err;
    } finally {
      stopped = await stopChild(aocd, 'SIGTERM', 60_000);
      // aocd's sidecars outlive it for a final flush that writes a spool file into the data directory.
      await groupExited(aocd.pid!, 20_000);
    }
    expect(stopped, log).toEqual({ code: 0, signal: null });
    expect(existsSync(trip.invoked)).toBe(false);
  }, 900_000);
});
