/**
 * Supervisor-driven scenarios: the real mod-supervisor launches claude-sim (never the real claude CLI) with the real
 * hook, MCP-server and sidecar entries, against the real aocd — POST /api/sessions to completion, decisions answered
 * through the API, operator nudge / stop / restart, plan-limit throttles resumed by the throttle job, and context
 * rollover to a successor session on the same thread.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecisionCardView, DecisionListResponse, SessionDetail, StoredEvent } from '@aoc/contracts';
import { Harness, waitFor, type TestUser } from './harness';
import { launchSim, outcomesOf as simOutcomesOf, sessionDetail, turnsOf as simTurnsOf, untilSession } from './sim';

/** Predecessor of the rollover scenario: closes t1 and t2 with the context past 70% of the window, t3 left open. */
const ROLLOVER = {
  name: 'e2e-rollover',
  steps: [
    { kind: 'think', ms: 400, outputTokens: 200 },
    {
      kind: 'mcp',
      server: 'aoc',
      tool: 'declare_plan',
      args: {
        phases: [
          {
            id: 'p1',
            name: 'Port the reports',
            tasks: [
              { id: 't1', title: 'Inventory the reports', size: 's' },
              { id: 't2', title: 'Port report A', size: 'm' },
              { id: 't3', title: 'Port report B', size: 'm' },
            ],
          },
        ],
      },
    },
    { kind: 'tool', name: 'Write', input: { file_path: 'docs/inventory.md', content: '# Reports\n\n- A\n- B\n' } },
    { kind: 'mcp', server: 'aoc', tool: 'task_done', args: { task_id: 't1', evidence: { kind: 'diff', ref: 'docs/inventory.md' } } },
    { kind: 'contextGrowth', tokens: 740_000 },
    { kind: 'think', ms: 400, outputTokens: 300 },
    { kind: 'tool', name: 'Write', input: { file_path: 'src/report-a.ts', content: 'export const reportA = () => 1;\n' } },
    { kind: 'mcp', server: 'aoc', tool: 'task_done', args: { task_id: 't2', evidence: { kind: 'diff', ref: 'src/report-a.ts' } } },
    { kind: 'text', text: 'Report A is ported; ending the turn at this clean task boundary.' },
    { kind: 'endTurn' },
    { kind: 'text', text: 'The predecessor should have been rolled over.' },
    { kind: 'endTurn', final: true },
  ],
};

/** Every launch without a [[scenario:…]] marker — here only the rollover successor — runs this. */
const SUCCESSOR = {
  name: 'e2e-successor',
  steps: [
    { kind: 'mcp', server: 'aoc', tool: 'get_status', args: {} },
    {
      kind: 'mcp',
      server: 'aoc',
      tool: 'declare_plan',
      args: { phases: [{ id: 'p1', name: 'Port the reports', tasks: [{ id: 't3', title: 'Port report B', size: 'm' }] }] },
    },
    { kind: 'tool', name: 'Write', input: { file_path: 'src/report-b.ts', content: 'export const reportB = () => 2;\n' } },
    { kind: 'mcp', server: 'aoc', tool: 'task_done', args: { task_id: 't3', evidence: { kind: 'diff', ref: 'src/report-b.ts' } } },
    { kind: 'text', text: 'Report B is ported; the thread plan is complete.' },
    { kind: 'endTurn', final: true },
  ],
};

const scenarioDir = mkdtempSync(join(tmpdir(), 'aoc-e2e-scenarios-'));
const ROLLOVER_FILE = join(scenarioDir, 'rollover.json');
const SUCCESSOR_FILE = join(scenarioDir, 'successor.json');
writeFileSync(ROLLOVER_FILE, JSON.stringify(ROLLOVER));
writeFileSync(SUCCESSOR_FILE, JSON.stringify(SUCCESSOR));

let h: Harness;
beforeAll(async () => {
  h = await Harness.start({ supervisor: 'real', simEnv: { CLAUDE_SIM_SCENARIO: SUCCESSOR_FILE } });
});
afterAll(async () => {
  await h?.close();
  rmSync(scenarioDir, { recursive: true, force: true });
});

// ── helpers ─────────────────────────────────────────────────────────────────

const launch = (as: TestUser, projectId: string, scenario: string, processType?: string) => launchSim(h, as, projectId, scenario, processType);
const detail = (sessionId: string, as: TestUser) => sessionDetail(h, sessionId, as);
const until = (sessionId: string, as: TestUser, pred: (d: SessionDetail) => boolean, what: string, timeout?: number) =>
  untilSession(h, sessionId, as, pred, what, timeout);
