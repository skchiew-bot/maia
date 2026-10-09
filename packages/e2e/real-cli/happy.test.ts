/**
 * The managed happy path against the real CLI: launch through POST /api/sessions, then everything the platform
 * depends on — the SessionStart hook, the connected aoc MCP server, declare_plan before any work, hooks relayed as
 * tool.used events, task_done with commit evidence the ledger verifies, a clean turn end, sidecar metering that
 * adds up to what claude itself reports, sane liveness, and hook latency inside the 2.5 s PreToolUse budget.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REAL_CLI_ENABLED,
  dumpSession,
  ended,
  eventsOf,
  git,
  hooksCaptured,
  launch,
  payloadOf,
  recordedUsage,
  reportOf,
  resultsOf,
  startRealCli,
  streamsOf,
  tinyProject,
  until,
  type RealCli,
} from './support';

let r: RealCli;
beforeAll(async () => {
  if (REAL_CLI_ENABLED) r = await startRealCli();
});
afterAll(async () => {
  await r?.close();
});

const PROMPT = "Create hello.txt containing 'hi' and commit it.";
const TWO_TASKS = 'Do two small things in this repository: (1) create a.txt containing "a" and commit it; (2) create b.txt containing "b" and commit it.';
const RUNS = Number(process.env.AOC_REAL_CLI_RUNS ?? 1);

describe.skipIf(!REAL_CLI_ENABLED)('real CLI: managed happy path', () => {
  it('plan → work → evidence-backed task_done → completed, as recorded by hooks, MCP server and sidecar', async () => {
    const { projectId, repo } = await tinyProject(r);
    const sessionId = await launch(r, 'smoke', projectId, PROMPT);
    try {
      await until(r, sessionId, ended, 'the session to end');
      const rep = await reportOf(r, sessionId);
      expect(rep).toMatchObject({ lifecycle: 'ended', planFirst: true, tasksDeclared: 1, tasksDone: 1, tasksVerified: 1, outcomes: ['end_turn'] });

      // MCP server connected (the supervisor aborts a session whose `aoc` server is not), model is the registry's Haiku.
      const output = await r.h.api<{ items: { text: string }[] }>('GET', `/api/sessions/${sessionId}/output`, { as: r.dev });
      expect(output.items.map((i) => i.text)).toContain('Session started · model claude-haiku-5-5 · MCP aoc:connected');

      // The work really happened and the evidence is a commit that exists in the repo.
      const done = eventsOf(r, sessionId, ['task.done'])[0]!;
      expect(done.meta).toMatchObject({ evidenceKind: 'commit', evidenceVerified: true, flag: null });
      expect(git(repo, 'rev-parse', done.meta.headSha as string)).toBe(done.meta.headSha);
      expect(eventsOf(r, sessionId, ['phase.completed'])).toHaveLength(1);

      // Hooks: SessionStart arrives; every Pre/PostToolUse pair is relayed as a tool.used event with the CLI's tool_use_id.
      const hooks = hooksCaptured(r);
      expect(hooks.map((h) => h.event)).toEqual(expect.arrayContaining(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']));
      const [turn] = streamsOf(r, sessionId);
      const calledIds = turn!.flatMap((o) => (o.type === 'assistant' ? (((o.message as Record<string, unknown>).content as Record<string, unknown>[]) ?? []).filter((b) => b.type === 'tool_use').map((b) => b.id as string) : []));
      const used = eventsOf(r, sessionId, ['tool.used']).map((e) => e.meta.toolUseId);
      expect(new Set(used)).toEqual(new Set(calledIds));
      expect(payloadOf(r, eventsOf(r, sessionId, ['prompt.submitted'])[0]!)).toMatchObject({ text: PROMPT });

      // Hook latency (built bundles): well inside the budgets (PreToolUse 2.5 s, others 5 s).
      for (const h of hooks) expect(h.elapsedMs).toBeLessThan(h.event === 'PreToolUse' ? 2500 : 5000);

      // Metering: the sidecar's deduped transcript usage adds up to what claude reports for the same turn.
      const usage = await recordedUsage(r, sessionId);
      const [result] = resultsOf(streamsOf(r, sessionId));
      const model = (result!.modelUsage as Record<string, Record<string, number>>)['claude-haiku-5-5']!;
      expect(usage).toMatchObject({ input: model.inputTokens, output: model.outputTokens, cacheRead: model.cacheReadInputTokens, cacheWrite: model.cacheCreationInputTokens });
      // ... and the supervisor's own per-turn check of the two (G-44) agrees.
      expect(usage.reconciliation).toEqual(['match']);
      const detailNow = await r.h.api<{ tokens: { notionalUsd: number }[]; costTodayUsd: number }>('GET', `/api/sessions/${sessionId}`, { as: r.ceo });
      expect(detailNow.costTodayUsd).toBeGreaterThan(0);
      expect(detailNow.costTodayUsd).toBeCloseTo(result!.total_cost_usd as number, 3);

      // Liveness: Thinking / Working while it ran, never Dead or Stalled.
      const states = eventsOf(r, sessionId, ['session.liveness_changed']).map((e) => e.meta.to);
      expect(states).toContain('working');
      expect(states).not.toContain('dead');
      expect(states).not.toContain('stalled');
      expect(r.h.store.verifyChain().ok).toBe(true);
    } finally {
      await dumpSession(r, sessionId, 'happy');
    }
  });

  it.skipIf(RUNS < 2)(`compliance over ${RUNS} two-task runs`, async () => {
    const reports = [];
    for (let i = 0; i < RUNS; i++) {
      const { projectId } = await tinyProject(r, `Sample ${i}`);
      const sessionId = await launch(r, 'smoke', projectId, TWO_TASKS);
      await until(r, sessionId, (d) => ended(d) || d.lifecycle === 'waiting_decision' || d.lifecycle === 'idle', `run ${i} to stop`);
      await dumpSession(r, sessionId, `sample-${i}`);
      reports.push(await reportOf(r, sessionId));
    }
    // eslint-disable-next-line no-console
    console.log(`COMPLIANCE ${JSON.stringify(reports)}`);
    const ok = reports.filter((x) => x.lifecycle === 'ended' && x.planFirst && x.tasksDone === x.tasksDeclared && x.tasksVerified === x.tasksDone);
    expect(ok.length / reports.length).toBeGreaterThanOrEqual(0.8);
  });
});
