import { statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HOOK_EVENTS, type Actor } from '@aoc/contracts';
import { createLogger, HttpError } from '@aoc/kernel';
import { createHarness, FAKE_SIDECAR, REPO_REGISTRY, SECRETS, type Harness } from './harness';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

describe('launch', () => {
  it('starts claude with the fixed argv, an allowlisted env, per-session files and the sidecar', async () => {
    const lines: string[] = [];
    h = await createHarness({ log: createLogger({ level: 'debug', sink: (l) => lines.push(l) }) });
    const id = await h.launch('Build the login page');
    await h.waitLifecycle(id, 'idle');

    // events (§2): launch_requested → launching → turn_started + launched + running
    const types = h.t.rt.store.list({ sessionId: id, typePrefix: 'session.' }).map((e) => e.type);
    expect(types.slice(0, 5)).toEqual([
      'session.launch_requested',
      'session.lifecycle_changed',
      'session.turn_started',
      'session.launched',
      'session.lifecycle_changed',
    ]);
    const requested = h.events('session.launch_requested', id)[0]!;
    expect(requested.meta).toMatchObject({
      processType: 'feature-build',
      model: 'claude-opus-5-5',
      readOnly: false,
      credentialProfile: 'git-feature',
      ownerId: h.owner.user.id,
      changeId: null,
    });
    const launched = h.events('session.launched', id)[0]!;
    const uuid = String(launched.meta.claudeSessionId);
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.events('session.turn_started', id)[0]!.meta).toMatchObject({ turn: 1, reason: 'launch' });

    // argv
    const [call] = h.callsFor(id);
    const dir = join(h.sessionsDir, id);
    expect(call!.argv).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--mcp-config',
      join(dir, 'mcp.json'),
      '--strict-mcp-config',
      '--settings',
      join(dir, 'settings.json'),
      '--permission-mode',
      'acceptEdits',
      '--append-system-prompt',
      h.file(id, 'system-prompt.md'),
      '--allowedTools',
      'mcp__aoc',
      'Bash',
      '--session-id',
      uuid,
      '--model',
      'claude-opus-5-5',
      '--',
      'Build the login page',
    ]);
    expect(call!.cwd).toBe(join(h.t.config.supervisor.workspacesDir, 'prj_demo'));

    // env: allowlist + AOC_* + the type's credential profile; aocd secrets never leak (§3, R1)
    const env = call!.env;
    expect(env).toMatchObject({
      HOME: h.env.HOME,
      LANG: 'C.UTF-8',
      CLAUDE_CONFIG_DIR: h.env.CLAUDE_CONFIG_DIR,
      TZ: 'Asia/Kuala_Lumpur',
      GIT_PUSH_TOKEN: SECRETS.gitFeature,
    });
    expect(env).toMatchObject({
      AOC_SESSION_ID: id,
      AOC_PROJECT_ID: 'prj_demo',
      AOC_DAEMON_URL: 'http://localhost:7420',
      AOC_MODE: 'managed',
      AOC_READ_ONLY: '0',
    });
    expect(env.AOC_THREAD_ID).toBe(String(requested.meta.threadId));
    expect(h.t.identity!.verifyIngestToken(env.AOC_INGEST_TOKEN!)).toMatchObject({
      kind: 'session',
      sessionId: id,
    });
    for (const leaked of ['DEPLOY_KEY', 'AOC_MASTER_KEY', 'DEPLOY_TOKEN', 'AOC_CHANGE_ID', 'AOC_TICKET_ID'])
      expect(env[leaked], leaked).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(SECRETS.aocdDeployKey);
    expect(JSON.stringify(env)).not.toContain(SECRETS.aocdMasterKey);

    // per-session files
    const mcp = JSON.parse(h.file(id, 'mcp.json'));
    expect(mcp.mcpServers.aoc).toMatchObject({
      command: 'node',
      args: ['/opt/aoc/mcp-server.js'],
      alwaysLoad: true,
    });
    expect(mcp.mcpServers.aoc.env).toMatchObject({
      AOC_SESSION_ID: id,
      AOC_DAEMON_URL: 'http://localhost:7420',
      AOC_INGEST_TOKEN: env.AOC_INGEST_TOKEN,
      AOC_PROJECT_ID: 'prj_demo',
      AOC_THREAD_ID: env.AOC_THREAD_ID,
    });
    expect(statSync(join(dir, 'mcp.json')).mode & 0o777).toBe(0o600);
    const settings = JSON.parse(h.file(id, 'settings.json'));
    expect(Object.keys(settings.hooks).sort()).toEqual([...HOOK_EVENTS].sort());
    expect(settings.hooks.PreToolUse[0]).toEqual({
      matcher: '',
      hooks: [{ type: 'command', command: 'node /opt/aoc/aoc-hook.js PreToolUse', timeout: 30 }],
    });
    const prompt = h.file(id, 'system-prompt.md');
    for (const s of [
      'declare_plan',
      'task_done',
      'request_decision',
      'END YOUR TURN',
      `AOC-Session: ${id}`,
      'Run the package tests before task_done',
    ])
      expect(prompt).toContain(s);
    expect(h.learning.applied).toEqual([{ lessonIds: ['les_tests'], sessionId: id }]);

    // sidecar: pid + transcript of this turn; the token travels in its env, not argv
    await h.waitFor(() => h!.sidecarCalls().length === 1, 'sidecar');
    const sc = h.sidecarCalls()[0]!;
    expect(sc.args.slice(0, 8)).toEqual([
      '--session',
      id,
      '--pid',
      String(launched.meta.pid),
      '--transcript',
      h.payload(launched)!.transcriptPath,
      '--daemon',
      'http://localhost:7420',
    ]);
    expect(String(h.payload(launched)!.transcriptPath)).toMatch(new RegExp(`/projects/.+/${uuid}\\.jsonl$`));
    expect(sc.env.AOC_INGEST_TOKEN).toBe(env.AOC_INGEST_TOKEN);
    expect(sc.env.GIT_PUSH_TOKEN).toBeUndefined();
    expect(sc.args).not.toContain(env.AOC_INGEST_TOKEN);

    // liveness signals, writer lock, credit boundary at launch, and no secret ever logged
    expect(h.liveness.processes[0]).toMatchObject({ sessionId: id, alive: true });
    expect(h.liveness.activity.filter((s) => s === id).length).toBeGreaterThan(3);
    expect(h.ledger.writerCalls).toContain(`acquire ${id}`);
    expect(h.credits.calls).toContain(`${id}:null`);
    const logged = lines.join('\n');
    for (const secret of [...Object.values(SECRETS), env.AOC_INGEST_TOKEN!])
      expect(logged).not.toContain(secret);
    expect(logged).toContain('GIT_PUSH_TOKEN'); // names only
  });

  it('gives read-only types no credentials, a restricted tool set and no writer lock', async () => {
    h = await createHarness();
    const a = await h.launch('Diagnose ticket 9', { processType: 'bug-triage', threadId: 'thr_shared' });
    const b = await h.launch('Diagnose ticket 9 (second opinion)', {
      processType: 'bug-triage',
      threadId: 'thr_shared',
    });
    await h.waitLifecycle(a, 'idle');
    await h.waitLifecycle(b, 'idle');
    const call = h.callsFor(a)[0]!;
    expect(call.env.GIT_PUSH_TOKEN).toBeUndefined();
    expect(call.env.AOC_READ_ONLY).toBe('1');
    const args = call.argv;
    expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2)).toEqual([
      '--permission-mode',
      'dontAsk',
    ]);
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual([
      '--tools',
      'Read,Glob,Grep',
    ]);
    const deny = args.slice(args.indexOf('--disallowedTools') + 1, args.indexOf('--session-id'));
    expect(deny).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write', 'NotebookEdit']));
    expect(h.events('session.launch_requested', a)[0]!.meta).toMatchObject({
      readOnly: true,
      credentialProfile: null,
    });
    expect(h.ledger.writerCalls).toEqual([]);
    expect(h.file(a, 'system-prompt.md')).toContain('READ-ONLY');
  });

  it("exports the change and ticket a session works under to that session's env only, on every turn", async () => {
    h = await createHarness();
    const id = await h.launch('Fix the export', { changeId: 'chg_7', ticketId: 'tkt_9' });
    const other = await h.launch('Unrelated work', { threadId: 'thr_other' });
    await h.waitLifecycle(id, 'idle');
    await h.waitLifecycle(other, 'idle');
    expect(h.events('session.launch_requested', id)[0]!.meta).toMatchObject({
      changeId: 'chg_7',
      ticketId: 'tkt_9',
      ownerId: h.owner.user.id,
    });
    expect(h.callsFor(id)[0]!.env).toMatchObject({ AOC_CHANGE_ID: 'chg_7', AOC_TICKET_ID: 'tkt_9' });
    expect(JSON.parse(h.file(id, 'mcp.json')).mcpServers.aoc.env).toMatchObject({ AOC_CHANGE_ID: 'chg_7' });
    expect(h.callsFor(other)[0]!.env.AOC_CHANGE_ID).toBeUndefined();
    expect(h.callsFor(other)[0]!.env.AOC_TICKET_ID).toBeUndefined();
    // Later turns are planned from the projection, so they keep it.
    await h.sup.resume(id, 'Also cover CSV', 'operator_prompt', h.ownerActor);
    await h.waitFor(() => h!.callsFor(id).length >= 2, 'the operator turn');
    expect(h.callsFor(id)[1]!.env).toMatchObject({ AOC_CHANGE_ID: 'chg_7', AOC_TICKET_ID: 'tkt_9' });
  });

  it('projects the recorded owner; launches logged before ownerId existed keep the old inference', async () => {
    h = await createHarness();
    const supervisor = { kind: 'system', id: 'supervisor' } as const;
    const requested = (sessionId: string, actor: Actor, meta: Record<string, unknown>) =>
      h!.t.rt.store.append({
        type: 'session.launch_requested',
        actor,
        scope: { sessionId, projectId: 'prj_demo', threadId: `thr_${sessionId}` },
        meta: {
          sessionId,
          projectId: 'prj_demo',
          threadId: `thr_${sessionId}`,
          processType: 'feature-build',
          model: 'claude-opus-5-5',
          readOnly: false,
          credentialProfile: null,
          ticketId: null,
          parentSessionId: null,
          phaseId: null,
          ...meta,
        },
        payload: { prompt: 'p', cwd: '/tmp' },
        source: 'supervisor',
      });
    requested('ses_old_a', h.ownerActor, {}); // legacy: the launching human
    requested('ses_old_b', supervisor, { parentSessionId: 'ses_old_a' }); // legacy: the parent's owner
    requested('ses_new_c', supervisor, { parentSessionId: 'ses_old_a', ownerId: null }); // recorded: nobody
    requested('ses_new_d', h.ownerActor, { ownerId: 'usr_other', changeId: 'chg_1' }); // recorded wins over the actor
    const owners = () =>
      ['ses_old_a', 'ses_old_b', 'ses_new_c', 'ses_new_d'].map((id) => h!.sup.session(id)?.ownerId);
    expect(owners()).toEqual([h.owner.user.id, h.owner.user.id, null, 'usr_other']);
    expect(h.sup.session('ses_new_d')?.changeId).toBe('chg_1');
    h.t.rt.store.rebuildProjections(['supervisor']);
    expect(owners()).toEqual([h.owner.user.id, h.owner.user.id, null, 'usr_other']);
  });

  it('rejects an unknown process type with 422 (a requester cannot pick its own type or model)', async () => {
    h = await createHarness();
    const builder = h.owner.headers;
    const res = await h.t.request('POST', '/api/sessions', {
      headers: builder,
      body: { processType: 'opus-please', projectId: 'prj_demo', prompt: 'x' },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('unknown_process_type');
    const withModel = await h.t.request('POST', '/api/sessions', {
      headers: builder,
      body: { processType: 'docs', projectId: 'prj_demo', prompt: 'x', model: 'opus' },
    });
    expect(withModel.status).toBe(422);
    const requester = h.t.user('requester');
    expect(
      (
        await h.t.request('POST', '/api/sessions', {
          headers: requester.headers,
          body: { processType: 'docs', projectId: 'prj_demo', prompt: 'x' },
        })
      ).status,
    ).toBe(403);
    await expect(
      h.sup.launch({ processType: 'nope', projectId: 'prj_demo', prompt: 'x' }, h.ownerActor),
    ).rejects.toMatchObject({ status: 422 });
    expect(h.events('session.launch_requested')).toEqual([]);

    const ok = await h.t.json<{ sessionId: string }>('POST', '/api/sessions', {
      headers: builder,
      body: { processType: 'docs', projectId: 'prj_demo', prompt: 'Write docs' },
      expect: 201,
    });
    expect(h.events('session.launch_requested', ok.sessionId)[0]!.meta.model).toBe('claude-sonnet-5-5');
  });

  it('refuses a second writer on a thread (409) until the first one ends', async () => {
    h = await createHarness();
    const first = await h.launch('[[fake:hang]] long job', { threadId: 'thr_one' });
    const err = await h.launch('second writer', { threadId: 'thr_one' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({
      status: 409,
      code: 'writer_locked',
      details: { threadId: 'thr_one', holderSessionId: first },
    });
    expect(h.events('session.launch_requested').length).toBe(1);
    await h.sup.stop(first, true, h.ownerActor);
    await h.waitLifecycle(first, 'ended');
    const second = await h.launch('second writer', { threadId: 'thr_one' });
    await h.waitLifecycle(second, 'idle');
    expect(h.ledger.writerCalls).toEqual([
      `acquire ${first}`,
      `release ${first} stopped`,
      `acquire ${second}`,
    ]);
  });

  it('enforces the single writer even without a ledger (supervisor projection)', async () => {
    h = await createHarness({ ledger: false });
    const first = await h.launch('[[fake:hang]] job', { threadId: 'thr_local' });
    await expect(h.launch('another', { threadId: 'thr_local' })).rejects.toMatchObject({
      status: 409,
      code: 'writer_locked',
    });
    await h.sup.stop(first, true, h.ownerActor);
    await h.waitLifecycle(first, 'ended');
  });

  it('blocks at the launch credit boundary and starts the first turn when credits are topped up', async () => {
    h = await createHarness();
    h.credits.next = { continue: false, reason: 'credit_cap', instruction: 'Credit cap reached' };
    const id = await h.launch('Capped work');
    expect(h.lifecycle(id)).toBe('blocked');
    expect(h.events('session.launched', id)).toEqual([]);
    h.credits.next = { continue: true };
    const topup = h.t.rt.store.append({
      type: 'credit.topup_granted',
      actor: { kind: 'human', id: 'usr_ceo' },
      meta: {
        requestId: 'tpu_1',
        userId: h.owner.user.id,
        amountUsd: 50,
        approverId: 'usr_ceo',
        balanceBefore: 0,
        balanceAfter: 50,
        decisionId: 'dec_t',
      },
      source: 'api',
    });
    await h.waitLifecycle(id, 'idle');
    const started = h.events('session.turn_started', id)[0]!;
    expect(started.meta).toMatchObject({ turn: 1, reason: 'topup' });
    expect(started.causationId).toBe(topup.id);
    const call = h.callsFor(id)[0]!;
    expect(call.argv).toContain('--session-id');
    expect(call.prompt).toBe('Capped work');
  });

  it('queues launches beyond maxConcurrentSessions and starts them FIFO', async () => {
    h = await createHarness({ supervisor: { maxConcurrentSessions: 1 } });
    const a = await h.launch('[[fake:hang]] A', { threadId: 'thr_a' });
    const b = await h.launch('B', { threadId: 'thr_b' });
    const c = await h.launch('C', { threadId: 'thr_c' });
    expect([h.lifecycle(b), h.lifecycle(c)]).toEqual(['launching', 'launching']);
    expect(h.sup.isRunning(a)).toBe(true);
    expect(h.events('session.launched', b)).toEqual([]);
    await h.sup.stop(a, true, h.ownerActor);
    await h.waitLifecycle(c, 'idle');
    const launches = h.events('session.launched').map((e) => e.meta.sessionId);
    expect(launches).toEqual([a, b, c]);
  });

  it('falls back to the validated registry file when mod-registry is absent', async () => {
    h = await createHarness({ registry: false, config: { registryFile: REPO_REGISTRY } });
    const id = await h.launch('Update the docs', { processType: 'docs' });
    expect(h.events('session.launch_requested', id)[0]!.meta.model).toBe('claude-sonnet-5-5');
    // discovery-class types run on opus whatever happens to budgets (§10, R8)
    const d = await h.launch('Explore', { processType: 'discovery', threadId: 'thr_d' });
    expect(h.events('session.launch_requested', d)[0]!.meta.model).toBe('claude-opus-5-5');
    await h.close();

    h = await createHarness({ registry: false, config: { registryFile: FAKE_SIDECAR } });
    await expect(h.launch('x', { processType: 'docs' })).rejects.toMatchObject({
      status: 503,
      code: 'registry_invalid',
    });
  });

  it('fails loudly without the AOC hook or MCP commands', async () => {
    h = await createHarness({ supervisor: { mcpCommand: [] } });
    await expect(h.launch('x')).rejects.toMatchObject({ status: 503, code: 'supervisor_not_configured' });
    expect(h.events('session.launch_requested')).toEqual([]);
  });
});
