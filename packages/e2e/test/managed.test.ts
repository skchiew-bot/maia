/**
 * (a) Managed happy path and (b) the plan gate / read-only triage, driven through the real hook binary, the real
 * MCP server and the real sidecar against a real aocd.
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsoleSnapshot, SessionDetail, SessionTimeline } from '@aoc/contracts';
import { ClaudeSession, denyReason } from './claude';
import { Harness, waitFor } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await Harness.start();
});
afterAll(async () => {
  await h?.close();
});

const git = (repo: string, ...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

// config/rate-card.json (USD per MTok) for the two models the transcript uses.
const RATES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cache5m: 5, cache1h: 8 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cache5m: 0.125, cache1h: 0.2 },
} as const;
type U = { input: number; output: number; cacheRead: number; cache5m: number; cache1h: number };
const cost = (model: keyof typeof RATES, u: U) =>
  (Object.keys(u) as (keyof U)[]).reduce((usd, k) => usd + (u[k] * RATES[model][k]) / 1e6, 0);

describe('(a) managed happy path', () => {
  it('plan → edits → evidence-backed task_done → phase pinned → usage via sidecar → read models', async () => {
    const owner = h.user('builder', 'Aisyah');
    const ceo = h.user('approver', 'CEO');
    const { projectId, repo } = await h.project(owner, 'Claims Bot');
    const s = await h.launch(owner, { projectId, processType: 'discovery' });
    const claude = new ClaudeSession(h, s);
    const sidecar = claude.startSidecar();
    await claude.start();

    const detail = () => h.api<SessionDetail>('GET', `/api/sessions/${s.sessionId}`, { as: ceo });
    // Heartbeats come from the sidecar (hooks cannot fire while the model generates, §2.1).
    await waitFor(async () => (await detail()).liveness?.state === 'thinking', { what: 'Thinking from sidecar heartbeats' });
    expect((await detail()).ownerId).toBe(owner.user.id);

    // Read-only tools are fine before a plan; the AOC MCP tools always are.
    expect((await claude.read('README.md')).decision).toBe('allow');
    const main1 = claude.transcript.assistant({ input: 12, output: 310, cacheRead: 180_000, cache1h: 4_000 }, [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: 'I will declare the plan first.' },
      { type: 'tool_use', id: 'toolu_plan', name: 'mcp__aoc__declare_plan', input: {} },
    ]);
    const plan = await claude.aoc('declare_plan', {
      summary: 'Claims CSV parser and endpoint',
      phases: [
        {
          id: 'p1',
          name: 'Parser',
          tasks: [
            { id: 't1', title: 'Parse claim rows', size: 'm' },
            { id: 't2', title: 'Test the parser', size: 's' },
          ],
        },
        { id: 'p2', name: 'API', tasks: [{ id: 't3', title: 'Expose the endpoint', size: 'l' }] },
      ],
    });
    expect(plan.isError).toBe(false);
    expect(plan.data).toMatchObject({ ok: true, manifestVersion: 1, totalTasks: 3, totalWeight: 3 + 2 + 5 });

    // t1: an Edit, then a real commit made through Bash.
    const edit = await claude.edit('src/claims.ts', 'export const claims = [];', 'export const parse = (csv: string) => csv.split("\\n");');
    expect(edit.decision).toBe('allow');
    expect((await claude.bash('git add -A && git commit -q -m "Parse claim rows"')).decision).toBe('allow');
    const sha = git(repo, 'rev-parse', 'HEAD');
    const t1 = await claude.aoc('task_done', { task_id: 't1', evidence: { kind: 'commit', ref: sha } });
    expect(t1.isError).toBe(false);
    expect(t1.data).toMatchObject({ ok: true, flagged: null, phaseCompleted: null, boundary: { continue: true } });
    expect(t1.data.progress).toMatchObject({ doneTasks: 1, totalTasks: 3, doneWeight: 3, totalWeight: 10 });

    // t2: a new test file + test-id evidence completes phase p1, which pins an immutable tag (§8).
    const main2 = claude.transcript.assistant({ input: 8, output: 120, cacheRead: 230_000, cache1h: 1_500 }, [
      { type: 'tool_use', id: 'toolu_w', name: 'Write', input: {} },
    ]);
    expect((await claude.write('src/claims.test.ts', "import { parse } from './claims';\n// parses rows\n")).decision).toBe('allow');
    const t2 = await claude.aoc('task_done', { task_id: 't2', evidence: { kind: 'test', ref: 'src/claims.test.ts > parses rows' } });
    expect(t2.data).toMatchObject({ ok: true, flagged: null, boundary: { continue: true } });
    expect(t2.data.phaseCompleted).toMatchObject({ phaseId: 'p1' });
    const pinned = t2.data.phaseCompleted.pinnedRef as string;
    expect(pinned).toMatch(/^aoc\/claims-bot\/p1\/\d+$/);
    expect(git(repo, 'tag', '--list', 'aoc/*')).toContain(pinned);
    expect(git(repo, 'rev-parse', `${pinned}^{commit}`)).toBe(git(repo, 'rev-parse', 'HEAD'));

    // A subagent's usage lives in its own transcript file (never in the main one).
    const sub = claude.transcript.subagent('a3e0385ed503597cc');
    const subMsg = sub.assistant({ input: 40, output: 90, cache5m: 2_000 }, [{ type: 'text', text: 'PONG' }], 'claude-haiku-5-5');

    // Usage reaches the daemon via the sidecar's periodic flush (deduped by message id across blocks).
    const recorded = await waitFor(
      () => {
        const ids = h.events({ types: ['usage.recorded'], sessionId: s.sessionId }).flatMap((e) => (h.store.readPayload(e) as { messageIds: string[] }).messageIds);
        return [main1, main2, subMsg].every((id) => ids.includes(id)) && ids;
      },
      { timeout: 20_000, what: 'usage from the sidecar flush' },
    );
    expect(recorded.filter((id) => id === main1)).toHaveLength(1);
    const usage = h.events({ types: ['usage.recorded'], sessionId: s.sessionId });
    const sum = (model: string, k: 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWrite5mTokens' | 'cacheWrite1hTokens') =>
      usage.filter((e) => e.meta.model === model).reduce((n, e) => n + (e.meta[k] as number), 0);
    expect(sum('claude-opus-5-5', 'inputTokens')).toBe(20);
    expect(sum('claude-opus-5-5', 'outputTokens')).toBe(430);
    expect(sum('claude-opus-5-5', 'cacheReadTokens')).toBe(410_000);
    expect(sum('claude-opus-5-5', 'cacheWrite1hTokens')).toBe(5_500);
    expect(sum('claude-haiku-5-5', 'cacheWrite5mTokens')).toBe(2_000);

    // Read models: progress, APM, context %, notional cost, liveness.
    const d = await waitFor(async () => {
      const v = await detail();
      return v.contextTokens === 8 + 230_000 + 1_500 && v;
    }, { what: 'context size of the latest main-chain message' });
    expect(d.progress).toMatchObject({ doneTasks: 2, totalTasks: 3, doneWeight: 5, totalWeight: 10, pct: 50, flaggedTasks: 0 });
    expect(d.contextPct).toBe(Math.round(((8 + 230_000 + 1_500) / 1_000_000) * 1000) / 10);
    expect(d.apm.points.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(h.events({ types: ['tool.used'], sessionId: s.sessionId }).length);
    const expectedUsd =
      cost('claude-opus-5-5', { input: 20, output: 430, cacheRead: 410_000, cache5m: 0, cache1h: 5_500 }) +
      cost('claude-haiku-5-5', { input: 40, output: 90, cacheRead: 0, cache5m: 2_000, cache1h: 0 });
    expect(d.costTodayUsd).toBeCloseTo(expectedUsd, 3);
    expect(d.tokens.map((t) => t.model).sort()).toEqual(['claude-haiku-5-5', 'claude-opus-5-5']);
    expect(['working', 'thinking']).toContain(d.liveness?.state);

    const timeline = await h.api<SessionTimeline>('GET', `/api/sessions/${s.sessionId}/timeline`, { as: ceo });
    const p1 = timeline.manifest.find((p) => p.phaseId === 'p1')!;
    expect(p1.pinnedTag).toBe(pinned);
    expect(p1.tasks.map((t) => [t.taskId, t.status, t.evidence?.verified])).toEqual([
      ['t1', 'done', true],
      ['t2', 'done', true],
    ]);

    const consoleView = await h.api<ConsoleSnapshot>('GET', '/api/console', { as: owner });
    const row = consoleView.sessions.find((x) => x.sessionId === s.sessionId)!;
    expect(row.progress?.pct).toBe(50);
    expect(consoleView.kpis.tasksDoneToday).toBeGreaterThanOrEqual(2);
    expect(consoleView.kpis.tasksDoneWithEvidencePct).toBe(100);
    expect(consoleView.kpis.notionalUsdToday).toBeGreaterThan(0);

    // The event log: build activity is first-class, file changes are attributed, the chain holds.
    const types = h.events({ sessionId: s.sessionId }).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['session.launch_requested', 'session.launched', 'prompt.submitted', 'plan.declared', 'task.done', 'phase.completed', 'usage.recorded']));
    const edits = h.events({ types: ['tool.used'], sessionId: s.sessionId }).filter((e) => e.meta.toolName === 'Edit' || e.meta.toolName === 'Write');
    expect(edits.map((e) => e.meta.fileChanging)).toEqual([true, true]);
    const done = h.events({ types: ['task.done'], sessionId: s.sessionId });
    expect(done.map((e) => [e.meta.taskId, e.meta.evidenceVerified, e.meta.flag])).toEqual([
      ['t1', true, null],
      ['t2', true, null],
    ]);

    // End of turn: the claude process exits; the sidecar reports it and stops.
    claude.killClaude();
    await waitFor(async () => (await detail()).liveness?.state === 'dead', { what: 'Dead after the process exit' });
    expect(await sidecar.exited).toBe(0);
    h.supervisor.endSession(s.sessionId);
    await waitFor(async () => (await detail()).lifecycle === 'ended', { what: 'session ended' });
    await claude.close();
    expect(h.store.verifyChain().ok).toBe(true);
  });
});

describe('(b) plan gate and read-only triage', () => {
  it('denies file changes before declare_plan (no-manifest guard), relayed by the hook binary', async () => {
    const owner = h.user('builder');
    const { projectId, repo } = await h.project(owner, 'Gate');
    const s = await h.launch(owner, { projectId });
    const claude = new ClaudeSession(h, s);
    await claude.start();

    const edit = await claude.edit('src/claims.ts', 'claims', 'claimz');
    expect(edit.decision).toBe('deny');
    expect(edit.pre.code).toBe(0);
    expect(denyReason(edit.pre)).toMatch(/declare_plan/);
    expect(git(repo, 'status', '--porcelain')).toBe('');
    // Bash can change files too, so it is gated as well; reads are not.
    expect((await claude.bash('rm -rf src')).decision).toBe('deny');
    expect((await claude.read('README.md')).decision).toBe('allow');

    const denied = h.events({ types: ['tool.denied'], sessionId: s.sessionId });
    expect(denied.map((e) => [e.meta.toolName, e.meta.guard, e.meta.decisionId])).toEqual([
      ['Edit', 'no-manifest', null],
      ['Bash', 'no-manifest', null],
    ]);
    expect(h.events({ types: ['session.blocked'], sessionId: s.sessionId }).map((e) => e.meta.reason)).toEqual(['no_manifest', 'no_manifest']);

    await claude.aoc('declare_plan', { phases: [{ id: 'p1', name: 'Fix', tasks: [{ id: 't1', title: 'Rename', size: 'xs' }] }] });
    expect((await claude.edit('src/claims.ts', 'claims', 'claimz')).decision).toBe('allow');
    await claude.close();
    expect(h.store.verifyChain().ok).toBe(true);
  });

  it('a read-only triage session cannot write, whatever it declared', async () => {
    const owner = h.user('builder');
    const { projectId, repo } = await h.project(owner, 'Triage');
    const s = await h.launch(owner, { projectId, processType: 'bug-triage', prompt: 'Diagnose the blank page (read-only).' });
    expect(s.readOnly).toBe(true);
    const launched = h.events({ types: ['session.launch_requested'], sessionId: s.sessionId })[0]!;
    expect(launched.meta).toMatchObject({ readOnly: true, credentialProfile: null });
    const claude = new ClaudeSession(h, s);
    await claude.start();
    await claude.aoc('declare_plan', { phases: [{ id: 'd', name: 'Diagnose', tasks: [{ id: 'd1', title: 'Find the root cause', size: 's' }] }] });

    const write = await claude.write('src/fix.ts', 'export {};\n');
    expect(write.decision).toBe('deny');
    expect(denyReason(write.pre)).toMatch(/read-only/i);
    expect((await claude.bash("sed -i 's/claims/x/' src/claims.ts")).decision).toBe('deny');
    expect((await claude.bash('git log --oneline -1')).decision).toBe('allow');
    expect(git(repo, 'status', '--porcelain')).toBe('');
    expect(h.events({ types: ['tool.denied'], sessionId: s.sessionId }).map((e) => e.meta.guard)).toEqual(['read-only', 'read-only']);
    await claude.close();
    expect(h.store.verifyChain().ok).toBe(true);
  });
});
