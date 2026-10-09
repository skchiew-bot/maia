/**
 * A stop at the next task boundary against the real CLI. The operator asks to stop while the first of two tasks is
 * still running (no interrupt); `task_done` for that task then answers `boundary.continue: false, stop_requested`, and
 * the model — which was told in its system prompt and again in the result — must end its turn without starting the
 * second task. The supervisor then ends the session as stopped.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  REAL_CLI_ENABLED,
  dumpSession,
  ended,
  eventsOf,
  hooksCaptured,
  launch,
  startRealCli,
  streamsOf,
  testing,
  tinyProject,
  toolUses,
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

const PROMPT = 'Do two things in this repository, in this order. First run the tests with npm test. Then create b.txt containing "b" and commit it.';

describe.skipIf(!REAL_CLI_ENABLED)('real CLI: stop at the next task boundary', () => {
  it('after task_done answers stop_requested the model ends its turn and does not start the next task', async () => {
    const { projectId, repo } = await tinyProject(r, 'Boundary', 30_000);
    const sessionId = await launch(r, 'smoke', projectId, PROMPT);
    try {
      await waitUntil(testing(r, sessionId), 'npm test to be running');
      await r.h.api('POST', `/api/sessions/${sessionId}/stop`, { as: r.dev, body: { immediate: false, reason: 'enough for today' } });
      await until(r, sessionId, ended, 'the session to end at the boundary', 240_000);

      expect(eventsOf(r, sessionId, ['session.stop_requested']).map((e) => e.meta.immediate)).toEqual([false]);
      // Nothing interrupted the tests: the turn ran to its own end, and the supervisor ended the session after it.
      expect(eventsOf(r, sessionId, ['session.turn_ended']).map((e) => [e.meta.outcome, e.meta.exitCode])).toEqual([['stop_requested', 0]]);
      expect(hooksCaptured(r).some((h) => h.event === 'PostToolUse' && h.input.tool_name === 'Bash' && String(JSON.stringify(h.input.tool_response)).includes('tests pass'))).toBe(true);

      // The boundary answer reached the model as structured data, and it stopped there.
      const [turn] = streamsOf(r, sessionId);
      const calls = toolUses(turn!);
      const stopping = calls.findLast((c) => c.name === 'mcp__aoc__task_done')!;
      expect(stopping, 'the model must close the first task with task_done').toBeTruthy();
      const answer = JSON.stringify(turn!.filter((o) => o.type === 'user' && JSON.stringify(o).includes(stopping.id)));
      expect(answer).toContain('stop_requested');
      expect(calls.slice(calls.indexOf(stopping) + 1).map((c) => `${c.name}: ${JSON.stringify(c.input).slice(0, 100)}`)).toEqual([]);
      expect(existsSync(join(repo, 'b.txt'))).toBe(false);
      expect(eventsOf(r, sessionId, ['task.done'])).toHaveLength(1);
    } finally {
      await dumpSession(r, sessionId, 'boundary');
    }
  });
});
