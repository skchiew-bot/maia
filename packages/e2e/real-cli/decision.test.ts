/**
 * Decision round trip against the real CLI: the model raises request_decision on its own when the spec leaves a call
 * to a human, ends its turn at once (the session shows Waiting on you and no process is left running), the answer is
 * posted through the API, the supervisor resumes the same conversation with it injected, and the model acts on it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DecisionCardView } from '@aoc/contracts';
import {
  REAL_CLI_ENABLED,
  answer,
  dumpSession,
  ended,
  eventsOf,
  launch,
  openDecisions,
  payloadOf,
  recordedUsage,
  reportOf,
  startRealCli,
  streamsOf,
  tinyProject,
  toolUses,
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

const PROMPT =
  'Create greeting.txt containing a one-line greeting for new users, then commit it. ' +
  'The candidate greetings are "Hello, welcome!" and "Selamat datang!". The product owner has not said which one to use, and that choice is theirs, not yours.';
const RUNS = Number(process.env.AOC_REAL_CLI_RUNS ?? 1);

/** The option the human picks: never the model's own recommendation, so following the answer is observable. */
function humanChoice(card: DecisionCardView): { optionId: string; word: 'Hello' | 'Selamat' } {
  const rec = card.recommendation?.optionId;
  const word = (o: { label: string }) => (/selamat/i.test(o.label) ? 'Selamat' : /hello/i.test(o.label) ? 'Hello' : null);
  const picked = card.options.find((o) => o.id !== rec && word(o)) ?? card.options.find((o) => word(o));
  if (!picked) throw new Error(`no option of the card names a candidate greeting: ${JSON.stringify(card.options)}`);
  return { optionId: picked.id, word: word(picked)! };
}

describe.skipIf(!REAL_CLI_ENABLED)('real CLI: decision round trip', () => {
  for (let run = 1; run <= RUNS; run++) {
    it(`request_decision → turn ends → Waiting on you → answered via the API → resumed with the answer → done (${run}/${RUNS})`, async () => {
      const { projectId, repo } = await tinyProject(r, `Decide ${run}`);
      const sessionId = await launch(r, 'smoke', projectId, PROMPT);
      try {
        // Turn 1 ends on the open decision: nothing keeps running while a human decides.
        const waiting = await until(r, sessionId, (d) => d.lifecycle === 'waiting_decision' || ended(d), 'the turn to end on a decision');
        expect(waiting.lifecycle).toBe('waiting_decision');
        expect(waiting.liveness?.state).toBe('waiting_on_you');
        const cards = await openDecisions(r, sessionId);
        expect(cards.length).toBeGreaterThanOrEqual(1);
        const card = cards[0]!;
        expect(card).toMatchObject({ kind: 'agent_decision', requesterId: `session:${sessionId}`, sessionId });
        expect(card.options.length).toBeGreaterThanOrEqual(2);
        const requested = eventsOf(r, sessionId, ['decision.requested'])[0]!;
        expect(requested).toMatchObject({ source: 'mcp', actor: { kind: 'agent', id: sessionId } });
        expect(eventsOf(r, sessionId, ['session.turn_ended']).map((e) => e.meta.outcome)).toEqual(['decision']);

        // "END YOUR TURN NOW": no tool call follows request_decision, and the claude process is gone.
        const [turn1] = streamsOf(r, sessionId);
        const calls = toolUses(turn1!);
        const at = calls.findIndex((c) => c.name === 'mcp__aoc__request_decision');
        expect(at).toBeGreaterThanOrEqual(0);
        expect(calls.slice(at + 1).map((c) => c.name)).toEqual([]);
        expect(r.h.aoc.runtime.services.get('supervisor').isRunning(sessionId)).toBe(false);

        // The human picks the option the model did not recommend.
        const choice = humanChoice(card);
        await answer(r, card, choice.optionId, 'Product owner decision.');
        const done = await until(r, sessionId, (d) => ended(d) || d.lifecycle === 'waiting_decision', 'the resumed session to finish');
        expect(done.lifecycle).toBe('ended');

        // The same conversation was resumed with the answer injected.
        const turns = eventsOf(r, sessionId, ['session.turn_started']);
        expect(turns.map((e) => e.meta.reason)).toEqual(['launch', 'decision_answered']);
        expect(payloadOf(r, turns[1]!)!.injectedText as string).toContain(`Decision ${card.id} answered:`);
        const launches = eventsOf(r, sessionId, ['session.launched']);
        expect(new Set(launches.map((e) => e.meta.claudeSessionId)).size).toBe(1);
        expect(payloadOf(r, launches[1]!)!.argv as string[]).toContain('--resume');

        // And the model acted on the human's answer, not on its own recommendation.
        const file = join(repo, 'greeting.txt');
        expect(existsSync(file)).toBe(true);
        const text = readFileSync(file, 'utf8');
        expect(text).toContain(choice.word);
        expect(text).not.toContain(choice.word === 'Hello' ? 'Selamat' : 'Hello');
        const rep = await reportOf(r, sessionId);
        expect(rep).toMatchObject({ planFirst: true, tasksVerified: rep.tasksDeclared, outcomes: ['decision', 'end_turn'] });
        expect(rep.tasksDone).toBeGreaterThanOrEqual(1);
        // result.modelUsage is cumulative across --resume: the second turn is still checked against its own figures.
        expect((await recordedUsage(r, sessionId)).reconciliation).toEqual(['match', 'match']);
        expect(r.h.store.verifyChain().ok).toBe(true);
      } finally {
        await dumpSession(r, sessionId, `decision-${run}`);
      }
    });
  }
});
