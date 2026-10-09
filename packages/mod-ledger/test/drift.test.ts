import { afterEach, describe, expect, it } from 'vitest';
import type { PlaybookStepResult } from '@aoc/contracts';
import { createHarness, type Harness } from './harness';

let h: Harness;
afterEach(async () => h?.close());

const drifts = (kind?: string) => h.events('drift.detected').filter((e) => !kind || e.meta.kind === kind);
const minutes = (n: number) => h.t.clock.advance(n * 60_000);
const evidence = { kind: 'test', ref: 'test/widget.test.ts > works' };

async function setup(plan: unknown, processType = 'feature-build') {
  h = await createHarness();
  const projectId = h.project();
  h.session({ sessionId: 'ses_a', projectId, processType });
  if (plan) await h.mcp('declare_plan', 'ses_a', plan);
  return projectId;
}

describe('drift detection', () => {
  it('off_plan_change: file changes with every task closed, deduplicated per 30 minutes', async () => {
    const projectId = await setup({
      phases: [{ id: 'P1', name: 'One', tasks: [{ id: 't1', title: 'only', size: 's' }] }],
    });
    h.toolUsed('ses_a');
    await h.t.drain();
    expect(drifts()).toHaveLength(0); // an open task covers it
    await h.mcp('task_done', 'ses_a', { task_id: 't1', evidence });

    h.toolUsed('ses_a', { toolName: 'Write' });
    h.toolUsed('ses_a', { toolName: 'Read', fileChanging: false });
    await h.t.drain();
    expect(drifts().map((e) => e.meta)).toEqual([
      { sessionId: 'ses_a', projectId, kind: 'off_plan_change', severity: 'medium', taskId: null },
    ]);
    expect(h.t.rt.store.readPayload(drifts()[0]!)).toMatchObject({
      detail: expect.stringMatching(/Write changed files while no declared task is open/),
    });

    minutes(10);
    h.toolUsed('ses_a');
    await h.t.drain();
    expect(drifts()).toHaveLength(1);
    minutes(21);
    h.toolUsed('ses_a');
    await h.t.drain();
    expect(drifts()).toHaveLength(2);
  });

  it('off_plan_change before any plan is high severity; not for plan-free types or observed sessions', async () => {
    await setup(null);
    h.session({
      sessionId: 'ses_verify',
      projectId: h.t.sessions!.get('ses_a')!.projectId!,
      processType: 'rollback-verify',
    });
    h.session({ sessionId: 'ses_obs', projectId: h.t.sessions!.get('ses_a')!.projectId!, mode: 'observed' });
    for (const s of ['ses_a', 'ses_verify', 'ses_obs']) h.toolUsed(s);
    await h.t.drain();
    expect(drifts().map((e) => [e.meta.sessionId, e.meta.severity])).toEqual([['ses_a', 'high']]);
  });

  it('scope_growth: amendments growing the plan weight more than 30% over the baseline', async () => {
    await setup({
      phases: [
        {
          id: 'P1',
          name: 'One',
          tasks: [
            { id: 't1', title: 'a', size: 'm' },
            { id: 't2', title: 'b', size: 'l' },
            { id: 't3', title: 'c', size: 's' },
          ],
        },
      ],
    });
    const add = (id: string, size: string) =>
      h.mcp('amend_plan', 'ses_a', { reason: `add ${id}`, add: [{ id, title: id, size, phaseId: 'P1' }] });
    await add('t4', 's'); // 10 → 12 (+20%)
    expect(drifts('scope_growth')).toHaveLength(0);
    await add('t5', 'm'); // → 15 (+50%)
    expect(drifts('scope_growth').map((e) => e.meta.severity)).toEqual(['medium']);
    await add('t6', 'xs'); // deduplicated within 30 min
    expect(drifts('scope_growth')).toHaveLength(1);
    minutes(31);
    await add('t7', 'l'); // → 21 (+110%)
    expect(drifts('scope_growth').map((e) => e.meta.severity)).toEqual(['medium', 'high']);
    expect(drifts('scope_growth')[0]!.causationId).toBe(h.events('plan.amended')[1]!.id);
  });

  it('playbook_deviation: steps outside the active playbook or out of order', async () => {
    await setup({ phases: [{ id: 'P1', name: 'One', tasks: [{ id: 't1', title: 'a', size: 'm' }] }] });
    h.registry.playbooks.set('feature-build', {
      playbookId: 'pbk_feat',
      processType: 'feature-build',
      version: 2,
      title: 'Feature playbook',
      status: 'approved',
      steps: [
        { id: 'design', title: 'Write the design note' },
        { id: 'implement', title: 'Implement' },
        { id: 'verify', title: 'Run the acceptance tests' },
      ],
    });
    const step = (s: string, state = 'started', playbook_id?: string) =>
      h.mcp<PlaybookStepResult>('playbook_step', 'ses_a', {
        step: s,
        state,
        ...(playbook_id ? { playbook_id } : {}),
      });

    expect(await step('design')).toEqual({ ok: true, stepId: 'design', deviation: null });
    expect(await step('Write the design note', 'done')).toEqual({
      ok: true,
      stepId: 'design',
      deviation: null,
    });
    const off = await step('deploy to prod');
    expect(off.deviation).toMatch(/not part of the active playbook pbk_feat/);
    expect(drifts('playbook_deviation')).toHaveLength(1);

    minutes(31);
    const skip = await step('verify');
    expect(skip).toMatchObject({
      stepId: 'verify',
      deviation: expect.stringMatching(/before step implement/),
    });
    expect(drifts('playbook_deviation')).toHaveLength(2);
    expect((await step('implement', 'skipped')).deviation).toBeNull();
    expect((await step('verify', 'done')).deviation).toBeNull();
    minutes(31);
    expect((await step('design', 'started', 'pbk_other')).deviation).toMatch(
      /active playbook for feature-build is pbk_feat/,
    );

    const reported = h.events('playbook.step_reported');
    expect(reported[0]!.meta).toEqual({
      sessionId: 'ses_a',
      playbookId: 'pbk_feat',
      state: 'started',
      projectId: expect.any(String),
      stepId: 'design',
      stepIndex: 0,
    });
    expect(reported[2]!.meta).toMatchObject({ stepId: null, stepIndex: null });
  });

  it('overrun: the current task open beyond its size budget of running session time', async () => {
    await setup({
      phases: [
        {
          id: 'P1',
          name: 'One',
          tasks: [
            { id: 'quick', title: 'quick', size: 'xs' },
            { id: 'long', title: 'long', size: 'l' },
          ],
        },
      ],
    });
    minutes(14);
    await h.t.rt.runJob('ledger.overrun-scan');
    expect(drifts('overrun')).toHaveLength(0);
    minutes(2); // 16 min > xs budget of 15
    h.toolUsed('ses_a', { toolName: 'Grep', fileChanging: false });
    await h.t.drain();
    expect(drifts('overrun').map((e) => e.meta)).toEqual([
      {
        sessionId: 'ses_a',
        projectId: expect.any(String),
        kind: 'overrun',
        severity: 'medium',
        taskId: 'quick',
      },
    ]);

    // Closing resets the clock for the next task (l: 120 min); a waiting session accrues no session time.
    h.toolUsed('ses_a');
    await h.mcp('task_done', 'ses_a', { task_id: 'quick', evidence });
    minutes(100);
    await h.t.rt.runJob('ledger.overrun-scan');
    expect(drifts('overrun')).toHaveLength(1);
    minutes(150);
    h.t.sessions!.get('ses_a')!.lifecycle = 'waiting_decision';
    await h.t.rt.runJob('ledger.overrun-scan');
    expect(drifts('overrun')).toHaveLength(1);
    h.t.sessions!.get('ses_a')!.lifecycle = 'running';
    await h.t.rt.runJob('ledger.overrun-scan');
    expect(drifts('overrun').map((e) => [e.meta.taskId, e.meta.severity])).toEqual([
      ['quick', 'medium'],
      ['long', 'high'],
    ]);
  });

  it('overrun counts session time only: waiting on a decision does not burn the budget', async () => {
    await setup({ phases: [{ id: 'P1', name: 'One', tasks: [{ id: 'a', title: 'a', size: 's' }] }] });
    const lifecycle = (from: 'running' | 'waiting_decision' | null, to: 'running' | 'waiting_decision') =>
      h.t.rt.store.append({
        type: 'session.lifecycle_changed',
        actor: { kind: 'system', id: 'supervisor' },
        scope: { sessionId: 'ses_a' },
        meta: { sessionId: 'ses_a', from, to, reason: 'test' },
        source: 'supervisor',
      });
    lifecycle(null, 'running');
    minutes(10);
    lifecycle('running', 'waiting_decision');
    minutes(50);
    lifecycle('waiting_decision', 'running');
    minutes(10); // 70 min of wall time, 20 min of session time (budget s = 30)
    await h.t.rt.runJob('ledger.overrun-scan');
    expect(drifts('overrun')).toHaveLength(0);
    minutes(11);
    await h.t.rt.runJob('ledger.overrun-scan');
    expect(drifts('overrun')).toHaveLength(1);
    expect(h.t.rt.store.readPayload(drifts('overrun')[0]!)).toMatchObject({
      detail: expect.stringMatching(/in progress for 31 min; its budget is 30 min/),
    });
  });
});
