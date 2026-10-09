/**
 * Liveness (spec §4): "Waiting on you > Throttled > Dead > Stalled > Thinking > Working", derived from instrumented
 * events and chained only when the state changes.
 *
 * 1. deriveLiveness against an oracle written from the precedence list: every state whose condition holds is a
 *    candidate, the highest-precedence candidate wins, and a live session with no candidate is Thinking. Random
 *    inputs sit on both sides of every threshold. Metamorphic checks: a condition that outranks the current answer
 *    always changes it, and one that does not never does.
 * 2. The sessions engine under random signals (heartbeats, tool calls, stream activity, process exits, decisions,
 *    throttles, lifecycle changes, time): the chained session.liveness_changed events form an unbroken sequence in
 *    which every event is a real change, equal to the sequence of distinct states the oracle sees; a heartbeat that
 *    changes nothing writes nothing; an ended session stays out of the picture whatever arrives later.
 * The failing seed is printed; replay it with AOC_SEED=<n>.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LIVENESS_THRESHOLDS,
  LIVENESS_STATES,
  SESSION_LIFECYCLE,
  deriveLiveness,
  type LivenessInput,
  type LivenessState,
  type LivenessThresholds,
  type SessionLifecycle,
} from '@aoc/contracts';
import { createTestRuntime, forSeeds, type Rng, type TestRuntime } from '@aoc/kernel';
import { SessionsEngine, createSessionsModule } from '../src';

const T = DEFAULT_LIVENESS_THRESHOLDS;
const rank = (s: LivenessState) => LIVENESS_STATES.indexOf(s);

// ── 1. the pure derivation ────────────────────────────────────────────────────────────────────────────────

/** Every state whose condition holds, the highest precedence wins; a live session that is none of them is thinking. */
function oracle(i: LivenessInput, now: number, t: LivenessThresholds = T): LivenessState | null {
  if (i.lifecycle === 'ended' || i.lifecycle === 'retired') return null;
  const candidates: LivenessState[] = [];
  if (i.openDecisions > 0 || ['waiting_decision', 'blocked', 'idle'].includes(i.lifecycle)) candidates.push('waiting_on_you');
  if (i.lifecycle === 'throttled' || (i.throttledUntil !== null && now < i.throttledUntil)) candidates.push('throttled');
  const silent = i.lastHeartbeatAt !== null && now - i.lastHeartbeatAt > t.deadAfterMs;
  const neverReported = i.lastHeartbeatAt === null && i.lifecycle === 'running' && now - i.startedAt > 2 * t.deadAfterMs;
  if (i.lifecycle === 'failed' || i.processAlive === false || silent || neverReported) candidates.push('dead');
  const lastActivity = Math.max(i.startedAt, i.lastToolActivityAt ?? 0, i.lastStreamActivityAt ?? 0);
  if (i.toolInFlightSince !== null ? now - i.toolInFlightSince > t.toolStallAfterMs : now - lastActivity > t.stallAfterMs) candidates.push('stalled');
  if (i.toolInFlightSince !== null ? now - i.toolInFlightSince <= t.toolStallAfterMs : i.lastToolActivityAt !== null && now - i.lastToolActivityAt <= t.workingWindowMs)
    candidates.push('working');
  return candidates.length ? candidates.reduce((best, s) => (rank(s) < rank(best) ? s : best)) : 'thinking';
}

/** A time before `now`, mostly near one of the thresholds (just under, just over) and never exactly on one. */
function ago(rng: Rng, now: number): number {
  const edges = [T.workingWindowMs, T.deadAfterMs, T.deadAfterMs * 2, T.stallAfterMs, T.toolStallAfterMs];
  const base = rng.pick([0, 1000, 5000, ...edges, 3 * T.stallAfterMs]);
  return now - Math.max(0, base + rng.pick([-700, -1, 1, 700]));
}

