/**
 * The real ledger against the real credits module (§10, R7): the hard cap is enforced only at task_done
 * boundaries, the first cap of a period auto-grants once, and any further need is a human top-up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type {
  BoundaryInstruction,
  CreditTopupRequest,
  MeteringService,
  StoredEvent,
  SupervisorService,
  TaskDoneResult,
} from '@aoc/contracts';
import { createTestRuntime, type TestRuntime, type TestUser } from '@aoc/kernel';
import { createCreditsModule } from '@aoc/mod-credits';
import { createLedgerModule } from '../src';
import { StubRegistry, StubSupervisor } from './harness';

/** 1 input token = 1 cent, so spending `usd` takes `usd * 100` tokens. */
const metering: MeteringService = {
  notionalCostUsd: (_model, u) => u.inputTokens / 100,
  fxRate: () => null,
  sessionCostUsd: () => 0,
  activeRateCardVersion: () => 1,
};

const PLAN = {
  summary: 'Build the widget store',
  phases: [
    {
      id: 'P1',
      name: 'Build',
      tasks: ['t1', 't2', 't3', 't4'].map((id) => ({ id, title: `Task ${id}`, size: 's' })),
    },
  ],
};

const CAP = {
  continue: false,
  reason: 'credit_cap',
  instruction:
    'Credit cap reached for 2026-10. Finish nothing new: end your turn now. Work resumes automatically after a top-up is approved.',
};

let t: TestRuntime;
let supervisor: StubSupervisor;
let dev: TestUser;
afterEach(async () => t?.close());

/** Ledger + credits on a $100 monthly allocation with the 25% once-per-period auto grant. */
async function boot(): Promise<void> {
  supervisor = new StubSupervisor();
  t = await createTestRuntime({
    modules: [createLedgerModule(), createCreditsModule()],
    services: {
      registry: new StubRegistry(),
      supervisor: supervisor as unknown as SupervisorService,
      metering,
    },
    config: { credits: { defaultMonthlyAllocationUsd: 100, autoGrantPct: 25 } },
  });
  dev = t.user('builder', 'Dev');
  const { projectId, threadId } = t.rt.services
    .get('ledger')
    .ensureThread({ projectId: 'prj_widgets', title: 'main' }, { kind: 'system', id: 'test' });
  t.sessions!.add({
    sessionId: 'ses_a',
    ownerId: dev.user.id,
    projectId,
    threadId,
    processType: 'feature-build',
  });
  await mcp('declare_plan', PLAN);
}

function mcp<T>(tool: string, input: unknown): Promise<T> {
  return t.json<T>('POST', `/ingest/mcp/${tool}`, {
    headers: t.ingestHeaders('ses_a'),
    body: { sessionId: 'ses_a', input },
  });
}

let message = 0;
/** A sidecar usage batch for the session costing `usd` at the stub rate. */
function spend(usd: number): void {
  const at = t.clock.iso();
  t.rt.store.append({
    type: 'usage.recorded',
    actor: { kind: 'system', id: 'sidecar' },
    scope: { sessionId: 'ses_a' },
    meta: {
      sessionId: 'ses_a',
      model: 'claude-opus-5-5',
      inputTokens: Math.round(usd * 100),
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      messages: 1,
      contextTokens: 1000,
      firstAt: at,
      lastAt: at,
    },
    payload: { messageIds: [`msg_${++message}`] },
    source: 'sidecar',
  });
}

/** Do the work (one file-changing tool call), then close the task through the MCP surface. */
async function close(taskId: string): Promise<BoundaryInstruction> {
  t.rt.store.append({
    type: 'tool.used',
    actor: { kind: 'agent', id: 'ses_a' },
    scope: { sessionId: 'ses_a' },
    meta: { sessionId: 'ses_a', toolName: 'Edit', fileChanging: true, ok: true, toolUseId: null },
    payload: { inputSummary: 'edit', filePaths: ['src/widgets.ts'] },
    source: 'hook',
  });
  const r = await mcp<TaskDoneResult>('task_done', {
    task_id: taskId,
    evidence: { kind: 'test', ref: `test/widgets.test.ts > ${taskId}` },
  });
  return r.boundary;
}

