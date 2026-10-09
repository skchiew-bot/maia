/**
 * What an agent's own ingest token can make the platform record (§2, §3). Whatever a managed session sends must be a
 * clean 4xx or an event every later rebuild can replay: an accepted event that makes a projector throw degrades the
 * projection at once and then fails every rebuild on it, so aocd could not start again.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EVENT_CATALOG } from '@aoc/contracts';
import { createTestRuntime, type TestRuntime } from '@aoc/kernel';
import { createSessionsModule } from '../src';

let t: TestRuntime;
afterEach(async () => t?.close());

const CLAUDE = '55555555-5555-4555-8555-555555555555';

async function setup() {
  t = await createTestRuntime({ modules: [createSessionsModule({ sweepIntervalMs: 0 })] });
  const owner = t.user('builder');
  t.rt.store.append({
    type: 'session.launch_requested',
    actor: { kind: 'human', id: owner.user.id },
    scope: { sessionId: 'ses_h', projectId: 'prj_1' },
    meta: { sessionId: 'ses_h', projectId: 'prj_1', threadId: 'thr_1', processType: 'discovery', model: 'claude-opus-5-5', readOnly: false, credentialProfile: null, ticketId: null, parentSessionId: null, phaseId: null },
    payload: { prompt: 'Build it', cwd: '/tmp/repo' },
    source: 'supervisor',
  });
  t.rt.store.append({
    type: 'session.launched',
    actor: { kind: 'system', id: 'supervisor' },
    scope: { sessionId: 'ses_h' },
    meta: { sessionId: 'ses_h', claudeSessionId: CLAUDE, pid: 4242, model: 'claude-opus-5-5', turn: 1 },
    payload: { cwd: '/tmp/repo', argv: [], transcriptPath: '/tmp/t.jsonl' },
    source: 'supervisor',
  });
  return { headers: t.ingestHeaders('ses_h'), sidecar: t.sidecarHeaders('ses_h') };
}

const batch = (over: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5-5',
  inputTokens: 10,
  outputTokens: 20,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  messageIds: ['msg_1'],
  firstAt: '2026-10-09T02:00:00.000Z',
  lastAt: '2026-10-09T02:00:00.000Z',
  contextTokens: 100,
  ...over,
});
const usage = (b: Record<string, unknown>) => ({ sessionId: 'ses_h', idempotencyKey: `usage-${Math.random().toString(36).slice(2)}-xx`, batches: [b] });
const healthy = () => expect(t.rt.store.projectionHealth()).toEqual([]);

describe('ingest bodies that would poison the log are refused (§2)', () => {
  it('a usage batch with a timestamp that is not an instant, or a count that is not a count, is a 422 and writes nothing', async () => {
    const { sidecar: headers } = await setup();
    const before = t.rt.store.head().seq;
    const bad: Record<string, unknown>[] = [
      { lastAt: 'not-a-date-at-all' },
      { firstAt: 'Aminah binti Yusof 900101' },
      { lastAt: '2026-13-45T99:99:99Z' },
      { lastAt: '+275760-09-13T00:00:00.000Z' },
      { lastAt: 'Thu Oct 09 2026' },
      { inputTokens: 1.5 },
      { outputTokens: -1 },
      { cacheReadTokens: 1e21 },
      { messageIds: [''] },
      { messageIds: ['x'.repeat(5000)] },
    ];
    for (const over of bad) {
      const res = await t.request('POST', '/ingest/usage', { headers, body: usage(batch(over)) });
      expect(res.status, JSON.stringify(over)).toBe(422);
    }
    expect(t.rt.store.head().seq).toBe(before);
    healthy();
    // The same batch with proper values is recorded.
    expect((await t.request('POST', '/ingest/usage', { headers, body: usage(batch()) })).status).toBe(200);
    expect(t.rt.store.head().seq).toBe(before + 1);
  });

  it('every other client timestamp is checked as well: throttle reset, heartbeat, activity, process exit, spooled item', async () => {
    const { sidecar: headers } = await setup();
    const at = '2026-10-09T02:00:00.000Z';
    const cases: [string, unknown][] = [
      ['/ingest/throttle', { sessionId: 'ses_h', resetAt: 'tomorrow-ish', message: 'limit', source: 'stream' }],
      ['/ingest/heartbeat', { sessionId: 'ses_h', pid: 4242, alive: true, at, transcriptBytes: 1, lastTranscriptWriteAt: 'garbage-garbage' }],
      ['/ingest/heartbeat', { sessionId: 'ses_h', pid: 4242, alive: true, at: 'garbage-garbage', transcriptBytes: 1, lastTranscriptWriteAt: null }],
      ['/ingest/activity', { sessionId: 'ses_h', kind: 'stream', at: 'garbage-garbage' }],
      ['/ingest/process', { sessionId: 'ses_h', event: 'exited', exitCode: 0, signal: null, at: 'garbage-garbage' }],
      ['/ingest/spool', { items: [{ path: '/ingest/usage', body: {}, queuedAt: 'garbage-garbage' }] }],
    ];
    const before = t.rt.store.head().seq;
    for (const [path, body] of cases) expect((await t.request('POST', path, { headers, body })).status, path).toBe(422);
    expect(t.rt.store.head().seq).toBe(before);
    healthy();
  });

  it('a hook with the wrong fields is a 422, not a crash', async () => {
    const { headers } = await setup();
    const hook = (extra: Record<string, unknown>, event = 'PreToolUse') => ({
      mode: 'managed',
      aocSessionId: 'ses_h',
      hook: { session_id: CLAUDE, hook_event_name: event, cwd: '/tmp/repo', ...extra },
      sentAt: '2026-10-09T02:00:00.000Z',
      idempotencyKey: `hook-key-${Math.random().toString(36).slice(2)}`,
    });
    const cases = [
      hook({}), // no tool_name
      hook({ tool_name: 7 }),
      hook({ tool_name: 'Edit', tool_use_id: 7 }, 'PostToolUse'),
      hook({ tool_name: 'Edit', tool_input: 'a string' }, 'PostToolUse'),
      hook({ tool_name: '' }, 'PostToolUseFailure'),
    ];
    for (const body of cases) expect((await t.request('POST', '/ingest/hook', { headers, body })).status, JSON.stringify(body.hook)).toBe(422);
    // A prompt hook without a prompt, and a stop failure without anything, are recorded as empty rather than crashing.
    expect((await t.request('POST', '/ingest/hook', { headers, body: hook({}, 'UserPromptSubmit') })).status).toBe(200);
    expect((await t.request('POST', '/ingest/hook', { headers, body: hook({ error: 'rate_limit' }, 'StopFailure') })).status).toBe(200);
    healthy();
  });
});

describe('a log that already holds an unreadable timestamp still projects and rebuilds', () => {
  it('counts the batch on the day it arrived instead of failing the projector (logs written before ingest checked)', async () => {
    await setup();
    const store = t.rt.store;
    // The catalog now refuses an unparseable instant (zIso), so write the event the way those older logs hold it:
    // with the usage meta schema lifted for this one append.
    const def = EVENT_CATALOG.get('usage.recorded')! as { meta: z.ZodTypeAny };
    const strict = def.meta;
    def.meta = z.object({}).passthrough();
    try {
      store.append({
        type: 'usage.recorded',
        actor: { kind: 'agent', id: 'ses_h' },
        scope: { sessionId: 'ses_h' },
        meta: {
          sessionId: 'ses_h',
          model: 'claude-opus-5-5',
          inputTokens: 5,
          outputTokens: 7,
          cacheReadTokens: 0,
          cacheWrite5mTokens: 0,
          cacheWrite1hTokens: 0,
          messages: 1,
          contextTokens: 9,
          firstAt: 'not-a-date-at-all',
          lastAt: 'not-a-date-at-all',
        },
        payload: { messageIds: ['msg_legacy'] },
        source: 'sidecar',
      });
    } finally {
      def.meta = strict;
    }
    healthy();
    const row = () => store.db.prepare('SELECT date, output FROM sess_usage_daily WHERE session_id = ?').get('ses_h');
    expect(row()).toEqual({ date: '2026-10-09', output: 7 });
    expect(() => store.rebuildProjections()).not.toThrow();
    expect(row()).toEqual({ date: '2026-10-09', output: 7 });
    healthy();
  });
});
