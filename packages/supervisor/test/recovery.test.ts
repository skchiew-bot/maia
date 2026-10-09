import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AocConfigSchema,
  defaultConfig,
  transcriptPathFor,
  type DecisionCard,
  type DecisionService,
} from '@aoc/contracts';
import {
  AocRuntime,
  DevIdentityService,
  FakeClock,
  SimpleDecisionService,
  silentLogger,
  type AocModule,
  type ModuleContext,
} from '@aoc/kernel';
import { createSupervisorModule, type Supervisor } from '../src';
import { processMatches } from '../src/process-utils';
import { createHarness, FAKE_CLAUDE, SECRETS, StubLedger, StubRegistry, type Harness } from './harness';

let h: Harness | null = null;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  await h?.close();
  h = null;
  for (const c of cleanups.splice(0)) await c();
});

const waitUntil = async (pred: () => boolean, what: string, rt?: AocRuntime) => {
  const until = Date.now() + 10_000;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await rt?.drain();
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('startup recovery (§2.3: waiting survives reboots)', () => {
  it('marks lost turns Dead, interrupts verified orphans only, keeps waiting/throttled sessions and restarts queued launches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aoc-recovery-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const claudeConfig = join(root, 'claude');
    mkdirSync(claudeConfig);
    const env = { PATH: process.env.PATH, HOME: root, CLAUDE_CONFIG_DIR: claudeConfig };
    const config = AocConfigSchema.parse({
      dataDir: join(root, 'data'),
      supervisor: {
        claudeBin: process.execPath,
        claudeArgsPrefix: [FAKE_CLAUDE],
        mcpCommand: ['node', '/opt/aoc/mcp.js'],
        hookCommand: ['node', '/opt/aoc/hook.js'],
        workspacesDir: join(root, 'ws'),
        maxConcurrentSessions: 1,
        autoContinueLimit: 0,
        envAllowlist: defaultConfig().supervisor.envAllowlist,
      },
    });
    const clock = new FakeClock('2026-10-09T02:00:00.000Z');
    const masterKey = randomBytes(32);
    const ledger = new StubLedger();
    const actor = { kind: 'human' as const, id: 'usr_owner' };
    const stubs = (decisions: (ctx: ModuleContext) => DecisionService): AocModule => ({
      name: 'stubs',
      init(ctx) {
        ctx.services.provide('identity', new DevIdentityService(ctx.store));
        ctx.services.provide('registry', new StubRegistry());
        ctx.services.provide('ledger', ledger);
        ctx.services.provide('decisions', decisions(ctx));
      },
    });
    const boot = (decisions: Parameters<typeof stubs>[0]) =>
      AocRuntime.create({
        config,
        clock,
        log: silentLogger,
        masterKey,
        modules: [stubs(decisions), createSupervisorModule({ env, sessionsDir: join(root, 'sessions') })],
      });

    // ── first daemon life ──
    let simple: SimpleDecisionService | null = null;
    const rt1 = await boot(
      (ctx) =>
        (simple = new SimpleDecisionService(ctx.store, ctx.clock, () => ctx.services.maybe('identity'))),
    );
    const sup1 = rt1.services.get('supervisor') as Supervisor;
    const launch = async (prompt: string, threadId: string) =>
      (await sup1.launch({ processType: 'feature-build', projectId: 'prj_r', threadId, prompt }, actor))
        .sessionId;
    const gate = join(root, 'gate');
    const waiting = await launch(`[[fake:gated|gate=${gate}]] waits`, 'thr_w');
    simple!.request(
      {
        kind: 'agent_decision',
        test: 'ambiguity',
        title: 'Q',
        question: 'Which reading?',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
        subjectType: 'session',
        subjectId: waiting,
        sessionId: waiting,
        requesterId: actor.id,
      },
      { kind: 'agent', id: waiting },
    );
    writeFileSync(gate, 'go');
    await waitUntil(() => sup1.session(waiting)?.lifecycle === 'waiting_decision', 'waiting', rt1);
    const reset = Math.floor(clock.now() / 1000) + 86_400;
    const throttled = await launch(`[[fake:usage_limit|reset=${reset}]] throttled`, 'thr_t');
    await waitUntil(() => sup1.session(throttled)?.lifecycle === 'throttled', 'throttled', rt1);
    const lost = await launch('[[fake:hang,normal]] lost', 'thr_l');
    await waitUntil(
      () => !!sup1.output(lost)?.some((i) => i.text.startsWith('Session started')),
      'lost turn running',
      rt1,
    );
    const queued = await launch('queued after the crash', 'thr_q');
    expect(sup1.session(queued)?.lifecycle).toBe('launching');

    // An orphan that outlived the old daemon (verified by its claude session id) and a recycled pid (ours).
    const orphanUuid = randomUUID();
    const orphan = spawn(
      process.execPath,
      [
        FAKE_CLAUDE,
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--session-id',
        orphanUuid,
        '--model',
        'm',
        '--',
        '[[fake:hang]] orphan',
      ],
      {
        env: { CLAUDE_CONFIG_DIR: claudeConfig },
        cwd: root,
        detached: true,
        stdio: 'ignore',
      },
    );
    cleanups.push(() => void (orphan.exitCode === null && orphan.kill('SIGKILL')));
    await waitUntil(
      () =>
        existsSync(transcriptPathFor(realpathSync(root), orphanUuid, claudeConfig)) &&
        processMatches(orphan.pid!, orphanUuid),
      'orphan up',
    );
    const synthetic = (sessionId: string, pid: number, claudeSessionId: string) => {
      const scope = { sessionId, projectId: 'prj_r', threadId: `thr_${sessionId}` };
      rt1.store.appendMany([
        {
          type: 'session.launch_requested',
          actor,
          scope,
          meta: {
            sessionId,
            projectId: 'prj_r',
            threadId: scope.threadId,
            processType: 'feature-build',
            model: 'claude-opus-5-5',
            readOnly: false,
            credentialProfile: null,
            ticketId: null,
            parentSessionId: null,
            phaseId: null,
          },
          payload: { prompt: 'p', cwd: root },
          source: 'supervisor',
        },
        {
          type: 'session.lifecycle_changed',
          actor,
          scope,
          meta: { sessionId, from: null, to: 'launching', reason: 'launch_requested' },
          source: 'supervisor',
        },
        {
          type: 'session.turn_started',
          actor,
          scope,
          meta: { sessionId, turn: 1, reason: 'launch' },
          payload: {},
          source: 'supervisor',
        },
        {
          type: 'session.launched',
          actor,
          scope,
          meta: { sessionId, claudeSessionId, pid, model: 'claude-opus-5-5', turn: 1 },
          payload: { cwd: root, argv: [], transcriptPath: '/x' },
          source: 'supervisor',
        },
        {
          type: 'session.lifecycle_changed',
          actor,
          scope,
          meta: { sessionId, from: 'launching', to: 'running', reason: 'launch' },
          source: 'supervisor',
        },
      ]);
    };
    synthetic('ses_orphan', orphan.pid!, orphanUuid);
    synthetic('ses_recycled', process.pid, randomUUID());
    await rt1.stop(); // the daemon goes away; its running turn dies with it

    // ── second daemon life ──
    const openCard = { id: 'dec_open', status: 'open', sessionId: waiting } as DecisionCard;
    const rt2 = await boot(
      () =>
        ({
          list: (f?: { sessionId?: string; status?: string[] }) =>
            f?.sessionId === waiting && f.status?.includes('open') ? [openCard] : [],
          get: () => null,
        }) as unknown as DecisionService,
    );
    cleanups.push(() => rt2.stop());
    const sup2 = rt2.services.get('supervisor') as Supervisor;
    const lastLifecycle = (id: string) =>
      rt2.store.list({ sessionId: id, types: ['session.lifecycle_changed'] }).at(-1)!.meta;

    expect(lastLifecycle(lost)).toMatchObject({
      from: 'running',
      to: 'failed',
      reason: 'process_gone_on_restart',
    });
    expect(rt2.store.list({ sessionId: lost, types: ['session.turn_ended'] }).at(-1)!.meta).toMatchObject({
      turn: 1,
      outcome: 'crashed',
      exitCode: null,
    });
    expect(lastLifecycle('ses_orphan')).toMatchObject({ to: 'failed', reason: 'orphaned_on_restart' });
    await waitUntil(() => orphan.exitCode !== null || orphan.signalCode !== null, 'orphan interrupted');
    expect(lastLifecycle('ses_recycled')).toMatchObject({ to: 'failed', reason: 'process_gone_on_restart' });
    expect(sup2.session(waiting)?.lifecycle).toBe('waiting_decision');
    expect(sup2.session(throttled)?.lifecycle).toBe('throttled');
    await waitUntil(() => sup2.session(queued)?.lifecycle === 'idle', 'queued launch ran', rt2);
    expect(rt2.store.list({ sessionId: queued, types: ['session.turn_started'] })[0]!.meta).toMatchObject({
      turn: 1,
      reason: 'launch',
    });
    // a dead session restarts from its transcript after the reboot
    await sup2.restart(lost, actor);
    await waitUntil(() => sup2.session(lost)?.lifecycle === 'idle', 'restarted', rt2);
    expect(
      rt2.store.readPayload(rt2.store.list({ sessionId: lost, types: ['session.launched'] }).at(-1)!),
    ).toMatchObject({ argv: expect.arrayContaining(['--resume']) });
    expect(rt2.store.verifyChain().ok).toBe(true);
  });
});