const payload = (e: StoredEvent) => h.store.readPayload(e) as Record<string, unknown> | null;
const turnsOf = (sessionId: string) => simTurnsOf(h, sessionId);
const outcomesOf = (sessionId: string) => simOutcomesOf(h, sessionId);
const typesOf = (sessionId: string) => h.events({ sessionId }).map((e) => e.type);

// ── scenarios ───────────────────────────────────────────────────────────────

describe('supervisor + claude-sim: a managed session end to end', () => {
  it('POST /api/sessions → plan → task_done → request_decision → answered via the API → resumed with the answer → completed', async () => {
    const dev = await h.user('builder', 'Dev');
    const ceo = await h.user('approver', 'CEO');
    const { projectId } = await h.project(dev, 'Greeter');
    const sessionId = await launch(dev, projectId, 'decision');

    // Turn 1 ends cleanly on the open decision: waiting costs nothing (§2.3).
    const waiting = await until(sessionId, ceo, (d) => d.lifecycle === 'waiting_decision', 'the turn to end on the decision');
    expect(waiting).toMatchObject({ ownerId: dev.user.id, processType: 'feature-build', model: 'claude-opus-5-5', liveness: { state: 'waiting_on_you' } });
    const launched = h.events({ types: ['session.launched'], sessionId })[0]!;
    const argv = payload(launched)!.argv as string[];
    expect(argv.slice(-4)).toEqual(['--model', 'claude-opus-5-5', '--', '@prompt']);
    expect(argv).toEqual(expect.arrayContaining(['--allowedTools', 'mcp__aoc', '--strict-mcp-config', '--include-partial-messages']));
    const output = await h.api<{ items: { kind: string; text: string }[] }>('GET', `/api/sessions/${sessionId}/output`, { as: dev });
    expect(output.items.map((i) => i.text)).toContain('Session started · model claude-opus-5-5 · MCP aoc:connected');

    const open = await h.api<DecisionListResponse>('GET', `/api/decisions?sessionId=${sessionId}&status=open`, { as: ceo });
    expect(open.decisions).toHaveLength(1);
    const card = open.decisions[0]!;
    expect(card).toMatchObject({ kind: 'agent_decision', test: 'main', requiredRole: 'approver', requesterId: `session:${sessionId}` });
    expect(h.events({ types: ['task.done'], sessionId }).map((e) => e.meta.taskId)).toEqual(['t1']);

    // main bounces to the Approver; their answer resumes the session with it injected.
    expect((await h.request('POST', `/api/decisions/${card.id}/resolve`, { as: dev, body: { optionId: 'b' } })).status).toBe(403);
    await h.api<DecisionCardView>('POST', `/api/decisions/${card.id}/resolve`, { as: ceo, body: { optionId: 'b', comment: 'Release freeze until Monday.' } });

    const done = await until(sessionId, ceo, (d) => d.lifecycle === 'ended', 'the resumed session to complete');
    // between turns the session waited or idled; it was never Dead (per-turn sidecars and turn-end ordering)
    const states = h.events({ types: ['session.liveness_changed'], sessionId }).map((e) => e.meta.to);
    expect(states).toContain('waiting_on_you');
    expect(states).not.toContain('dead');
    expect(done.liveness?.state ?? null).toBeNull();
    expect(done.progress).toMatchObject({ doneTasks: 2, totalTasks: 2, pct: 100 });
    const turns = turnsOf(sessionId);
    expect(turns.map((t) => t.reason)).toEqual(['launch', 'decision_answered']);
    expect(turns[1]!.text).toContain(`Decision ${card.id} answered: Hold the merge. Release freeze until Monday.`);
    expect(outcomesOf(sessionId)).toEqual(['decision', 'end_turn']);
    // The answer reached the agent: it took the hold branch (t2 leaves the plan by an audited amendment).
    expect(h.events({ types: ['plan.amended'], sessionId }).map((e) => e.meta.removed)).toEqual([1]);
    expect(h.events({ types: ['task.done'], sessionId }).map((e) => e.meta.taskId)).toEqual(['t1', 't3']);
    expect(h.events({ types: ['session.ended'], sessionId }).map((e) => e.meta.outcome)).toEqual(['completed']);
    expect(typesOf(sessionId)).toEqual(expect.arrayContaining(['thread.writer_released', 'token.revoked', 'usage.recorded', 'prompt.submitted']));
    // The session's ingest token died with it.
    const issued = h.events({ types: ['token.issued'], sessionId })[0]!;
    expect(h.events({ types: ['token.revoked'] }).some((e) => e.meta.tokenId === issued.meta.tokenId)).toBe(true);
    expect(h.store.verifyChain().ok).toBe(true);
  });
});

