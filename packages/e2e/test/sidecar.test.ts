/**
 * (f) Plan-limit throttles detected by the sidecar from the transcript, and (g) process death detected by the
 * sidecar's watch on the claude pid — both through the real sidecar binary.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsoleSnapshot, SessionDetail } from '@aoc/contracts';
import { ClaudeSession } from './claude';
import { Harness, waitFor } from './harness';

let h: Harness;
beforeAll(async () => {
  h = await Harness.start();
});
afterAll(async () => {
  await h?.close();
});

const LIMIT = "You've hit your session limit · resets 3pm (Asia/Kuala_Lumpur)";

/** The next 15:00 in Kuala Lumpur (UTC+8, no DST) after `now`. */
function next3pmKl(now = Date.now()): string {
  const d = new Date(now);
  let at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7, 0);
  if (at <= now) at += 24 * 3600_000;
  return new Date(at).toISOString();
}

async function running(name: string) {
  const owner = await h.user('builder', name);
  const { projectId } = await h.project(owner, name);
  const s = await h.launch(owner, { projectId });
  const claude = new ClaudeSession(h, s);
  const sidecar = claude.startSidecar();
  await claude.start();
  await claude.aoc('declare_plan', { phases: [{ id: 'p1', name: 'Work', tasks: [{ id: 't1', title: 'Work', size: 's' }] }] });
  const detail = () => h.api<SessionDetail>('GET', `/api/sessions/${s.sessionId}`, { as: owner });
  await waitFor(async () => (await detail()).liveness?.state === 'thinking', { what: 'Thinking' });
  return { owner, s, claude, sidecar, detail };
}

describe('(f) throttle', () => {
  it('a plan-limit message in the transcript → sidecar → throttle.hit → Throttled until the stated reset', async () => {
    const { owner, s, claude, sidecar, detail } = await running('Throttle');
    const before = Date.now();
    claude.transcript.assistant({ input: 10, output: 60, cacheRead: 300_000, cache1h: 2_000 }, [{ type: 'text', text: 'Next I will run the tests.' }]);
    // The API refuses the next request: Claude Code writes a synthetic assistant message, the turn ends on
    // StopFailure(rate_limit) and the -p process exits.
    claude.transcript.apiError(LIMIT);
    await claude.hook('StopFailure', { error: 'rate_limit', last_assistant_message: LIMIT });

    const d = await waitFor(async () => {
      const v = await detail();
      return v.liveness?.state === 'throttled' && v;
    }, { what: 'Throttled' });
    expect(d.liveness?.reason).toBe('plan_limit');
    expect(d.throttledUntil).toBe(next3pmKl(before));
    const hits = h.events({ types: ['throttle.hit'], sessionId: s.sessionId });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.meta).toMatchObject({ resetAt: next3pmKl(before) });
    const consoleView = await h.api<ConsoleSnapshot>('GET', '/api/console', { as: owner });
    expect(consoleView.kpis.throttled).toBeGreaterThanOrEqual(1);

    // The process is gone, but Throttled outranks Dead (§4 precedence) until the reset.
    claude.killClaude();
    expect(await sidecar.exited).toBe(0);
    const after = await detail();
    expect(after.liveness?.state).toBe('throttled');
    // The synthetic error line carries zero usage: it is neither metered nor taken as the context size.
    expect(after.contextTokens).toBe(10 + 300_000 + 2_000);
    const usage = h.events({ types: ['usage.recorded'], sessionId: s.sessionId });
    expect(usage.map((e) => e.meta.model)).toEqual(['claude-opus-5-5']);
    await claude.close();
    expect(h.store.verifyChain().ok).toBe(true);
  });
});

describe('(g) process death', () => {
  it('the watched claude pid dies → the sidecar reports the exit → Dead (managed)', async () => {
    const { s, claude, sidecar, detail } = await running('Crash');
    claude.transcript.assistant({ input: 4, output: 20, cacheRead: 50_000 }, [{ type: 'text', text: 'Refactoring…' }]);

    claude.killClaude('SIGKILL');
    const d = await waitFor(async () => {
      const v = await detail();
      return v.liveness?.state === 'dead' && v;
    }, { what: 'Dead' });
    expect(d.liveness?.reason).toBe('process_exited');
    expect(d.lifecycle).toBe('running'); // lifecycle is the supervisor's; liveness is derived from signals
    // The sidecar flushes what the dead process wrote, reports the exit, and stops.
    expect(await sidecar.exited).toBe(0);
    expect(h.events({ types: ['usage.recorded'], sessionId: s.sessionId })).toHaveLength(1);
    const changes = h.events({ types: ['session.liveness_changed'], sessionId: s.sessionId }).map((e) => e.meta.to);
    expect(changes.at(-1)).toBe('dead');
    // Heartbeats are never chained; only the state changes are (§13).
    expect(changes.length).toBeLessThan(10);
    await claude.close();
    expect(h.store.verifyChain().ok).toBe(true);
  });
});
