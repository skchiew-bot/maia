import { afterEach, describe, expect, it } from 'vitest';
import { createTestRuntime, type TestRuntime } from '@aoc/kernel';
import { createSessionsModule } from '../src';

const SESSIONS_TABLES = createSessionsModule().projectors![0]!.tables;

let t: TestRuntime;
afterEach(async () => t?.close());

const CLAUDE = '22222222-2222-4222-8222-222222222222';
const OBSERVED_CLAUDE = '33333333-3333-4333-8333-333333333333';

/** Every row of every sessions table, in a comparable order. */
function snapshot(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const table of SESSIONS_TABLES) {
    const rows = t.rt.store.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
    out[table] = rows.map((r) => JSON.stringify(r)).sort();
  }
  return out;
}

async function setup() {
  t = await createTestRuntime({ modules: [createSessionsModule({ sweepIntervalMs: 0 })] });
  const store = t.rt.store;
  // A person, a project and a session, each with its text in its own body scope, as the real writers record them.
  store.append({
    type: 'user.created',
    actor: { kind: 'system', id: 'identity' },
    scope: { userId: 'usr_aminah' },
    meta: { userId: 'usr_aminah', role: 'builder', complianceLead: false },
    payload: { name: 'Aminah binti Yusof' },
    source: 'system',
    bodyScope: 'user:usr_aminah',
  });
  store.append({
    type: 'project.created',
    actor: { kind: 'human', id: 'usr_aminah' },
    scope: { projectId: 'prj_claims' },
    meta: { projectId: 'prj_claims', slug: 'claims' },
    payload: { name: 'Claims for Aminah Yusof', repoPath: '/srv/repos/aminah-claims' },
    source: 'api',
  });
  store.append({
    type: 'session.launch_requested',
    actor: { kind: 'human', id: 'usr_aminah' },
    scope: { sessionId: 'ses_a', projectId: 'prj_claims' },
    meta: { sessionId: 'ses_a', projectId: 'prj_claims', threadId: 'thr_a', processType: 'discovery', model: 'claude-opus-5-5', readOnly: false, credentialProfile: null, ticketId: null, parentSessionId: null, phaseId: null },
    payload: { prompt: 'Look into the Yusof claim file\nand report', cwd: '/srv/repos/aminah-claims' },
    source: 'supervisor',
  });
  store.append({
    type: 'session.launched',
    actor: { kind: 'system', id: 'supervisor' },
    scope: { sessionId: 'ses_a' },
    meta: { sessionId: 'ses_a', claudeSessionId: CLAUDE, pid: 4242, model: 'claude-opus-5-5', turn: 1 },
    payload: { cwd: '/srv/repos/aminah-claims', argv: [], transcriptPath: '/home/aminah/.claude/t.jsonl' },
    source: 'supervisor',
  });
  const usage = await t.request('POST', '/ingest/usage', {
    headers: t.sidecarHeaders('ses_a'),
    body: {
      sessionId: 'ses_a',
      idempotencyKey: 'usage-batch-1',
      batches: [{ model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, messageIds: ['msg_one', 'msg_two'], firstAt: t.clock.iso(), lastAt: t.clock.iso(), contextTokens: 5 }],
    },
  });
  expect(usage.status).toBe(200);
  const observed = await t.request('POST', '/ingest/hook', {
    headers: t.ingestHeaders('observer'),
    body: {
      mode: 'observed',
      aocSessionId: null,
      hook: { session_id: OBSERVED_CLAUDE, hook_event_name: 'SessionStart', cwd: '/home/aminah/private-notes', transcript_path: '/home/aminah/.claude/o.jsonl' },
      sentAt: t.clock.iso(),
      idempotencyKey: 'observed-start-1',
    },
  });
  expect(observed.status).toBe(200);
}

const sessionsRow = (id: string) => t.rt.store.db.prepare('SELECT * FROM sess_sessions WHERE session_id = ?').get(id) as Record<string, unknown>;
const observedId = () => (t.rt.store.db.prepare("SELECT session_id FROM sess_sessions WHERE mode = 'observed'").get() as { session_id: string }).session_id;

describe('erasing a body scope scrubs the sessions projection (§13)', () => {
  it('a person\'s scope (user:<id>) removes their name from the session directory, and a rebuild agrees', async () => {
    await setup();
    const store = t.rt.store;
    expect(store.db.prepare("SELECT name FROM sess_users WHERE user_id = 'usr_aminah'").get()).toEqual({ name: 'Aminah binti Yusof' });
    store.eraseScope('user:usr_aminah', { actor: { kind: 'human', id: 'usr_dpo' }, reason: 'pdpa_request' });
    expect(store.db.prepare("SELECT name FROM sess_users WHERE user_id = 'usr_aminah'").get()).toEqual({ name: '[erased]' });
    const live = snapshot();
    store.rebuildProjections(['sessions']);
    expect(snapshot()).toEqual(live);
  });

  it('a project\'s scope removes its name and repository path, and a rebuild agrees', async () => {
    await setup();
    const store = t.rt.store;
    store.eraseScope('prj_claims', { actor: { kind: 'human', id: 'usr_dpo' }, reason: 'pdpa_request' });
    expect(store.db.prepare("SELECT name, repo_path FROM sess_projects WHERE project_id = 'prj_claims'").get()).toEqual({ name: '[erased]', repo_path: null });
    const live = snapshot();
    store.rebuildProjections(['sessions']);
    expect(snapshot()).toEqual(live);
  });

  it('a session\'s scope removes its title, paths and message ids, and a rebuild agrees', async () => {
    await setup();
    const store = t.rt.store;
    expect(store.db.prepare("SELECT count(*) AS n FROM sess_seen_messages WHERE session_id = 'ses_a'").get()).toEqual({ n: 2 });
    store.eraseScope('ses_a', { actor: { kind: 'human', id: 'usr_dpo' }, reason: 'secret_leak' });
    expect(sessionsRow('ses_a')).toMatchObject({ title: '[erased]', cwd: null, transcript_path: null });
    expect(store.db.prepare("SELECT count(*) AS n FROM sess_seen_messages WHERE session_id = 'ses_a'").get()).toEqual({ n: 0 });
    const live = snapshot();
    store.rebuildProjections(['sessions']);
    expect(snapshot()).toEqual(live);
  });

  it('an observed session\'s scope removes the directory name it was titled with, and a rebuild agrees', async () => {
    await setup();
    const store = t.rt.store;
    const id = observedId();
    expect(sessionsRow(id).title).toBe('Observed · private-notes');
    store.eraseScope(id, { actor: { kind: 'human', id: 'usr_dpo' }, reason: 'pdpa_request' });
    expect(sessionsRow(id)).toMatchObject({ title: '[erased]', cwd: null, transcript_path: null });
    const live = snapshot();
    store.rebuildProjections(['sessions']);
    expect(snapshot()).toEqual(live);
  });
});