function randomInput(rng: Rng, now: number): LivenessInput {
  const maybe = <V>(p: number, f: () => V): V | null => (rng.chance(p) ? f() : null);
  return {
    lifecycle: rng.pick(SESSION_LIFECYCLE),
    processAlive: rng.pick([null, true, false]),
    startedAt: ago(rng, now),
    lastHeartbeatAt: maybe(0.75, () => ago(rng, now)),
    lastToolActivityAt: maybe(0.6, () => ago(rng, now)),
    toolInFlightSince: maybe(0.3, () => ago(rng, now)),
    lastStreamActivityAt: maybe(0.6, () => ago(rng, now)),
    openDecisions: rng.pick([0, 0, 0, 1, 2]),
    throttledUntil: maybe(0.25, () => now + rng.pick([-5000, -1, 1, 60_000])),
  };
}

describe('deriveLiveness against the precedence list (§4)', () => {
  const NOW = 1_800_000_000_000;

  it('is the highest-precedence state whose condition holds, for inputs on both sides of every threshold', async () => {
    await forSeeds(
      'liveness derivation',
      (rng, seed) => {
        const problems: string[] = [];
        for (let n = 0; n < 4000; n++) {
          const input = randomInput(rng, NOW);
          const got = deriveLiveness(input, NOW).state;
          const want = oracle(input, NOW);
          if (got !== want) problems.push(`${got} ≠ ${want} for ${JSON.stringify(input)}`);
          if (problems.length >= 5) break;
        }
        expect(problems.join('\n'), `seed ${seed}`).toBe('');
      },
      { count: 6 },
    );
  });

  it('a state that outranks the current answer replaces it; one that does not leaves it alone', async () => {
    await forSeeds(
      'liveness metamorphic',
      (rng, seed) => {
        const problems: string[] = [];
        for (let n = 0; n < 3000; n++) {
          const base = randomInput(rng, NOW);
          const state = deriveLiveness(base, NOW).state;
          if (state === null) {
            // Not live: nothing changes that.
            const noisy = deriveLiveness({ ...base, openDecisions: 3, processAlive: false, throttledUntil: NOW + 10_000 }, NOW).state;
            if (noisy !== null) problems.push(`an ended session became ${noisy}`);
            continue;
          }
          const adds: [LivenessState, Partial<LivenessInput>][] = [
            ['waiting_on_you', { openDecisions: base.openDecisions + 1 }],
            ['throttled', { throttledUntil: NOW + 30_000 }],
            ['dead', { processAlive: false }],
          ];
          for (const [added, patch] of adds) {
            const after = deriveLiveness({ ...base, ...patch }, NOW).state!;
            // The new condition holds, so the answer is at least as severe as it, and never less severe than before.
            if (rank(after) > rank(added)) problems.push(`adding ${added} gave ${after} for ${JSON.stringify(base)}`);
            if (rank(after) > rank(state)) problems.push(`adding ${added} lowered ${state} to ${after} for ${JSON.stringify(base)}`);
            if (rank(state) <= rank(added) && after !== state) problems.push(`adding ${added} changed ${state} to ${after}: it does not outrank it`);
          }
          if (problems.length >= 5) break;
        }
        expect(problems.join('\n'), `seed ${seed}`).toBe('');
      },
      { count: 6 },
    );
  });
});

// ── 2. the engine ─────────────────────────────────────────────────────────────────────────────────────────

let t: TestRuntime | undefined;
afterEach(async () => t?.close());

