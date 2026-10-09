import { describe, expect, it } from 'vitest';
import { builtInScenario, scenarioMarker } from '@aoc/claude-sim';
import { DEFAULT_TIMING, FLEET, launchBody, nextAction, type SessionStatus } from '../src/fleet';
import type { DemoTokens } from '../src/layout';
import { DEFAULT_LIVE_SCENARIO, simPrompt } from '../src/scenarios';

const tokens = {
  projects: { cx: 'prj_cx', claims: 'prj_claims', aoc: 'prj_aoc' },
  tickets: [{ ticketId: 'tkt_1', key: 'receipts', projectId: 'prj_claims' }],
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
    expect(builtInScenario(DEFAULT_LIVE_SCENARIO)).toBeDefined();
    expect(launchBody(FLEET.find((s) => s.key === 'triage')!, tokens)).toMatchObject({ processType: 'bug-triage', ticketId: 'tkt_1' });
  });

  it('refuses prompts for scenarios claude-sim does not have', () => {
    expect(() => simPrompt('Title', 'Details', 'no-such-scenario')).toThrow(/no built-in scenario/);
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
