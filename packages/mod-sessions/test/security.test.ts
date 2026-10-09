import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestRuntime, type TestRuntime, type TestUser } from '@aoc/kernel';
import { createSessionsModule } from '../src';

const CLAUDE_A = '11111111-1111-4111-8111-111111111111';
let t: TestRuntime;
afterEach(async () => t?.close());

async function setup() {
  t = await createTestRuntime({ modules: [createSessionsModule({ sweepIntervalMs: 0 })] });
  return t;
}

function launch(owner: TestUser, sid = 'ses_A', claudeId = CLAUDE_A) {
  const s = t.rt.store;
  s.append({
    type: 'session.launch_requested',
    actor: { kind: 'human', id: owner.user.id },
    scope: { sessionId: sid, projectId: 'prj_1' },
    meta: { sessionId: sid, projectId: 'prj_1', threadId: 'thr_1', processType: 'discovery', model: 'claude-opus-5-5', readOnly: false, credentialProfile: null, ticketId: null, parentSessionId: null, phaseId: null },
    payload: { prompt: 'Build it', cwd: '/tmp/repo' },
    source: 'supervisor',
  });
  s.append({
    type: 'session.launched',
    actor: { kind: 'system', id: 'supervisor' },
    scope: { sessionId: sid },
    meta: { sessionId: sid, claudeSessionId: claudeId, pid: 4242, model: 'claude-opus-5-5', turn: 1 },
    payload: { cwd: '/tmp/repo', argv: [], transcriptPath: '/tmp/t.jsonl' },
    source: 'supervisor',
  });
}

const hook = (sid: string | null, claudeId: string, event: string, extra: Record<string, unknown> = {}, mode: 'managed' | 'observed' = 'managed') => ({
  mode,
  aocSessionId: sid,
  hook: { session_id: claudeId, transcript_path: '/tmp/t.jsonl', cwd: '/tmp/repo', hook_event_name: event, ...extra },
  sentAt: '2026-10-09T02:00:00.000Z',
  idempotencyKey: `key-${randomUUID()}`,
});

describe('observer tokens never write into managed sessions', () => {
  it('rejects observed-mode events that address a managed session by its claude session id', async () => {
    await setup();
    const owner = t.user('builder');
    launch(owner);
    const observer = t.ingestHeaders('observer');
    const before = t.rt.store.head().seq;
    const forged = [
      hook(null, CLAUDE_A, 'UserPromptSubmit', { prompt: 'forged supervisor prompt' }, 'observed'),
      hook(null, CLAUDE_A, 'PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '/tmp/repo/a.ts' }, tool_response: { ok: true } }, 'observed'),
      hook(null, CLAUDE_A, 'StopFailure', { error: 'rate_limit' }, 'observed'),
    ];
    for (const body of forged) {
      const res = await t.request('POST', '/ingest/hook', { headers: observer, body });
      expect(res.status).toBe(403);
    }
    // nor through a spool replay
    const spool = await t.json<{ accepted: number; rejected: number }>('POST', '/ingest/spool', {
      headers: observer,
      body: { items: forged.map((body) => ({ path: '/ingest/hook', body, queuedAt: t.clock.iso() })) },
    });
    expect(spool).toMatchObject({ accepted: 0, rejected: 3 });
    expect(t.rt.store.list({ fromSeq: before + 1 }).filter((e) => e.type !== 'session.liveness_changed')).toEqual([]);
  });
});
