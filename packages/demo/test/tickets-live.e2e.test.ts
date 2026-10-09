/**
 * The tickets that carry on after the seed, live on claude-sim (§7). Scenarios run at 5x speed (CLAUDE_SIM_SPEED).
 *  1. The ticket the seed left in triage: aocd's startup recovery runs its two read-only agents, they agree, the fix
 *     plan reaches the Approver, and its approval builds the fix onto uat/<ticket>.
 *  2. A ticket a requester files while the demo runs: triaged with low confidence, a Builder accepts the diagnosis,
 *     the Approver approves the fix plan, the generic build lands on the ticket's own uat/<ticket>, and the
 *     requester's sign-off asks for go-live (the promotion passes provenance).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { demoLayout, type DemoTokens } from '../src/layout';
import { groupExited } from '../src/process-group';
import { REPO, call, childEnv, claudeTripwire, daemonChildEnv, diagnostics, eventsAfter, freePort, removeTree, seedDemo, stopChild, tsxImport, waitFor } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'aoc-demo-tickets-'));
// A failed run keeps its directory (the daemon log, the event log, the repos) for inspection.
let kept = false;
afterAll(() => {
  if (!kept) removeTree(dir);
});

const git = (repo: string, ...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim();

describe('tickets after the seed, live', () => {
  it('diagnoses the ticket in triage and builds its approved fix, then takes a freshly filed ticket to the go-live gate', async () => {
    const layout = demoLayout(join(dir, 'demo'));
    const trip = claudeTripwire(dir);
    const seeded = await seedDemo(layout, childEnv(trip.binDir, {}));
    expect(seeded.code, seeded.output).toBe(0);
    const tokens = JSON.parse(readFileSync(layout.tokens, 'utf8')) as DemoTokens;
    const inTriage = tokens.tickets.find((t) => t.key === 'transfer-blank')!.ticketId;

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
    const ticketEvent = (ticketId: string, type: string) => eventsAfter(layout.aocData, tokens.head.seq).find((e) => e.type === type && e.meta.ticketId === ticketId) ?? null;
    const openCard = async (ticketId: string, kind: string) => {
      const open = await call<{ decisions: { id: string }[] }>(base, 'GET', `/api/decisions?status=open&kind=${kind}&subjectId=${ticketId}`, ceo);
      return open.data.decisions[0]?.id ?? null;
    };
    const ceo = tokens.tokens.ceo.token;
    let stopped: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let current = inTriage;
    try {
      await waitFor('aocd to listen', () => (aocd.exitCode !== null ? Promise.reject(new Error(`aocd exited:\n${log}`)) : log.includes('aocd listening')), 180_000, 250);
      // The seeded Working, Thinking and Stalled sessions are not part of this flow: stopping them keeps the test to
      // the intake sessions, a lighter load on a shared host.
      for (const kind of ['working', 'thinking', 'stalled'] as const) {
        const stop = await call(base, 'POST', `/api/sessions/${tokens.sessions[kind]}/stop`, ceo, { immediate: true, reason: 'not part of the tickets test' });
        expect(stop.status, JSON.stringify(stop.data)).toBe(200);
      }

      // 1. The ticket in triage: both agents run on claude-sim, report and agree; the fix plan is the Approver's.
      const cx = join(layout.repos, 'cx-copilot');
      const plan = await waitFor('the fix plan of the ticket in triage', () => openCard(inTriage, 'fix_plan'), 420_000, 2000);
      const reports = eventsAfter(layout.aocData, tokens.head.seq).filter((e) => e.type === 'ticket.diagnosis_reported' && e.meta.ticketId === inTriage);
      expect(reports).toHaveLength(2);
      expect(reports.every((r) => r.meta.confidence === 0.87)).toBe(true);
      const approved = await call(base, 'POST', `/api/decisions/${plan}/resolve`, ceo, { optionId: 'approve' });
      expect(approved.status, JSON.stringify(approved.data)).toBe(200);
      const uat = await waitFor('ticket.uat_ready for the ticket that was in triage', () => ticketEvent(inTriage, 'ticket.uat_ready'), 360_000);
      expect(uat.meta).toMatchObject({ uatRef: `uat/${inTriage}`, uatSha: git(cx, 'rev-parse', `uat/${inTriage}`) });
      const build = ticketEvent(inTriage, 'ticket.build_started')!;
      const message = git(cx, 'log', '-1', '--format=%B', `uat/${inTriage}`);
      expect(message).toContain(`AOC-Session: ${String(build.meta.sessionId)}`);
      expect(message).toContain(`AOC-Ticket: ${inTriage}`);
      expect(git(cx, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main');

      // 2. A requester files a new ticket through the portal while the demo runs.
      const form = new FormData();
      form.set('title', 'The claim form loses my answers when I go back a page');
      form.set('description', 'If I go back one page while filling in a claim, the answers I typed on the page I left are gone and I have to type them again.');
      form.set('severity', 'medium');
      form.set('projectId', tokens.projects.claims);
      const filed = await fetch(`${base}/portal/api/intakes`, { method: 'POST', headers: { authorization: `Bearer ${tokens.tokens.daniel.token}` }, body: form });
      expect(filed.status).toBe(201);
      const fresh = ((await filed.json()) as { ticketId: string }).ticketId;
      current = fresh;
      const claims = join(layout.repos, 'claims-bot');
      // Nothing in the code matches the report: both agents say so with low confidence and a Builder decides.
      const unsure = await waitFor('the low-confidence card of the new ticket', () => openCard(fresh, 'low_confidence_diagnosis'), 300_000, 2000);
      const accepted = await call(base, 'POST', `/api/decisions/${unsure}/resolve`, tokens.tokens.aisyah.token, { optionId: 'accept_best' });
      expect(accepted.status, JSON.stringify(accepted.data)).toBe(200);
      const freshPlan = await waitFor('the fix plan of the new ticket', () => openCard(fresh, 'fix_plan'), 120_000, 1000);
      const freshApproved = await call(base, 'POST', `/api/decisions/${freshPlan}/resolve`, ceo, { optionId: 'approve' });
      expect(freshApproved.status, JSON.stringify(freshApproved.data)).toBe(200);
      const freshUat = await waitFor('ticket.uat_ready for the new ticket', () => ticketEvent(fresh, 'ticket.uat_ready'), 360_000);
      expect(freshUat.meta).toMatchObject({ uatRef: `uat/${fresh}`, uatSha: git(claims, 'rev-parse', `uat/${fresh}`) });
      expect(git(claims, 'log', '-1', '--format=%B', `uat/${fresh}`)).toContain(`AOC-Ticket: ${fresh}`);

      const signoff = await call(base, 'POST', `/portal/api/tickets/${fresh}/uat`, tokens.tokens.daniel.token, { verdict: 'pass' });
      expect(signoff.status, JSON.stringify(signoff.data)).toBe(200);
      const golive = await waitFor('ticket.golive_requested for the new ticket', () => ticketEvent(fresh, 'ticket.golive_requested'), 120_000);
      expect(golive.meta.decisionId).not.toBe('none');

      const events = eventsAfter(layout.aocData, tokens.head.seq);
      expect(events.some((e) => e.type === 'promotion.requested' && e.meta.ticketId === fresh)).toBe(true);
      expect(events.filter((e) => e.type === 'promotion.refused')).toEqual([]);
      expect(events.filter((e) => e.type === 'selfmod.blocked')).toEqual([]);
      for (const ticketId of [inTriage, fresh]) {
        const sessionId = ticketEvent(ticketId, 'ticket.build_started')!.meta.sessionId;
        expect(events.some((e) => e.type === 'task.done' && e.meta.sessionId === sessionId && e.meta.evidenceKind === 'commit' && e.meta.evidenceVerified === true), ticketId).toBe(true);
      }
    } catch (err) {
      kept = true;
      if (err instanceof Error) err.message += `\n\nkept ${dir}\n${diagnostics(layout.aocData, tokens.head.seq, log, current)}`;
      throw err;
    } finally {
      stopped = await stopChild(aocd, 'SIGTERM', 60_000);
      // aocd's sidecars outlive it for a final flush that writes a spool file into the data directory.
      await groupExited(aocd.pid!, 20_000);
    }
    expect(stopped, log).toEqual({ code: 0, signal: null });
    expect(existsSync(trip.invoked)).toBe(false);
  }, 1_200_000);
});