describe('runIsolated (rollback verification / promotion)', () => {
  it('runs with path, locale and TZ only, plus the named credential profile, with a timeout', async () => {
    h = await createHarness();
    const node = (code: string) => [process.execPath, '-e', code];
    const r = await h.sup.runIsolated({
      cwd: h.root,
      command: node('console.log(JSON.stringify(process.env)); console.error("warn")'),
      credentialProfile: 'uat-deploy',
      timeoutMs: 5000,
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('warn\n');
    const env = JSON.parse(r.stdout) as Record<string, string>;
    expect(env.DEPLOY_TOKEN).toBe(SECRETS.uatDeploy);
    expect(env.TZ).toBe('Asia/Kuala_Lumpur');
    for (const k of ['DEPLOY_KEY', 'AOC_MASTER_KEY', 'GIT_PUSH_TOKEN', 'AOC_SESSION_ID', 'AOC_INGEST_TOKEN'])
      expect(env[k], k).toBeUndefined();
    expect(env.PATH).toBe(h.env.PATH);
    expect(env.LANG).toBe('C.UTF-8');
    // Nothing of aocd's account or of the session allowlist: no HOME, no Claude config, no test-only variables.
    for (const k of ['HOME', 'CLAUDE_CONFIG_DIR', 'FAKE_CLAUDE_LOG']) expect(env[k], k).toBeUndefined();

    const plain = await h.sup.runIsolated({
      cwd: h.root,
      command: node('console.log(process.env.DEPLOY_TOKEN ?? "none"); process.exit(3)'),
      credentialProfile: null,
      timeoutMs: 5000,
    });
    expect(plain).toMatchObject({ exitCode: 3, stdout: 'none\n' });
    const slow = await h.sup.runIsolated({
      cwd: h.root,
      command: node('setTimeout(() => {}, 10_000)'),
      credentialProfile: null,
      timeoutMs: 200,
    });
    expect(slow.exitCode).toBe(124);
    expect(slow.stderr).toContain('timed out after 200 ms');
    expect(
      (
        await h.sup.runIsolated({
          cwd: h.root,
          command: ['/nonexistent/aoc-binary'],
          credentialProfile: null,
          timeoutMs: 1000,
        })
      ).exitCode,
    ).toBe(127);
    await expect(
      h.sup.runIsolated({ cwd: h.root, command: node('1'), credentialProfile: 'prod-root', timeoutMs: 1000 }),
    ).rejects.toThrow(/not defined/);
    await expect(
      h.sup.runIsolated({
        cwd: 'relative/dir',
        command: node('1'),
        credentialProfile: null,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/absolute/);
  });
});

describe('session.ended is terminal for recovery', () => {
  it('never fails or resumes a session whose log says it ended, even without a lifecycle change to ended', async () => {
    const h = await createHarness();
    cleanups.push(() => h.t.close());
    const sessionId = 'ses_imported';
    const sys = { kind: 'system' as const, id: 'importer' };
    h.t.rt.store.appendMany([
      {
        type: 'session.launch_requested',
        actor: sys,
        scope: { sessionId, projectId: 'prj_x', threadId: 'thr_x' },
        meta: { sessionId, projectId: 'prj_x', threadId: 'thr_x', processType: 'feature-build', model: 'sonnet', readOnly: false, credentialProfile: null, ticketId: null, parentSessionId: null, phaseId: null },
        payload: { prompt: 'done long ago', cwd: h.root },
        source: 'supervisor',
      },
      {
        type: 'session.lifecycle_changed',
        actor: sys,
        scope: { sessionId },
        meta: { sessionId, from: 'launching', to: 'running', reason: 'launched' },
        source: 'supervisor',
      },
      { type: 'session.ended', actor: sys, scope: { sessionId }, meta: { sessionId, outcome: 'completed' }, source: 'supervisor' },
    ]);
    expect(h.sup.session(sessionId)?.lifecycle).toBe('ended');
    await h.sup.recover();
    expect(h.sup.session(sessionId)?.lifecycle).toBe('ended');
    const failed = h.t.rt.store
      .list({ types: ['session.lifecycle_changed'] })
      .filter((e) => e.meta.sessionId === sessionId && e.meta.to === 'failed');
    expect(failed).toEqual([]);
  });
});