describe('supervisor + claude-sim: operator controls', () => {
  it('nudge interrupts a stuck turn and resumes with the operator text; stop ends the session', async () => {
    const dev = await h.user('builder', 'Nudger');
    const { projectId } = await h.project(dev, 'Importer');
    const sessionId = await launch(dev, projectId, 'stall');
    // The stall scenario writes a file, then goes silent.
    await waitFor(() => h.events({ types: ['tool.used'], sessionId }).some((e) => e.meta.toolName === 'Write'), { timeout: 60_000, what: 'the Write before the stall' });

    await h.api('POST', `/api/sessions/${sessionId}/nudge`, { as: dev, body: { text: 'Skip the importer polish; write the tests first.' } });
    await waitFor(() => turnsOf(sessionId).length === 2, { timeout: 30_000, what: 'the nudge turn' });
    const turns = turnsOf(sessionId);
    expect(turns[1]).toMatchObject({ turn: 2, reason: 'nudge' });
    expect(turns[1]!.text).toContain('Skip the importer polish; write the tests first.');
    expect(outcomesOf(sessionId)[0]).toBe('interrupted');
    expect(h.events({ types: ['session.nudged'], sessionId })).toHaveLength(1);

    await h.api('POST', `/api/sessions/${sessionId}/stop`, { as: dev, body: { immediate: true, reason: 'Superseded' } });
    const ended = await until(sessionId, dev, (d) => d.lifecycle === 'ended', 'the stopped session to end', 30_000);
    expect(ended.liveness?.state ?? null).toBeNull();
    expect(h.events({ types: ['session.stop_requested'], sessionId }).map((e) => e.meta.immediate)).toEqual([true]);
    expect(h.events({ types: ['session.ended'], sessionId }).map((e) => e.meta.outcome)).toEqual(['killed']);
    expect(outcomesOf(sessionId)).toEqual(['interrupted', 'interrupted']);
    // A stopped session is no one's writer any more.
    expect(h.events({ types: ['thread.writer_released'], sessionId })).toHaveLength(1);
    expect(h.store.verifyChain().ok).toBe(true);
  });

  it('a crash shows Dead; restart resumes the transcript and the session finishes', async () => {
    const dev = await h.user('builder', 'Restarter');
    const other = await h.user('builder', 'Bystander');
    const { projectId } = await h.project(dev, 'Csv');
    const sessionId = await launch(dev, projectId, 'crash');

    const dead = await until(sessionId, dev, (d) => d.lifecycle === 'failed', 'the crashed session to fail');
    expect(dead.liveness?.state).toBe('dead');
    expect(outcomesOf(sessionId)).toEqual(['crashed']);
    expect(dead.actions.restart.enabled).toBe(true);
    // Only the owner (or an Approver) drives a session.
    expect((await h.request('POST', `/api/sessions/${sessionId}/restart`, { as: other })).status).toBe(403);

    await h.api('POST', `/api/sessions/${sessionId}/restart`, { as: dev });
    const done = await until(sessionId, dev, (d) => d.lifecycle === 'ended', 'the restarted session to complete');
    expect(done.progress).toMatchObject({ doneTasks: 2, totalTasks: 2, pct: 100 });
    expect(turnsOf(sessionId).map((t) => t.reason)).toEqual(['launch', 'restart']);
    expect(h.events({ types: ['session.restarted'], sessionId })).toHaveLength(1);
    // Restart resumed the same conversation (same claude session id, --resume).
    const launches = h.events({ types: ['session.launched'], sessionId });
    expect(new Set(launches.map((e) => e.meta.claudeSessionId)).size).toBe(1);
    expect(payload(launches[1]!)!.argv).toContain('--resume');
    expect(h.store.verifyChain().ok).toBe(true);
  });
});