describe('chained liveness changes (§4: only state changes are audited)', () => {
  it('the chain is unbroken, every event is a change, and it equals the states the oracle sees', async () => {
    const reached = { changes: 0, states: new Set<string>(), noops: 0, afterEnd: 0 };
    await forSeeds(
      'liveness chain',
      async (rng, seed) => {
        t = await createTestRuntime({ modules: [createSessionsModule({ sweepIntervalMs: 0 })] });
        const engine = t.rt.services.get('sessions') as unknown as SessionsEngine;
        const store = t.rt.store;
        const sys = { kind: 'system' as const, id: 'supervisor' };
        const ids = ['ses_a', 'ses_b'];
        const started = t.clock.now();

        // The model: what each session's signals are, kept the way the engine is documented to keep them.
        interface M {
          lifecycle: SessionLifecycle;
          processAlive: boolean | null;
          lastHeartbeatAt: number | null;
          lastToolAt: number | null;
          toolInFlightSince: number | null;
          lastStreamAt: number | null;
          openDecisions: Set<string>;
          throttledUntil: number | null;
          ended: boolean;
          seen: (LivenessState | null)[];
        }
        const m = new Map<string, M>();
        for (const id of ids) {
          store.append({
            type: 'session.launch_requested',
            actor: sys,
            scope: { sessionId: id, projectId: 'prj_l', threadId: 'thr_l' },
            meta: { sessionId: id, projectId: 'prj_l', threadId: 'thr_l', processType: 'feature-build', model: 'claude-opus-5-5', readOnly: false, credentialProfile: null, ticketId: null, parentSessionId: null, phaseId: null, ownerId: null },
            payload: { prompt: 'Build it', cwd: '/tmp/repo' },
            source: 'supervisor',
          });
          m.set(id, { lifecycle: 'launching', processAlive: null, lastHeartbeatAt: null, lastToolAt: null, toolInFlightSince: null, lastStreamAt: null, openDecisions: new Set(), throttledUntil: null, ended: false, seen: [null] });
        }
        let decisionNo = 0;
        const verdict = (id: string): LivenessState | null => {
          const s = m.get(id)!;
          return oracle(
            {
              lifecycle: s.ended ? 'ended' : s.lifecycle,
              processAlive: s.processAlive,
              startedAt: started,
              lastHeartbeatAt: s.lastHeartbeatAt,
              lastToolActivityAt: s.lastToolAt,
              toolInFlightSince: s.toolInFlightSince,
              lastStreamActivityAt: s.lastStreamAt,
              openDecisions: s.openDecisions.size,
              throttledUntil: s.throttledUntil,
            },
            t!.clock.now(),
          );
        };
        const problems: string[] = [];
        const log: string[] = [];
        const observe = (id: string, why: string) => {
          const s = m.get(id)!;
          const want = verdict(id);
          if (s.seen.at(-1) !== want) {
            s.seen.push(want);
            reached.states.add(String(want));
          }
          const got = engine.liveness(id)?.state ?? null;
          if (got !== want) problems.push(`${id} after ${why}: engine says ${got}, oracle says ${want}`);
        };
        /** The periodic sweep refreshes every live session, so the oracle observes every session after it. */
        const sweep = (why: string) => {
          engine.refreshAll();
          for (const other of ids) observe(other, why);
        };
        const chain = (id: string) => store.list({ sessionId: id, types: ['session.liveness_changed'] });

        const ops: Record<string, () => void> = {
          heartbeat: () => {
            const id = rng.pick(ids);
            const before = store.head().seq;
            const alive = rng.chance(0.85);
            const at = t!.clock.now();
            engine.heartbeat(id, at, alive, null);
            const s = m.get(id)!;
            s.lastHeartbeatAt = at;
            s.processAlive = alive;
            log.push(`heartbeat ${id} alive=${alive}`);
            observe(id, 'heartbeat');
            if (store.head().seq === before) reached.noops++;
          },
          toolStart: () => {
            const id = rng.pick(ids);
            engine.toolStarted(id, t!.clock.now());
            const s = m.get(id)!;
            s.toolInFlightSince = t!.clock.now();
            s.lastToolAt = t!.clock.now();
            log.push(`tool start ${id}`);
            observe(id, 'tool start');
          },
          toolEnd: () => {
            const id = rng.pick(ids);
            engine.toolFinished(id, t!.clock.now());
            const s = m.get(id)!;
            s.toolInFlightSince = null;
            s.lastToolAt = t!.clock.now();
            log.push(`tool end ${id}`);
            observe(id, 'tool end');
          },
          stream: () => {
            const id = rng.pick(ids);
            engine.recordActivity(id, 'stream', t!.clock.now());
            m.get(id)!.lastStreamAt = t!.clock.now();
            log.push(`stream ${id}`);
            observe(id, 'stream');
          },
          exit: () => {
            const id = rng.pick(ids);
            engine.processExited(id, null);
            const s = m.get(id)!;
            s.processAlive = false;
            s.toolInFlightSince = null;
            log.push(`process exited ${id}`);
            observe(id, 'process exit');
          },
          lifecycle: () => {
            const id = rng.pick(ids);
            const s = m.get(id)!;
            if (s.ended) return;
            const to = rng.pick(['launching', 'running', 'running', 'idle', 'waiting_decision', 'blocked', 'throttled', 'failed'] as const);
            store.append({ type: 'session.lifecycle_changed', actor: sys, scope: { sessionId: id }, meta: { sessionId: id, from: s.lifecycle, to, reason: 'test' }, source: 'supervisor' });
            s.lifecycle = to;
            log.push(`lifecycle ${id} → ${to}`);
            sweep(`lifecycle ${to}`);
          },
          openDecision: () => {
            const id = rng.pick(ids);
            const d = `dec_l${++decisionNo}`;
            store.append({
              type: 'decision.requested',
              actor: { kind: 'agent', id },
              scope: { decisionId: d, sessionId: id },
              meta: { decisionId: d, kind: 'agent_decision', test: 'ambiguity', requiredRole: 'builder', requiresPasskey: false, subjectType: 'session', subjectId: id, sessionId: id, projectId: null, optionIds: ['a', 'b'], recommendedOptionId: 'a', requesterId: `session:${id}`, excludedApproverIds: [`session:${id}`], eligibleUserIds: null, dueAt: null },
              payload: { title: 'Which?', question: 'Which one?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
              source: 'mcp',
            });
            m.get(id)!.openDecisions.add(d);
            log.push(`decision opened on ${id}`);
            sweep('decision opened');
          },
          closeDecision: () => {
            const id = rng.pick(ids);
            const s = m.get(id)!;
            const d = [...s.openDecisions][0];
            if (!d) return;
            const how = rng.pick(['resolved', 'withdrawn', 'expired'] as const);
            if (how === 'resolved')
              store.append({ type: 'decision.resolved', actor: { kind: 'human', id: 'usr_x' }, scope: { decisionId: d, sessionId: id }, meta: { decisionId: d, kind: 'agent_decision', optionId: 'a', resolvedBy: 'usr_x', method: 'button', passkeyVerified: false, selfApproved: false, ageMs: 1 }, payload: {}, source: 'api' });
            else if (how === 'withdrawn')
              store.append({ type: 'decision.withdrawn', actor: { kind: 'human', id: 'usr_x' }, scope: { decisionId: d, sessionId: id }, meta: { decisionId: d, reason: 'manual' }, payload: {}, source: 'api' });
            else store.append({ type: 'decision.expired', actor: { kind: 'system', id: 'sweeper' }, scope: { decisionId: d, sessionId: id }, meta: { decisionId: d, ageMs: 1 }, source: 'system' });
            s.openDecisions.delete(d);
            log.push(`decision ${how} on ${id}`);
            sweep(`decision ${how}`);
          },
          throttle: () => {
            const id = rng.pick(ids);
            const s = m.get(id)!;
            if (s.ended) return;
            const resetAt = t!.clock.now() + rng.pick([10_000, 60_000, 600_000]);
            store.append({ type: 'throttle.hit', actor: sys, scope: { sessionId: id }, meta: { sessionId: id, resetAt: new Date(resetAt).toISOString(), source: 'stream' }, payload: { message: 'limit' }, source: 'sidecar' });
            s.throttledUntil = resetAt;
            log.push(`throttle ${id} until +${resetAt - t!.clock.now()}ms`);
            sweep('throttle');
          },
          throttleClear: () => {
            const id = rng.pick(ids);
            const s = m.get(id)!;
            store.append({ type: 'throttle.cleared', actor: sys, scope: { sessionId: id }, meta: { sessionId: id, idleMs: 1000 }, source: 'system' });
            s.throttledUntil = null;
            log.push(`throttle cleared ${id}`);
            sweep('throttle cleared');
          },
          tick: () => {
            t!.clock.advance(rng.pick([1000, 10_000, 30_000, 31_000, 50_000, 5 * 60_000, 11 * 60_000, 25 * 60_000]));
            log.push(`time +… now ${t!.clock.iso()}`);
            sweep('a sweep');
          },
          end: () => {
            const id = rng.pick(ids);
            const s = m.get(id)!;
            if (s.ended) return;
            store.append({ type: 'session.ended', actor: sys, scope: { sessionId: id }, meta: { sessionId: id, outcome: rng.pick(['completed', 'killed', 'abandoned']) }, source: 'supervisor' });
            s.ended = true;
            log.push(`ended ${id}`);
            sweep('end');
          },
        };
        const weights: [string, number][] = [['heartbeat', 8], ['toolStart', 4], ['toolEnd', 4], ['stream', 4], ['exit', 1], ['lifecycle', 3], ['openDecision', 2], ['closeDecision', 2], ['throttle', 1], ['throttleClear', 1], ['tick', 8], ['end', 1]];
        for (let step = 0; step < 70; step++) {
          ops[rng.weighted(weights)]!();
          if (problems.length) break;
        }
        sweep('the final sweep');

        // A late signal for an ended session resurrects nothing.
        for (const id of ids) {
          if (!m.get(id)!.ended) continue;
          const before = store.head().seq;
          engine.heartbeat(id, t.clock.now(), true, null);
          engine.recordActivity(id, 'stream', t.clock.now());
          engine.toolStarted(id, t.clock.now());
          engine.refreshAll();
          if (store.head().seq !== before) problems.push(`${id}: a late signal after the end wrote ${store.head().seq - before} event(s)`);
          reached.afterEnd++;
        }

        // The chain: unbroken, every event a change, and the same sequence of states the oracle saw.
        for (const id of ids) {
          const events = chain(id);
          let prev: string | null = null;
          for (const e of events) {
            const meta = e.meta as { from: string | null; to: string | null };
            if (meta.from !== prev) problems.push(`${id}: event #${e.seq} says from ${meta.from} but the chain stood at ${prev}`);
            if (meta.from === meta.to) problems.push(`${id}: event #${e.seq} records no change (${meta.from} → ${meta.to})`);
            prev = meta.to;
          }
          const chained = events.map((e) => (e.meta as { to: LivenessState | null }).to);
          const seen = m.get(id)!.seen.slice(1);
          if (JSON.stringify(chained) !== JSON.stringify(seen)) problems.push(`${id}: chained ${JSON.stringify(chained)}, the oracle saw ${JSON.stringify(seen)}`);
          reached.changes += events.length;
        }
        // Heartbeats themselves are never chained.
        if (store.list({ typePrefix: 'session.heartbeat' }).length) problems.push('a heartbeat was chained');

        expect(problems.length ? `${problems.join('\n')}\n--- steps ---\n${log.join('\n')}` : '', `seed ${seed}`).toBe('');
        await t.close();
        t = undefined;
      },
      { count: 10 },
    );
    expect(reached.changes, 'state changes chained').toBeGreaterThan(40);
    expect(reached.states.size, 'distinct states reached').toBeGreaterThanOrEqual(6);
    expect(reached.noops, 'heartbeats that changed nothing').toBeGreaterThan(5);
    expect(reached.afterEnd, 'late signals for ended sessions').toBeGreaterThan(0);
  }, 120_000);
});
