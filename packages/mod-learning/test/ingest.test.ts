import { describe, expect, it } from 'vitest';
import type { RootCauseClassDTO } from '@aoc/contracts';
import { createTestRuntime } from '@aoc/kernel';
import { createLearningModule, LEARNING_TABLES } from '../src';
import {
  addSession,
  assignTo,
  createClass,
  errors,
  fileChange,
  learningRuntime,
  meteringStub,
  report,
  SYS,
  toolFailure,
} from './helpers';

describe('occurrence sources', () => {
  it('agent self-reports via POST /ingest/mcp/report_error (session token, ReportErrorInput)', async () => {
    const t = await learningRuntime();
    const h = t.user('builder').headers;
    addSession(t, 'ses_r', 'bug-fix', 'claude-sonnet-5-5', { projectId: 'prj_1' });
    const body = {
      sessionId: 'ses_r',
      input: {
        summary: 'pnpm install fails: lockfile out of date',
        fix: 'run pnpm install --no-frozen-lockfile',
        root_cause_class: 'tooling: lockfile drift',
        code_area: '/work/repo/packages/web/src',
      },
    };
    const post = (headers: Record<string, string> | undefined, b: unknown = body) =>
      t.request('POST', '/ingest/mcp/report_error', { headers, body: b });
    expect((await post(undefined)).status).toBe(401);
    expect((await post(t.ingestHeaders('ses_other'))).status).toBe(403); // a session may only report for itself
    expect((await post(t.ingestHeaders('observer'))).status).toBe(403);
    expect((await post(t.ingestHeaders('system'))).status).toBe(403);
    expect(
      (await post(t.ingestHeaders('ses_r'), { sessionId: 'ses_r', input: { summary: 'x' } })).status,
    ).toBe(422);

    const headers = t.ingestHeaders('ses_r');
    const first = await t.json<{ ok: boolean; error_id: string }>('POST', '/ingest/mcp/report_error', {
      headers,
      body: { ...body, idempotencyKey: 'k1' },
    });
    const retry = await t.json<{ ok: boolean; error_id: string }>('POST', '/ingest/mcp/report_error', {
      headers,
      body: { ...body, idempotencyKey: 'k1' },
    });
    expect(first.ok).toBe(true);
    expect(retry.error_id).toBe(first.error_id);
    const stored = t.rt.store.list({ types: ['error.observed'] });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.actor).toEqual({ kind: 'agent', id: 'ses_r' });
    expect(stored[0]!.source).toBe('mcp');

    const [e] = await errors(t, h);
    expect(e).toMatchObject({
      errorId: first.error_id,
      source: 'agent_report',
      priority: 'normal',
      processType: 'bug-fix',
      modelTier: 'sonnet',
      projectId: 'prj_1',
      codeArea: 'packages/web/src', // made repo-relative: absolute paths never reach the chain
      rootCauseHint: 'tooling: lockfile drift',
      fix: 'run pnpm install --no-frozen-lockfile',
      classId: null,
    });
    await t.close();
  });

  it('failed tool calls and rollbacks become occurrences, exactly once per source event (reactors are idempotent)', async () => {
    const mod = createLearningModule();
    const t = await createTestRuntime({ modules: [mod], services: { metering: meteringStub } });
    const h = t.user('builder').headers;
    addSession(t, 'ses_t', 'feature-build', 'claude-opus-5-5');
    toolFailure(
      t,
      'ses_t',
      '{"stdout":"","stderr":"Error: Cannot find module \'zod\'","interrupted":false}',
      '/work/repo/packages/api/src/index.ts',
    );
    fileChange(t, 'ses_t', '/work/repo/packages/api/src/index.ts'); // a successful call is not an error
    t.rt.store.append({
      type: 'change.started',
      actor: SYS,
      scope: { changeId: 'chg_1' },
      meta: { changeId: 'chg_1', sessionId: 'ses_t' },
      source: 'system',
    });
    t.rt.store.append({
      type: 'rollback.requested',
      actor: SYS,
      scope: { projectId: 'prj_1', changeId: 'chg_1' },
      meta: {
        rollbackId: 'rbk_1',
        projectId: 'prj_1',
        targetRef: 'v1.2.0',
        targetSha: 'abcdef1',
        changeId: 'chg_1',
      },
      payload: { reason: 'Checkout broke after release 1.3' },
      source: 'api',
    });
    const verified = (clean: boolean) =>
      t.rt.store.append({
        type: 'rollback.verified',
        actor: SYS,
        meta: {
          rollbackId: 'rbk_1',
          branch: 'rollback/rbk_1',
          testsPassed: 10,
          testsFailed: clean ? 0 : 2,
          clean,
          decisionId: null,
        },
        payload: { report: clean ? 'all green' : '2 acceptance tests failed: checkout total' },
        source: 'supervisor',
      });
    verified(false);
    verified(true);
    await t.drain();

    const list = await errors(t, h);
    expect(list).toHaveLength(3);
    const tool = list.find((e) => e.source === 'tool')!;
    expect(tool).toMatchObject({
      message: "Error: Cannot find module 'zod'",
      codeArea: 'packages/api/src',
      processType: 'feature-build',
      modelTier: 'opus',
      priority: 'normal',
    });
    const rollbacks = list.filter((e) => e.source === 'rollback');
    expect(rollbacks.find((e) => e.message === 'Checkout broke after release 1.3')).toMatchObject({
      priority: 'high',
      projectId: 'prj_1',
      processType: 'feature-build',
    });
    expect(rollbacks.find((e) => e.message.startsWith('2 acceptance tests failed'))).toMatchObject({
      priority: 'normal',
      projectId: 'prj_1',
    });

    // at-least-once delivery: replay every event through every reactor — nothing new is appended
    const before = t.rt.store.head().seq;
    for (const e of t.rt.store.list({ limit: 10_000 })) {
      for (const r of mod.reactors ?? [])
        if (r.handles.includes(e.type)) await r.react(e, t.rt.store.readPayload(e), t.rt.ctx);
    }
    await t.drain();
    expect(t.rt.store.head().seq).toBe(before);
    await t.close();
  });

  it('projections rebuild deterministically from the log, and erasure scrubs occurrence text but keeps the learning', async () => {
    const t = await learningRuntime();
    const h = t.user('builder').headers;
    addSession(t, 'ses_secret', 'bug-fix', 'claude-opus-5-5');
    const classId = await createClass(t, h, 'Credentials pasted into prompts', 'guardrail');
    await assignTo(
      t,
      h,
      report(t, 'auth failed with token sk-live-123456789', { sessionId: 'ses_secret' }),
      classId,
    );
    await assignTo(
      t,
      h,
      report(t, 'auth failed with token sk-live-987654321', { sessionId: 'ses_secret' }),
      classId,
    );

    const snapshot = () =>
      LEARNING_TABLES.map((tbl) =>
        JSON.stringify(t.rt.store.db.prepare(`SELECT * FROM ${tbl} ORDER BY rowid`).all()),
      );
    const live = snapshot();
    t.rt.store.rebuildProjections(['learning']);
    expect(snapshot()).toEqual(live);

    t.rt.store.eraseScope('ses_secret', { actor: SYS, reason: 'secret_leak' });
    const list = await errors(t, h);
    expect(list.every((e) => e.message === '[erased]' && e.template === null)).toBe(true);
    expect(JSON.stringify(list)).not.toContain('sk-live');
    const [cls] = await t.json<RootCauseClassDTO[]>('GET', '/api/learning/classes', { headers: h });
    expect(cls).toMatchObject({ classId, occurrences: 2, name: 'Credentials pasted into prompts' });
    t.rt.store.rebuildProjections(['learning']); // replay with shredded bodies degrades gracefully
    expect((await errors(t, h)).map((e) => e.message)).toEqual(['[erased]', '[erased]']);
    await t.close();
  });
});