describe('supervisor + claude-sim: plan-limit throttle', () => {
  it('rate_limit_event rejected → Throttled until resetsAt → the throttle_resume job resumes after the reset', async () => {
    const dev = await h.user('builder', 'Throttled');
    const { projectId } = await h.project(dev, 'Logs');
    const sessionId = await launch(dev, projectId, 'throttle');

    const throttled = await until(sessionId, dev, (d) => d.lifecycle === 'throttled', 'Throttled');
    expect(throttled.liveness).toMatchObject({ state: 'throttled', reason: 'plan_limit' });
    expect(outcomesOf(sessionId)).toEqual(['throttled']);
    // Whichever signal lands first opens the episode — the StopFailure hook (no reset time), the sidecar's transcript
    // parse or the supervisor's rate_limit_event — and the supervisor adds the reset time only if none was known.
    // Either way the episode knows one reset: the stream's resetsAt, whole minutes about 95 minutes out.
    const hits = h.events({ types: ['throttle.hit'], sessionId });
    const resets = [...new Set(hits.map((e) => e.meta.resetAt).filter((r): r is string => typeof r === 'string'))];
    expect(resets).toHaveLength(1);
    const resetAt = resets[0]!;
    expect(Date.parse(resetAt) % 60_000).toBe(0);
    expect(Date.parse(resetAt) - Date.now()).toBeGreaterThan(90 * 60_000);
    expect(throttled.throttledUntil).toBe(resetAt);

    // Before the reset the job leaves it alone; once the reset has passed it resumes the session.
    await h.aoc.runtime.runJob('supervisor.throttle_resume');
    expect(turnsOf(sessionId)).toHaveLength(1);
    h.clock.advance(Date.parse(resetAt) - h.clock.now() + 60_000);
    await h.aoc.runtime.runJob('supervisor.throttle_resume');

    const done = await until(sessionId, dev, (d) => d.lifecycle === 'ended', 'the resumed session to complete');
    expect(done.progress).toMatchObject({ doneTasks: 2, totalTasks: 2, pct: 100 });
    const turns = turnsOf(sessionId);
    expect(turns.map((t) => t.reason)).toEqual(['launch', 'throttle_reset']);
    const cleared = h.events({ types: ['throttle.cleared'], sessionId });
    expect(cleared).toHaveLength(1);
    // Productivity lost to throttling is metered (§10): about the time until the reset.
    expect(cleared[0]!.meta.idleMs as number).toBeGreaterThan(90 * 60_000);
    expect(h.store.verifyChain().ok).toBe(true);
  });
});

describe('supervisor + claude-sim: context rollover', () => {
  it('past 70% of the context window at a clean task boundary the thread rolls over to a successor with a brief', async () => {
    const dev = await h.user('builder', 'Porter');
    const { projectId } = await h.project(dev, 'Reports');
    const first = await launch(dev, projectId, ROLLOVER_FILE);

    const retired = await until(first, dev, (d) => d.lifecycle === 'retired', 'the predecessor to retire');
    const started = h.events({ types: ['session.rollover_started'], sessionId: first })[0]!;
    expect(started.meta.contextPct as number).toBeGreaterThanOrEqual(70);
    expect(payload(started)!.brief as string).toContain('t3');
    const completed = h.events({ types: ['session.rollover_completed'], sessionId: first })[0]!;
    const successor = completed.meta.toSessionId as string;
    expect(retired.successorSessionId).toBe(successor);
    expect(h.events({ types: ['session.ended'], sessionId: first }).map((e) => e.meta.outcome)).toEqual(['retired']);

    // The successor continues the same thread, owned by the same developer, and finishes the open task.
    const next = await until(successor, dev, (d) => d.lifecycle === 'ended', 'the successor to complete');
    expect(next).toMatchObject({ threadId: retired.threadId, ownerId: dev.user.id, predecessorSessionId: first });
    const req = h.events({ types: ['session.launch_requested'], sessionId: successor })[0]!;
    expect(req.meta).toMatchObject({ parentSessionId: first, threadId: retired.threadId });
    expect(turnsOf(successor).map((t) => t.reason)).toEqual(['rollover']);
    expect(h.events({ types: ['plan.declared'], sessionId: successor })[0]!.meta.carriedOver).toBe(1);
    // One writer at a time: the predecessor released the thread before the successor took it.
    const writerEvents = h.events({ types: ['thread.writer_released', 'thread.writer_acquired'] }).filter((e) => e.meta.threadId === retired.threadId);
    expect(writerEvents.map((e) => [e.type, e.meta.sessionId])).toEqual([
      ['thread.writer_acquired', first],
      ['thread.writer_released', first],
      ['thread.writer_acquired', successor],
      ['thread.writer_released', successor],
    ]);
    const thread = await h.api<{ progress: { doneTasks: number; totalTasks: number } }>('GET', `/api/threads/${retired.threadId}`, { as: dev });
    expect(thread.progress).toMatchObject({ doneTasks: 3, totalTasks: 3 });
    expect(h.store.verifyChain().ok).toBe(true);
  });
});
