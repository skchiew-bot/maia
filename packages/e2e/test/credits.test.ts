/**
 * (h) Credits (§10, R7): enforced only at task boundaries. A spent allocation is auto-granted once per period by policy
 * (a credit_topup decision resolved by policy); the next boundary is capped and the agent reads the STOP order through
 * the real MCP server; a top-up approved by another approver lifts it. Under the real supervisor, a launch over the
 * cap waits blocked without a process and the approval resumes it with its launch prompt.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CreditAccount, CreditTopupRequest, DecisionCardView } from '@aoc/contracts';
import { ClaudeSession } from './claude';
import { Harness, waitFor, type TestUser } from './harness';
import { launchSim, outcomesOf, turnsOf, untilSession } from './sim';

const account = (h: Harness, as: TestUser) => h.api<CreditAccount>('GET', '/api/credits/me', { as });

/** One Opus message of `output` tokens ($20/MTok), flushed by stopping the sidecar (SIGTERM flushes), then a new one. */
async function spend(h: Harness, claude: ClaudeSession, output: number): Promise<void> {
  const id = claude.transcript.assistant({ output }, [{ type: 'text', text: 'Rewriting the engine.' }]);
  await claude.sidecarProc!.stop();
  await waitFor(
    () =>
      h
        .events({ types: ['usage.recorded'], sessionId: claude.sessionId })
        .some((e) => (h.store.readPayload(e) as { messageIds: string[] }).messageIds.includes(id)),
    { what: 'usage flushed by the stopping sidecar' },
  );
  claude.startSidecar();
}

describe('(h) credit cap at task boundaries, through the MCP server', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await Harness.start();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('spent allocation → policy auto-grant → next boundary capped → STOP order → top-up approved by another approver', async () => {
    const dev = await h.user('builder', 'Farid');
    const ceo = await h.user('approver', 'CEO');
    const { projectId } = await h.project(dev, 'Rules Engine');
    const { period } = await account(h, dev);

    // Allocations are set by an approver, never for themselves (separation of duties, §6).
    await h.api('POST', '/api/credits/allocations', { as: ceo, body: { userId: ceo.user.id, period, amountUsd: 1_000 }, expect: 403 });
    expect(await h.api<CreditAccount>('POST', '/api/credits/allocations', { as: ceo, body: { userId: dev.user.id, period, amountUsd: 1 }, expect: 201 })).toMatchObject({
      allocationUsd: 1,
      allocationSource: 'allocated',
      balanceUsd: 1,
      autoGrantAvailableUsd: 0.25,
      capped: false,
    });

    const s = await h.launch(dev, { projectId, processType: 'feature-build' });
    const claude = new ClaudeSession(h, s);
    claude.startSidecar();
    await claude.start();
    const plan = await claude.aoc('declare_plan', {
      summary: 'Rewrite the rules engine',
      phases: [
        {
          id: 'p1',
          name: 'Engine',
          tasks: [
            { id: 't1', title: 'Rewrite the tokenizer', size: 'm' },
            { id: 't2', title: 'Rewrite the parser', size: 'm' },
            { id: 't3', title: 'Rewrite the evaluator', size: 'm' },
          ],
        },
      ],
    });
    expect(plan.isError).toBe(false);

    // $1.10 spent: −$0.10, but the unused auto grant would lift it, so the next boundary does not stop work.
    await spend(h, claude, 55_000);
    expect(await account(h, dev)).toMatchObject({ usedUsd: 1.1, balanceUsd: -0.1, capped: false });
    await claude.write('src/tokenizer.ts', 'export const tokenize = (src: string) => src.split(/\\s+/);\n');
    const t1 = await claude.aoc('task_done', { task_id: 't1', evidence: { kind: 'diff', ref: 'src/tokenizer.ts' } });
    expect(t1.data).toMatchObject({ ok: true, boundary: { continue: true } });
    expect(t1.text).not.toContain('STOP');

    // The first cap of the period is recorded, then auto-granted by policy: 25% of the original allocation, once.
    const [cap1] = h.events({ types: ['credit.cap_reached'], sessionId: s.sessionId });
    expect(cap1!.meta).toMatchObject({ userId: dev.user.id, taskId: 't1', balanceUsd: -0.1, period });
    const [auto] = h.events({ types: ['credit.auto_granted'] });
    expect(auto!.meta).toMatchObject({ userId: dev.user.id, amountUsd: 0.25, balanceBefore: -0.1, balanceAfter: 0.15, sessionId: s.sessionId, taskId: 't1' });
    expect(auto!.causationId).toBe(cap1!.id);
    const policy = await h.api<DecisionCardView>('GET', `/api/decisions/${String(auto!.meta.decisionId)}`, { as: ceo });
    expect(policy).toMatchObject({ kind: 'credit_topup', status: 'resolved', requesterId: dev.user.id, sessionId: s.sessionId });
    expect(policy.resolution).toMatchObject({ optionId: 'approve', method: 'policy' });
    expect(await account(h, dev)).toMatchObject({
      grantedUsd: 0.25,
      balanceUsd: 0.15,
      autoGrantUsed: true,
      autoGrantAvailableUsd: 0,
      capped: false,
      grants: [{ kind: 'auto', amountUsd: 0.25, approverId: null, decisionId: policy.id, taskId: 't1' }],
    });

    // $0.20 more: −$0.05 with the auto grant spent. The task still closes (never cut mid-task), then STOP.
    await spend(h, claude, 10_000);
    expect(await account(h, dev)).toMatchObject({ usedUsd: 1.3, balanceUsd: -0.05, capped: true });
    await claude.write('src/parser.ts', 'export const parse = (tokens: string[]) => ({ type: "program", tokens });\n');
    const t2 = await claude.aoc('task_done', { task_id: 't2', evidence: { kind: 'diff', ref: 'src/parser.ts' } });
    expect(t2.isError).toBe(false);
    expect(t2.data).toMatchObject({ ok: true, progress: { doneTasks: 2, totalTasks: 3 } });
    expect(t2.data.boundary).toEqual({
      continue: false,
      reason: 'credit_cap',
      instruction: `Credit cap reached for ${period}. Finish nothing new: end your turn now. Work resumes automatically after a top-up is approved.`,
    });
    expect(t2.text).toContain(`STOP — AOC task boundary (credit_cap). Do not start another task.\nCredit cap reached for ${period}.`);
    expect(h.events({ types: ['credit.auto_granted'] })).toHaveLength(1);
    expect(h.events({ types: ['credit.cap_reached'], sessionId: s.sessionId }).map((e) => e.meta.taskId)).toEqual(['t1', 't2']);

    // A top-up: the requester can never approve it; another approver can, and the next boundary continues.
    const req = await h.api<CreditTopupRequest>('POST', '/api/credits/topup-requests', {
      as: dev,
      body: { amountUsd: 2, reason: 'Finish the evaluator', sessionId: s.sessionId },
      expect: 201,
    });
    expect(req).toMatchObject({ status: 'pending', amountUsd: 2, sessionId: s.sessionId, taskId: 't2' });
    expect((await account(h, dev)).pendingTopup).toMatchObject({ requestId: req.requestId, decisionId: req.decisionId });
    await h.api('POST', `/api/decisions/${req.decisionId}/resolve`, { as: dev, body: { optionId: 'approve' }, expect: 403 });
    await h.api('POST', `/api/decisions/${req.decisionId}/resolve`, { as: ceo, body: { optionId: 'approve', comment: 'Finish it.' } });
    const granted = await waitFor(() => h.events({ types: ['credit.topup_granted'] })[0], { what: 'the top-up grant' });
    expect(granted.meta).toMatchObject({ requestId: req.requestId, userId: dev.user.id, amountUsd: 2, approverId: ceo.user.id, balanceBefore: -0.05, balanceAfter: 1.95 });
    expect(await account(h, dev)).toMatchObject({ grantedUsd: 2.25, balanceUsd: 1.95, capped: false, pendingTopup: null });

    await claude.write('src/evaluate.ts', 'export const evaluate = (program: unknown) => program;\n');
    const t3 = await claude.aoc('task_done', { task_id: 't3', evidence: { kind: 'diff', ref: 'src/evaluate.ts' } });
    expect(t3.data).toMatchObject({ ok: true, boundary: { continue: true } });
    await claude.close();
    expect(h.store.verifyChain().ok).toBe(true);
  });
});

