/**
 * The gates the seed leaves open execute on a running console, next to sessions that are editing files. The CEO
 * registers a passkey and approves the go-live gate of a ticket (cx-copilot) and the verified rollback (aoc-platform)
 * while the seeded Working session builds in a workspace of its own. aocd's real supervisor runs the promotion and the
 * rollback (not the seeder's stand-in), and neither is blocked by a dirty checkout. The software authenticator is the
 * seeder's, driven here over HTTP exactly as a browser's would be.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DecisionCard } from '@aoc/contracts';
import { demoLayout, type DemoTokens } from '../src/layout';
import { groupExited } from '../src/process-group';
import { SoftAuthenticator } from '../src/seed/authenticator';
import { REPO, call, childEnv, claudeTripwire, daemonChildEnv, diagnostics, eventsAfter, freePort, removeTree, seedDemo, stopChild, tsxImport, waitFor } from './helpers';

const dir = mkdtempSync(join(tmpdir(), 'aoc-demo-gates-'));
// A failed run keeps its directory (the daemon log, the event log, the repos) for inspection.
let kept = false;
afterAll(() => {
  if (!kept) removeTree(dir);
});

const git = (repo: string, ...args: string[]) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim();

describe('the seeded gates on a running console', () => {
  it("promote a ticket's fix and execute the rollback with the CEO's passkey while a session edits files", async () => {
    const layout = demoLayout(join(dir, 'demo'));
    const trip = claudeTripwire(dir);
    const seeded = await seedDemo(layout, childEnv(trip.binDir, {}));
    expect(seeded.code, seeded.output).toBe(0);
    const tokens = JSON.parse(readFileSync(layout.tokens, 'utf8')) as DemoTokens;
    const cx = join(layout.repos, 'cx-copilot');
    const aoc = join(layout.repos, 'aoc-platform');
    const gateTicket = tokens.tickets.find((t) => t.key === 'wrong-name')!.ticketId;

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
    const ceo = tokens.tokens.ceo.token;
    const events = () => eventsAfter(layout.aocData, tokens.head.seq);
    const seededEvents = () => eventsAfter(layout.aocData, 0).filter((e) => e.seq <= tokens.head.seq);
    let stopped: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    try {
      await waitFor('aocd to listen', () => (aocd.exitCode !== null ? Promise.reject(new Error(`aocd exited:\n${log}`)) : log.includes('aocd listening')), 180_000, 250);
      for (const kind of ['thinking', 'stalled'] as const) {
        const stop = await call(base, 'POST', `/api/sessions/${tokens.sessions[kind]}/stop`, ceo, { immediate: true, reason: 'not part of the gates test' });
        expect(stop.status, JSON.stringify(stop.data)).toBe(200);
      }

      // The Working session edits files in cx-copilot, in its workspace.
      const working = tokens.sessions.working;
      await waitFor('the working session to change a file', () => events().find((e) => e.type === 'tool.used' && e.meta.sessionId === working && e.meta.fileChanging === true) ?? null, 240_000, 1000);
      const workspace = join(layout.workspaces, tokens.projects.cx, 'feature');
      expect(git(workspace, 'status', '--porcelain'), 'the session has files changed in its workspace').not.toBe('');
      expect(git(cx, 'status', '--porcelain'), 'the checkout the gates move is clean').toBe('');

      // The CEO registers a passkey (a software authenticator, as a browser would with a security key). The WebAuthn
      // origin follows the console's port.
      const authenticator = new SoftAuthenticator(`http://localhost:${port}`, 'localhost');
      const registerOptions = await call<{ options: Parameters<SoftAuthenticator['register']>[0] }>(base, 'POST', '/api/passkeys/register/options', ceo);
      expect(registerOptions.status, JSON.stringify(registerOptions.data)).toBeLessThan(300);
      const registered = await call(base, 'POST', '/api/passkeys/register/verify', ceo, { response: authenticator.register(registerOptions.data.options), label: 'gates e2e (software)' });
      expect(registered.status, JSON.stringify(registered.data)).toBeLessThan(300);
      const approve = async (card: DecisionCard) => {
        const options = await call<{ options: Parameters<SoftAuthenticator['assert']>[0] }>(base, 'POST', '/api/passkeys/assert/options', ceo, { decisionId: card.id, optionId: 'approve' });
        expect(options.status, JSON.stringify(options.data)).toBeLessThan(300);
        const resolved = await call(base, 'POST', `/api/decisions/${card.id}/resolve`, ceo, { optionId: 'approve', passkeyAssertion: authenticator.assert(options.data.options) });
        expect(resolved.status, JSON.stringify(resolved.data)).toBeLessThan(300);
      };
      const openCard = async (kind: string, subjectFilter: (c: DecisionCard) => boolean) => {
        const open = await call<{ decisions: DecisionCard[] }>(base, 'GET', `/api/decisions?status=open&kind=${kind}`, ceo);
        const card = open.data.decisions.find(subjectFilter);
        expect(card, `an open ${kind} card`).toBeDefined();
        return card!;
      };

      // 1. Go-live of the ticket whose UAT the requester passed: the promotion executes and closes the ticket.
      const golive = seededEvents().find((e) => e.type === 'ticket.golive_requested' && e.meta.ticketId === gateTicket);
      expect(golive, 'the seed requested go-live for the ticket').toBeDefined();
      const uatSha = git(cx, 'rev-parse', `uat/${gateTicket}`);
      const portal = () => call<Record<string, unknown>>(base, 'GET', `/portal/api/tickets/${gateTicket}`, tokens.tokens.nur.token);
      // The requester passed UAT: nothing is left for them to test while the gate decides.
      expect((await portal()).data).toMatchObject({ status: 'being_worked_on', canSignOffUat: false });
      await approve(await openCard('go_live', (c) => c.id === String(golive!.meta.decisionId)));
      const promoted = await waitFor('promotion.completed', () => events().find((e) => e.type === 'promotion.completed' && e.meta.promotionId === golive!.meta.promotionId) ?? null, 120_000, 500);
      expect(promoted.meta).toMatchObject({ mainShaAfter: uatSha, breakglass: false });
      const closed = await waitFor('the ticket closing as fixed', () => events().find((e) => e.type === 'ticket.closed' && e.meta.ticketId === gateTicket) ?? null, 60_000, 500);
      expect(closed.meta).toMatchObject({ resolution: 'fixed' });
      expect((await portal()).data).toMatchObject({ status: 'completed', statusLabel: 'Completed' });
      expect(git(cx, 'rev-parse', 'main')).toBe(uatSha);
      expect(git(cx, 'status', '--porcelain')).toBe('');
      expect(git(cx, 'branch', '--show-current')).toBe('main');

      // 2. The verified rollback: its passkey gate executes against the real supervisor too.
      const rollbackBefore = git(aoc, 'rev-parse', 'main');
      await approve(await openCard('rollback', () => true));
      const executed = await waitFor('rollback.executed', () => events().find((e) => e.type === 'rollback.executed') ?? null, 120_000, 500);
      expect(executed.meta.mainShaBefore).toBe(rollbackBefore);
      expect(git(aoc, 'rev-parse', 'main')).toBe(String(executed.meta.mainShaAfter));
      expect(git(aoc, 'status', '--porcelain')).toBe('');

      expect(events().filter((e) => e.type === 'promotion.refused' || e.type === 'promotion.failed' || e.type === 'rollback.failed')).toEqual([]);
      expect(events().filter((e) => e.type === 'selfmod.blocked')).toEqual([]);
    } catch (err) {
      kept = true;
      if (err instanceof Error) err.message += `\n\nkept ${dir}\n${diagnostics(layout.aocData, tokens.head.seq, log, gateTicket)}`;
      throw err;
    } finally {
      stopped = await stopChild(aocd, 'SIGTERM', 60_000);
      // A clean stop leaves nothing in its process group (it waits for its sidecars); this keeps a failed run from leaking.
      await groupExited(aocd.pid!, 20_000);
    }
    expect(stopped, log).toEqual({ code: 0, signal: null });
    expect(existsSync(trip.invoked)).toBe(false);
  }, 900_000);
});
