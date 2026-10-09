/**
 * Operator controls against the real CLI while a tool is running: nudge the turn (SIGINT → a clean `result`, exit 0),
 * stop the session, and restart one whose claude process was killed (SIGTERM → exit 143, no result line) — the same
 * conversation (claude session id, one growing transcript) continues through `--resume`.
 *
 * The running tool is `npm test` on a project whose tests take 40 s. (A bare `sleep N` is refused by Claude Code
 * 2.1.295 itself: "Blocked: standalone sleep".)
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REAL_CLI_ENABLED,
  dumpSession,
  ended,
  eventsOf,
  hooksCaptured,
  launch,
  payloadOf,
  recordedUsage,
  startRealCli,
  testing,
  streamsOf,
  tinyProject,
  transcriptOf,
  until,
  waitUntil,
  type RealCli,
} from './support';

let r: RealCli;
beforeAll(async () => {
  if (REAL_CLI_ENABLED) r = await startRealCli();
});
afterAll(async () => {
  await r?.close();
});

const PROMPT = 'Run the tests with npm test. When they pass, create done.txt containing "ok" and commit it.';
const TEST_MS = 40_000;

const lines = (path: string) => readFileSync(path, 'utf8').split('\n').filter(Boolean);
const withoutLastLine = (path: string) => lines(path).slice(0, -1);

describe.skipIf(!REAL_CLI_ENABLED)('real CLI: operator controls', () => {
  it('nudge interrupts the running tool (SIGINT), resumes the same conversation with the operator text, and the work finishes', async () => {
    const { projectId, repo } = await tinyProject(r, 'Nudge', TEST_MS);
    const sessionId = await launch(r, 'smoke', projectId, PROMPT);
    try {
      await waitUntil(testing(r, sessionId), 'npm test to be running');
      const before = transcriptOf(r, sessionId)!;
      await r.h.api('POST', `/api/sessions/${sessionId}/nudge`, { as: r.dev, body: { text: 'Do not wait for the tests: create done.txt now and commit it.' } });
      await until(r, sessionId, ended, 'the nudged session to finish');

      // SIGINT made claude abort the turn itself: a result line (error_during_execution) and exit 0 — not a crash.
      const [turn1] = streamsOf(r, sessionId);
      expect(turn1!.find((o) => o.type === 'result')).toMatchObject({ subtype: 'error_during_execution', is_error: true });
      const turns = eventsOf(r, sessionId, ['session.turn_started']);
      // The nudged turn may leave a declared task open (the model dropped the tests): the supervisor then continues it.
      expect(turns.map((e) => e.meta.reason).slice(0, 2)).toEqual(['launch', 'nudge']);
      expect(turns.slice(2).every((e) => e.meta.reason === 'continue')).toBe(true);
      expect(payloadOf(r, turns[1]!)!.injectedText as string).toContain('Do not wait for the tests: create done.txt now and commit it.');
      const outcomes = eventsOf(r, sessionId, ['session.turn_ended']).map((e) => e.meta.outcome);
      expect(outcomes[0]).toBe('interrupted');
      expect(outcomes.slice(1).every((outcome) => outcome === 'end_turn')).toBe(true);
      expect(eventsOf(r, sessionId, ['session.nudged'])).toHaveLength(1);

      // Same conversation: one claude session id, `--resume`, the transcript file only grew.
      const launches = eventsOf(r, sessionId, ['session.launched']);
      expect(new Set(launches.map((e) => e.meta.claudeSessionId)).size).toBe(1);
      expect(payloadOf(r, launches[1]!)!.argv as string[]).toContain('--resume');
      const after = transcriptOf(r, sessionId)!;
      expect(after.path).toBe(before.path);
      expect(after.lines.length).toBeGreaterThan(before.lines.length);
      expect(lines(after.path).slice(0, withoutLastLine(before.path).length)).toEqual(withoutLastLine(before.path));
      expect(readFileSync(join(repo, 'done.txt'), 'utf8').trim()).toBe('ok');
      // The interrupted turn's partial figures and the resumed turns' cumulative ones still add up, turn by turn.
      expect((await recordedUsage(r, sessionId)).reconciliation.every((status) => status === 'match')).toBe(true);
    } finally {
      await dumpSession(r, sessionId, 'controls-nudge');
    }
  });

  it('stop (immediate) ends a session whose tool is running: interrupted turn, session killed, writer released', async () => {
    const { projectId, repo } = await tinyProject(r, 'Stop', TEST_MS);
    const sessionId = await launch(r, 'smoke', projectId, PROMPT);
    try {
      await waitUntil(testing(r, sessionId), 'npm test to be running');
      await r.h.api('POST', `/api/sessions/${sessionId}/stop`, { as: r.dev, body: { immediate: true, reason: 'enough' } });
      const done = await until(r, sessionId, ended, 'the stopped session to end', 60_000);
      expect(done.lifecycle).toBe('ended');
      expect(eventsOf(r, sessionId, ['session.ended']).map((e) => e.meta.outcome)).toEqual(['killed']);
      expect(eventsOf(r, sessionId, ['session.turn_ended']).map((e) => e.meta.outcome)).toEqual(['interrupted']);
      expect(eventsOf(r, sessionId, ['thread.writer_released'])).toHaveLength(1);
      expect(existsSync(join(repo, 'done.txt'))).toBe(false);
    } finally {
      await dumpSession(r, sessionId, 'controls-stop');
    }
  });

  it('a SIGTERMed claude shows Dead (exit 143, no result line); restart resumes the same conversation and the work finishes', async () => {
    const { projectId, repo } = await tinyProject(r, 'Crash', TEST_MS);
    const sessionId = await launch(r, 'smoke', projectId, PROMPT);
    try {
      await waitUntil(testing(r, sessionId), 'npm test to be running');
      const before = transcriptOf(r, sessionId)!;
      process.kill(eventsOf(r, sessionId, ['session.launched'])[0]!.meta.pid as number, 'SIGTERM');
      const dead = await until(r, sessionId, (d) => d.lifecycle === 'failed', 'the killed session to be Dead', 60_000);
      expect(dead.liveness?.state).toBe('dead');
      expect(eventsOf(r, sessionId, ['session.turn_ended']).map((e) => [e.meta.outcome, e.meta.exitCode])).toEqual([['crashed', 143]]);
      expect(streamsOf(r, sessionId)[0]!.some((o) => o.type === 'result')).toBe(false);

      await r.h.api('POST', `/api/sessions/${sessionId}/restart`, { as: r.dev });
      await until(r, sessionId, ended, 'the restarted session to finish');
      expect(eventsOf(r, sessionId, ['session.turn_started']).map((e) => e.meta.reason).slice(0, 2)).toEqual(['launch', 'restart']);
      const launches = eventsOf(r, sessionId, ['session.launched']);
      expect(new Set(launches.map((e) => e.meta.claudeSessionId)).size).toBe(1);
      expect(payloadOf(r, launches[1]!)!.argv as string[]).toContain('--resume');
      const after = transcriptOf(r, sessionId)!;
      expect(after.path).toBe(before.path);
      expect(lines(after.path).slice(0, withoutLastLine(before.path).length)).toEqual(withoutLastLine(before.path));
      expect(readFileSync(join(repo, 'done.txt'), 'utf8').trim()).toBe('ok');
      // A turn killed without a result cannot be checked; neither can the one resumed from its unsaved cost state.
      expect((await recordedUsage(r, sessionId)).reconciliation.slice(0, 2)).toEqual(['unverified', 'unverified']);
    } finally {
      await dumpSession(r, sessionId, 'controls-crash');
    }
  });
});