/** Spends after its only task closed, so the session completes and the spend lands with its turn-end flush. */
const BURN = {
  name: 'e2e-credit-burn',
  steps: [
    {
      kind: 'mcp',
      server: 'aoc',
      tool: 'declare_plan',
      args: { phases: [{ id: 'p1', name: 'Spike', tasks: [{ id: 't1', title: 'Spike the engine', size: 's' }] }] },
    },
    { kind: 'tool', name: 'Write', input: { file_path: 'docs/spike.md', content: '# Engine spike\n' } },
    { kind: 'mcp', server: 'aoc', tool: 'task_done', args: { task_id: 't1', evidence: { kind: 'diff', ref: 'docs/spike.md' } } },
    { kind: 'think', ms: 200, outputTokens: 70_000 },
    { kind: 'text', text: 'Spike written up.' },
    { kind: 'endTurn', final: true },
  ],
};

const WORK = {
  name: 'e2e-credit-work',
  steps: [
    {
      kind: 'mcp',
      server: 'aoc',
      tool: 'declare_plan',
      args: { phases: [{ id: 'p1', name: 'Engine', tasks: [{ id: 't1', title: 'Rewrite the tokenizer', size: 's' }] }] },
    },
    { kind: 'tool', name: 'Write', input: { file_path: 'src/tokenizer.ts', content: 'export const tokenize = (src: string) => src.split(/\\s+/);\n' } },
    { kind: 'mcp', server: 'aoc', tool: 'task_done', args: { task_id: 't1', evidence: { kind: 'diff', ref: 'src/tokenizer.ts' } } },
    { kind: 'text', text: 'Tokenizer rewritten.' },
    { kind: 'endTurn', final: true },
  ],
};

