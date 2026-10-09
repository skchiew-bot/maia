import { describe, expect, it } from 'vitest';
import { builtInScenario, parseScenario, scenarioMarker } from '@aoc/claude-sim';
import { defaultScenario } from '../src/default-scenario';
import { DEFAULT_TIMING, FLEET, launchBody, nextAction, selectSlots, type SessionStatus } from '../src/fleet';
import type { DemoTokens } from '../src/layout';
import { simPrompt } from '../src/scenarios';

const tokens = {
  projects: { cx: 'prj_cx', claims: 'prj_claims', aoc: 'prj_aoc' },
  tickets: [
    { ticketId: 'tkt_1', key: 'receipts', projectId: 'prj_claims' },
    { ticketId: 'tkt_2', key: 'duplicate', projectId: 'prj_claims' },
  ],
} as unknown as DemoTokens;
const at = (lifecycle: string, successorSessionId: string | null = null): SessionStatus => ({ lifecycle, successorSessionId });
const occupied = { sessionId: 'ses_1', runs: 1 };

describe('the fleet', () => {
  it('runs every slot on a claude-sim built-in scenario, on a new thread each run', () => {
    for (const slot of FLEET) {
      const body = launchBody(slot, tokens);
      expect(builtInScenario(scenarioMarker(String(body.prompt))!), slot.key).toBeDefined();
      expect(String(body.prompt).split('\n')[0]).toBe(slot.title);
      expect(body).not.toHaveProperty('threadId');
    }
    expect(launchBody(FLEET.find((s) => s.key === 'triage')!, tokens)).toMatchObject({ processType: 'bug-triage', ticketId: 'tkt_2' });
  });

  it('selects a subset of the slots for --slots, in fleet order, and refuses unknown names', () => {
    expect(selectSlots([]).map((s) => s.key)).toEqual(FLEET.map((s) => s.key));
    expect(selectSlots(['triage', 'decision']).map((s) => s.key)).toEqual(['decision', 'triage']);
    expect(() => selectSlots(['decision', 'nope'])).toThrow(/unknown slot nope/);
  });

  it('refuses prompts for scenarios claude-sim does not have', () => {
    expect(() => simPrompt('Title', 'Details', 'no-such-scenario')).toThrow(/no built-in scenario/);
  });
});

describe('the default scenario', () => {
  const scenario = parseScenario(defaultScenario({ receipts: 'tkt_01ABC', transferBlank: 'tkt_01XYZ' }), 'test');
  const branches = scenario.steps.filter((s) => s.kind === 'branch');

  it('dispatches the prompts the platform writes: rollover successors, intake triage and builds', () => {
    expect(branches.map((b) => (b.kind === 'branch' ? [b.onResumeTextIncludes, b.goto] : null))).toEqual([
      [['Context rollover:'], 'rollover-successor'],
      [['diagnosing customer ticket tkt_01ABC '], 'triage-receipts'],
      [['diagnosing customer ticket tkt_01XYZ '], 'triage-transfer'],
      [['fix plan for ticket tkt_01ABC.'], 'build-receipts'],
      [['diagnosing customer ticket'], 'triage-unknown'],
    ]);
  });

  it("commits the ticket's build to uat/<ticketId> with the trailers provenance needs, using scoped git only", () => {
    const commands = scenario.steps.flatMap((s) => (s.kind === 'bash' ? [s.command] : []));
    expect(commands).toContain('git switch -c uat/tkt_01ABC || git switch uat/tkt_01ABC');
    expect(commands.find((c) => c.startsWith('git commit'))).toMatch(/AOC-Ticket: tkt_01ABC.*AOC-Session: \$AOC_SESSION_ID/);
    expect(commands.at(-1)).toBe('git switch -');
  });

  it('carries no scenario marker: the prompts around a requester\'s text never select a scenario', () => {
    expect(JSON.stringify(scenario)).not.toContain('[[scenario:');
  });

  it("closes the commit task while HEAD is the UAT commit: provenance only traces commits in a session's recorded HEADs (G-25)", () => {
    const build = scenario.steps.findIndex((s) => (s as { label?: string }).label === 'build-receipts');
    expect(build).toBeGreaterThan(-1);
    const at = (match: (s: (typeof scenario.steps)[number]) => boolean) => scenario.steps.findIndex((s, i) => i >= build && match(s));
    const commit = at((s) => s.kind === 'bash' && s.command.startsWith('git commit'));
    const commitTask = at((s) => s.kind === 'mcp' && s.tool === 'task_done' && (s.args as { task_id?: string }).task_id === 'bd-receipts-3');
    const leave = at((s) => s.kind === 'bash' && s.command === 'git switch -');
    expect(commit).toBeGreaterThan(-1);
    expect(commitTask).toBeGreaterThan(commit);
    expect(leave).toBeGreaterThan(commitTask);
  });

  it('does the same in the dedupe continuation, which commits for the ticket whose build waited on a decision', () => {
    const steps = builtInScenario('demo-dedupe-resume')!.steps;
    const index = (match: (s: (typeof steps)[number]) => boolean) => steps.findIndex(match);
    const commit = index((s) => s.kind === 'bash' && s.command.startsWith('git commit'));
    const commitTask = index((s) => s.kind === 'mcp' && s.tool === 'task_done' && (s.args as { task_id?: string }).task_id === 'dedupe-3');
    const leave = index((s) => s.kind === 'bash' && s.command === 'git switch -');
    expect(commit).toBeGreaterThan(-1);
    expect(commitTask).toBeGreaterThan(commit);
    expect(leave).toBeGreaterThan(commitTask);
  });
});

describe('nextAction', () => {
  const now = 1_000_000;
  it('launches into an empty slot or when the session is gone', () => {
    expect(nextAction({ sessionId: null, runs: 0 }, null, now, now)).toEqual({ kind: 'launch' });
    expect(nextAction(occupied, null, now, now)).toEqual({ kind: 'launch' });
  });

  it('keeps sessions the operator is meant to act on, however long they wait', () => {
    for (const lifecycle of ['launching', 'running', 'waiting_decision', 'throttled', 'blocked']) {
      expect(nextAction(occupied, at(lifecycle), 0, now + 86_400_000)).toEqual({ kind: 'keep' });
    }
  });

  it('relaunches a finished slot after the pause, following a rollover to its successor first', () => {
    expect(nextAction(occupied, at('retired', 'ses_2'), now, now)).toEqual({ kind: 'follow', sessionId: 'ses_2' });
    expect(nextAction(occupied, at('ended'), now, now + DEFAULT_TIMING.relaunchAfterMs - 1)).toEqual({ kind: 'keep' });
    expect(nextAction(occupied, at('ended'), now, now + DEFAULT_TIMING.relaunchAfterMs)).toEqual({ kind: 'launch' });
  });

  it('leaves Dead and idle sessions to the operator for a while, then replaces them', () => {
    expect(nextAction(occupied, at('failed'), now, now + DEFAULT_TIMING.deadAfterMs - 1)).toEqual({ kind: 'keep' });
    expect(nextAction(occupied, at('failed'), now, now + DEFAULT_TIMING.deadAfterMs)).toEqual({ kind: 'replace', stopSessionId: 'ses_1' });
    expect(nextAction(occupied, at('idle'), now, now + DEFAULT_TIMING.idleAfterMs)).toEqual({ kind: 'replace', stopSessionId: 'ses_1' });
  });
});
