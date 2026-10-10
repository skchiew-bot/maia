import { afterEach, describe, expect, it } from 'vitest';
import type { SessionInfo } from '@aoc/contracts';
import { BOUNDARY_STOP_REASON, NO_MANIFEST_REASON } from '../src';
import { createHarness, PLAN, type Harness } from './harness';

let h: Harness;
afterEach(async () => h?.close());

const evaluate = (h: Harness, session: SessionInfo, toolName: string) =>
  h.t.rt.policy.evaluate({ session, mode: session.mode, toolName, toolInput: {}, cwd: '/work' });

describe('no-manifest guard (plan gate, §4)', () => {
  it('blocks every non-read-only tool, Bash included, until the plan is declared', async () => {
    h = await createHarness();
    const projectId = h.project();
    const s = h.session({ sessionId: 'ses_gate', projectId });

    for (const tool of [
      'Edit',
      'Write',
      'Bash',
      'NotebookEdit',
      'Task',
      'mcp__github__create_pull_request',
    ]) {
      const r = evaluate(h, s, tool);
      expect(r, tool).toMatchObject({ decision: 'deny', guard: 'no-manifest', blockReason: 'no_manifest' });
      expect(r.reason).toBe(NO_MANIFEST_REASON);
    }
    expect(NO_MANIFEST_REASON).toBe('Declare your plan with mcp__aoc__declare_plan first (AOC-SPEC-003 §4)');
    for (const tool of [
      'Read',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
      'ToolSearch',
      'mcp__aoc__declare_plan',
      'mcp__aoc__request_decision',
      'mcp__aoc__get_status',
    ]) {
      expect(evaluate(h, s, tool).decision, tool).toBe('allow');
    }

    await h.mcp('declare_plan', s.sessionId, PLAN);
    expect(evaluate(h, s, 'Edit').decision).toBe('allow');
    expect(evaluate(h, s, 'Bash').decision).toBe('allow');
  });

  it('abstains for process types that do not require a plan and for observed sessions', async () => {
    h = await createHarness();
    const projectId = h.project();
    const verify = h.session({ sessionId: 'ses_verify', projectId, processType: 'rollback-verify' });
    expect(evaluate(h, verify, 'Bash').decision).toBe('allow');
    const observed = h.session({ sessionId: 'ses_obs', projectId, mode: 'observed' });
    expect(evaluate(h, observed, 'Edit').decision).toBe('allow');
  });

  it('requires a plan when the registry is unavailable or the type is unknown', async () => {
    h = await createHarness({ withRegistry: false });
    const projectId = h.project();
    const s = h.session({ sessionId: 'ses_noreg', projectId, processType: 'rollback-verify' });
    expect(evaluate(h, s, 'Edit')).toMatchObject({ decision: 'deny', blockReason: 'no_manifest' });
  });
});

describe('boundary-stop guard (G-54, §5, §10, R7)', () => {
  const evidence = (n: number) => ({ kind: 'test', ref: `test/widget.test.ts > case ${n}` });
  const turnStarted = (sessionId: string, turn: number) =>
    h.t.rt.store.append({
      type: 'session.turn_started',
      actor: { kind: 'system', id: 'supervisor' },
      scope: { sessionId },
      meta: { sessionId, turn, reason: 'resume' },
      payload: {},
      source: 'supervisor',
    });

  it('after a task_done told the agent to stop, denies every tool call of the turn until the next turn starts', async () => {
    h = await createHarness();
    const projectId = h.project();
    const s = h.session({ sessionId: 'ses_stop', projectId, threadId: h.thread(projectId) });
    await h.mcp('declare_plan', 'ses_stop', PLAN);
    h.toolUsed('ses_stop');
    await h.mcp('task_done', 'ses_stop', { task_id: 't1', evidence: evidence(1) });
    expect(evaluate(h, s, 'Edit').decision).toBe('allow');

    h.supervisor.stops.add('ses_stop');
    h.toolUsed('ses_stop');
    await h.mcp('task_done', 'ses_stop', { task_id: 't2', evidence: evidence(2) });
    const delivered = h.t.rt.store.list({ sessionId: 'ses_stop', types: ['task.boundary_delivered'] });
    expect(delivered.map((e) => e.meta)).toEqual([
      { sessionId: 'ses_stop', taskId: 't2', reason: 'stop_requested' },
    ]);
    for (const tool of [
      'Edit',
      'Bash',
      'Read',
      'Grep',
      'mcp__aoc__task_done',
      'mcp__github__create_pull_request',
    ]) {
      const r = evaluate(h, s, tool);
      expect(r, tool).toMatchObject({
        decision: 'deny',
        guard: 'boundary-stop',
        reason: BOUNDARY_STOP_REASON,
      });
      expect(r.blockReason, tool).toBeUndefined();
    }
    // Observed sessions are never blocked by AOC.
    expect(evaluate(h, { ...s, mode: 'observed' }, 'Edit').decision).toBe('allow');

    turnStarted('ses_stop', 2);
    expect(evaluate(h, s, 'Edit').decision).toBe('allow');
  });

  it('a credit cap and a rollover stop the turn the same way; a boundary that continues does not', async () => {
    h = await createHarness();
    const projectId = h.project();
    const s = h.session({ sessionId: 'ses_cap', projectId, threadId: h.thread(projectId) });
    await h.mcp('declare_plan', 'ses_cap', PLAN);
    h.credits.next = {
      continue: false,
      reason: 'credit_cap',
      instruction: 'Credit cap reached; end your turn.',
    };
    h.toolUsed('ses_cap');
    await h.mcp('task_done', 'ses_cap', { task_id: 't1', evidence: evidence(1) });
    expect(evaluate(h, s, 'Bash')).toMatchObject({ decision: 'deny', guard: 'boundary-stop' });

    turnStarted('ses_cap', 2);
    h.credits.next = { continue: true };
    h.t.sessions!.context.set('ses_cap', 900_000);
    h.toolUsed('ses_cap');
    await h.mcp('task_done', 'ses_cap', { task_id: 't2', evidence: evidence(2) });
    expect(evaluate(h, s, 'Bash')).toMatchObject({ decision: 'deny', guard: 'boundary-stop' });
    expect(
      h.t.rt.store
        .list({ sessionId: 'ses_cap', types: ['task.boundary_delivered'] })
        .map((e) => e.meta.reason),
    ).toEqual(['credit_cap', 'rollover']);
  });
});