describe('(h) credit cap under the supervisor', () => {
  let h: Harness;
  const dir = mkdtempSync(join(tmpdir(), 'aoc-e2e-credits-'));
  const BURN_FILE = join(dir, 'burn.json');
  const WORK_FILE = join(dir, 'work.json');
  writeFileSync(BURN_FILE, JSON.stringify(BURN));
  writeFileSync(WORK_FILE, JSON.stringify(WORK));
  beforeAll(async () => {
    h = await Harness.start({ supervisor: 'real' });
  });
  afterAll(async () => {
    await h?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a launch over the cap waits blocked without a process; the approved top-up starts it with its launch prompt', async () => {
    const dev = await h.user('builder', 'Farid');
    const ceo = await h.user('approver', 'CEO');
    const { projectId } = await h.project(dev, 'Rules Engine');
    const { period } = await account(h, dev);
    await h.api('POST', '/api/credits/allocations', { as: ceo, body: { userId: dev.user.id, period, amountUsd: 1 }, expect: 201 });

    const first = await launchSim(h, dev, projectId, BURN_FILE);
    await untilSession(h, first, dev, (d) => d.lifecycle === 'ended', 'the spending session to complete');
    expect(h.events({ types: ['session.ended'], sessionId: first })[0]!.meta).toMatchObject({ outcome: 'completed' });
    // Even the unused auto grant cannot lift this balance above zero.
    const spent = await waitFor(async () => {
      const a = await account(h, dev);
      return a.usedUsd >= 1.4 && a;
    }, { timeout: 30_000, what: "the spend, from the sidecar's flush after the session ended" });
    expect(spent).toMatchObject({ capped: true, autoGrantUsed: false, autoGrantAvailableUsd: 0.25 });
    // ...and once that sidecar is done, the ended session's token is revoked.
    const mcpConfig = JSON.parse(readFileSync(join(h.root, 'sessions', first, 'mcp.json'), 'utf8')) as { mcpServers: { aoc: { env: Record<string, string> } } };
    const firstToken = mcpConfig.mcpServers.aoc.env.AOC_INGEST_TOKEN!;
    await waitFor(() => h.aoc.runtime.services.get('identity').verifyIngestToken(firstToken) === null, { timeout: 15_000, what: "the ended session's token revoked" });

    const second = await launchSim(h, dev, projectId, WORK_FILE);
    const blocked = await untilSession(h, second, dev, (d) => d.lifecycle === 'blocked', 'the launch to wait on the cap');
    expect(blocked.liveness?.state).toBe('waiting_on_you');
    expect(turnsOf(h, second)).toEqual([]);
    expect(h.events({ types: ['session.lifecycle_changed'], sessionId: second }).at(-1)!.meta).toMatchObject({ to: 'blocked', reason: 'credit_cap' });
    // The launch-time boundary spent the period's auto grant by policy, and it was not enough.
    const auto = h.events({ types: ['credit.auto_granted'] });
    expect(auto).toHaveLength(1);
    expect(auto[0]!.meta).toMatchObject({ userId: dev.user.id, amountUsd: 0.25, sessionId: second, taskId: null });
    expect(auto[0]!.meta.balanceAfter as number).toBeLessThanOrEqual(0);

    const req = await h.api<CreditTopupRequest>('POST', '/api/credits/topup-requests', {
      as: dev,
      body: { amountUsd: 5, reason: 'Finish the tokenizer rewrite', sessionId: second },
      expect: 201,
    });
    await h.api('POST', `/api/decisions/${req.decisionId}/resolve`, { as: dev, body: { optionId: 'approve' }, expect: 403 });
    await h.api('POST', `/api/decisions/${req.decisionId}/resolve`, { as: ceo, body: { optionId: 'approve' } });

    const done = await untilSession(h, second, dev, (d) => d.lifecycle === 'ended', 'the topped-up session to complete');
    expect(done.progress).toMatchObject({ doneTasks: 1, totalTasks: 1, pct: 100 });
    expect(h.events({ types: ['session.ended'], sessionId: second })[0]!.meta).toMatchObject({ outcome: 'completed' });
    // The supervisor resumed it on the grant; a conversation that never started replays its launch prompt.
    const granted = h.events({ types: ['credit.topup_granted'] })[0]!;
    expect(granted.meta).toMatchObject({ requestId: req.requestId, approverId: ceo.user.id, amountUsd: 5 });
    const turns = turnsOf(h, second);
    expect(turns.map((t) => t.reason)).toEqual(['topup']);
    expect(turns[0]!.text).toContain(`[[scenario:${WORK_FILE}]]`);
    expect(h.events({ types: ['session.turn_started'], sessionId: second })[0]!.causationId).toBe(granted.id);
    const argv = h.store.readPayload(h.events({ types: ['session.launched'], sessionId: second })[0]!) as { argv: string[] };
    expect(argv.argv).toContain('--session-id');
    expect(argv.argv).not.toContain('--resume');
    expect(outcomesOf(h, second)).toEqual(['end_turn']);
    expect((await account(h, dev)).capped).toBe(false);
    expect(h.store.verifyChain().ok).toBe(true);
  });
});
