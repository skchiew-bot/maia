import { afterEach, describe, expect, it } from 'vitest';
import type { TaskDoneResult } from '@aoc/contracts';
import { createHarness, PLAN, type Harness } from './harness';

let h: Harness;
afterEach(async () => h?.close());

const evidence = (n: number) => ({ kind: 'test', ref: `test/widget.test.ts > case ${n}` });

async function setup(processType = 'feature-build', plan: unknown = PLAN) {
  h = await createHarness();
  const projectId = h.project();
  const threadId = h.thread(projectId);
  h.session({ sessionId: 'ses_a', projectId, threadId, processType });
  await h.mcp('declare_plan', 'ses_a', plan);
  let n = 0;
  const close = async (taskId: string) => {
    h.toolUsed('ses_a');
    return (await h.mcp<TaskDoneResult>('task_done', 'ses_a', { task_id: taskId, evidence: evidence(n++) }))
      .boundary;
  };
  return { projectId, threadId, close };
}

describe('task boundary instructions (§5, §10, R7, R16)', () => {
  it('continues by default and asks credits at every boundary with the task and agent', async () => {
    const { close } = await setup();
    expect(await close('t1')).toEqual({ continue: true });
    expect(h.credits.calls).toEqual([
      { sessionId: 'ses_a', taskId: 't1', actor: { kind: 'agent', id: 'ses_a' } },
    ]);
  });

  it('stop requested beats credit cap beats rollover', async () => {
    const { close } = await setup();
    h.t.sessions!.context.set('ses_a', 900_000);
    h.credits.next = {
      continue: false,
      reason: 'credit_cap',
      instruction: 'Credit cap reached; end your turn.',
    };
    h.supervisor.stops.add('ses_a');
    expect(await close('t1')).toMatchObject({ continue: false, reason: 'stop_requested' });
    h.supervisor.stops.clear();
    expect(await close('t2')).toEqual({
      continue: false,
      reason: 'credit_cap',
      instruction: 'Credit cap reached; end your turn.',
    });
    h.credits.next = { continue: true };
    expect(await close('t3')).toEqual({ continue: true }); // nothing left to hand over
  });

  it('asks for a rollover when context crosses the process type threshold at a clean boundary', async () => {
    const { close } = await setup();
    h.t.sessions!.context.set('ses_a', 690_000); // 69% of the 1M opus window
    expect(await close('t1')).toEqual({ continue: true });
    h.t.sessions!.context.set('ses_a', 700_000);
    const b = await close('t2');
    expect(b).toMatchObject({ continue: false, reason: 'rollover' });
    expect(b.continue === false && b.instruction).toMatch(/70% of the window/);
  });

  it('never rolls over mid-operation: open playbook steps and half-applied phases of risky types', async () => {
    const plan = {
      phases: [
        { id: 'M1', name: 'Migrate', tasks: ['m1', 'm2'].map((id) => ({ id, title: id, size: 's' })) },
        { id: 'M2', name: 'Verify', tasks: [{ id: 'v1', title: 'v1', size: 's' }] },
      ],
    };
    const { close } = await setup('migration', plan);
    h.t.sessions!.context.set('ses_a', 900_000); // 90% ≥ migration's 85%
    expect(await close('m1')).toEqual({ continue: true }); // M1 half-applied
    expect(h.ledger.boundaryState('ses_a')).toEqual({
      atBoundary: false,
      reason: 'risky_mid_operation',
      openTasks: 2,
    });

    await h.mcp('playbook_step', 'ses_a', { step: 'backfill', state: 'started' });
    expect(await close('m2')).toEqual({ continue: true }); // phase done, but a step is still running
    expect(h.ledger.boundaryState('ses_a')).toMatchObject({
      atBoundary: false,
      reason: 'playbook_step_in_progress',
    });
    await h.mcp('playbook_step', 'ses_a', { step: 'backfill', state: 'done' });
    expect(h.ledger.boundaryState('ses_a')).toEqual({ atBoundary: true, reason: null, openTasks: 1 });

    h.toolUsed('ses_a');
    expect(h.ledger.boundaryState('ses_a')).toMatchObject({ atBoundary: false, reason: 'task_in_progress' });
  });

  it('does not roll over a session without a thread', async () => {
    h = await createHarness();
    const projectId = h.project();
    h.session({ sessionId: 'ses_a', projectId });
    await h.mcp('declare_plan', 'ses_a', PLAN);
    h.t.sessions!.context.set('ses_a', 990_000);
    h.toolUsed('ses_a');
    const r = await h.mcp<TaskDoneResult>('task_done', 'ses_a', { task_id: 't1', evidence: evidence(1) });
    expect(r.boundary).toEqual({ continue: true });
  });
});