const events = (type: string): StoredEvent[] => t.rt.store.list({ types: [type] });
const creditTrail = () => t.rt.store.list({ typePrefix: 'credit.' }).map((e) => e.type);
const doneSeq = (taskId: string) => events('task.done').find((e) => e.meta.taskId === taskId)!.seq;

describe('credit cap at task boundaries: real ledger + real credits (§10, R7)', () => {
  it('first cap auto-grants 25% once; the second cap stops work at the boundary, and keeps stopping it', async () => {
    await boot();
    spend(60);
    expect(await close('t1')).toEqual({ continue: true });
    expect(creditTrail()).toEqual([]);

    spend(40); // balance exactly $0: exhausted
    expect(await close('t2')).toEqual({ continue: true });
    expect(creditTrail()).toEqual(['credit.cap_reached', 'credit.auto_granted']);
    expect(events('credit.auto_granted')[0]!.meta).toMatchObject({
      userId: dev.user.id,
      sessionId: 'ses_a',
      taskId: 't2',
      amountUsd: 25,
      balanceBefore: 0,
      balanceAfter: 25,
    });
    // The grant is the policy-resolved credit_topup decision, never a human's.
    expect(t.decisions!.list({ kind: ['credit_topup'] }).map((c) => c.resolution?.method)).toEqual([
      'policy',
    ]);

    spend(30); // the grant is spent as well: -$5
    expect(await close('t3')).toEqual(CAP);
    // Enforced at the boundary, never mid-task: the task was recorded done before the cap was checked.
    expect(t.rt.services.get('ledger').sessionProgress('ses_a')).toMatchObject({
      doneTasks: 3,
      totalTasks: 4,
    });
    const caps = events('credit.cap_reached');
    expect(caps.map((e) => [e.meta.taskId, e.meta.balanceUsd])).toEqual([
      ['t2', 0],
      ['t3', -5],
    ]);
    expect(caps.map((e) => e.seq > doneSeq(e.meta.taskId as string))).toEqual([true, true]);

    // An agent that carries on anyway meets the same cap at every later boundary: no AI repeat grant.
    spend(1);
    expect(await close('t4')).toEqual(CAP);
    expect(events('credit.auto_granted')).toHaveLength(1);
    expect(t.decisions!.list({ kind: ['credit_topup'] })).toHaveLength(1);
    expect(t.rt.services.get('credits').balance(dev.user.id)).toMatchObject({
      allocationUsd: 100,
      grantedUsd: 25,
      usedUsd: 131,
      balanceUsd: -6,
      autoGrantUsed: true,
    });
    expect(t.rt.store.verifyChain().ok).toBe(true);
  });

  it('only a human top-up lifts the second cap', async () => {
    await boot();
    const ceo = t.user('approver', 'CEO');
    spend(100);
    expect(await close('t1')).toEqual({ continue: true }); // auto grant
    spend(30);
    expect(await close('t2')).toEqual(CAP);

    const req = await t.json<CreditTopupRequest>('POST', '/api/credits/topup-requests', {
      headers: dev.headers,
      body: { amountUsd: 50, reason: 'Finish the widget store', sessionId: 'ses_a' },
      expect: 201,
    });
    expect(req).toMatchObject({ status: 'pending', taskId: 't2' });
    await t.decisions!.resolve(req.decisionId, { optionId: 'approve' }, ceo.user);
    await t.drain();
    expect(events('credit.topup_granted')[0]!.meta).toMatchObject({
      amountUsd: 50,
      balanceBefore: -5,
      balanceAfter: 45,
      approverId: ceo.user.id,
    });
    expect(await close('t3')).toEqual({ continue: true });
    expect(events('credit.auto_granted')).toHaveLength(1);
  });

  it('a stop request wins over the cap and does not spend the auto grant', async () => {
    await boot();
    spend(100);
    supervisor.stops.add('ses_a');
    expect(await close('t1')).toMatchObject({ continue: false, reason: 'stop_requested' });
    expect(creditTrail()).toEqual([]);
    supervisor.stops.clear();
    expect(await close('t2')).toEqual({ continue: true });
    expect(creditTrail()).toEqual(['credit.cap_reached', 'credit.auto_granted']);
  });
});
