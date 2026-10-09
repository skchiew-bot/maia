import type { JsonObject, JsonValue, StoredEvent } from '@aoc/contracts';
import type { NewEvent } from '@aoc/kernel';
import { createTowerProjector } from '../src/projector';
import type { Harness } from './helpers';
import { DAY, HOUR, MIN } from './helpers';

const SYS = { kind: 'system', id: 'load' } as const;
const PROJECTS = ['prj_a', 'prj_b', 'prj_c', 'prj_d'];
const TYPES = ['feature', 'bug-fix', 'docs', 'migration'];
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
/** Fewest events one generated session emits (a still-running one), so ceil(target / this) sessions reach the target. */
export const EVENTS_PER_SESSION = 59;

/**
 * Deterministic, catalog-valid history spread over `days`: sessions with manifests, evidence, usage batches,
 * liveness changes and decisions. Yields one batch per session with the time it happened.
 */
function* history(now: number, sessions: number, days: number): Generator<{ at: number; batch: NewEvent[] }> {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < sessions; i++) {
    const sessionId = `ses_load_${i}`;
    const projectId = PROJECTS[i % PROJECTS.length]!;
    const start = now - days * DAY + Math.floor((i / sessions) * days * DAY);
    const model = MODELS[i % MODELS.length]!;
    const live = i >= sessions - 12; // the newest sessions are still running
    const batch: NewEvent[] = [
      {
        type: 'session.launch_requested',
        actor: { kind: 'human', id: `usr_load_${i % 9}` },
        scope: { sessionId, projectId },
        meta: {
          sessionId,
          projectId,
          threadId: `thr_load_${i}`,
          processType: TYPES[i % TYPES.length]!,
          model,
          readOnly: false,
          credentialProfile: null,
          ticketId: null,
          parentSessionId: null,
          phaseId: null,
        },
        payload: { prompt: 'work', cwd: '/tmp' },
        source: 'supervisor',
      },
      {
        type: 'session.lifecycle_changed',
        actor: SYS,
        scope: { sessionId },
        meta: { sessionId, from: 'launching', to: 'running', reason: 'launched' },
        source: 'supervisor',
      },
      {
        type: 'session.liveness_changed',
        actor: SYS,
        scope: { sessionId },
        meta: { sessionId, from: null, to: 'thinking', reason: 'load' },
        source: 'system',
      },
      {
        type: 'session.liveness_changed',
        actor: SYS,
        scope: { sessionId },
        meta: { sessionId, from: 'thinking', to: 'working', reason: 'load' },
        source: 'system',
      },
      {
        type: 'plan.declared',
        actor: { kind: 'agent', id: sessionId },
        scope: { sessionId, projectId },
        meta: {
          sessionId,
          projectId,
          threadId: `thr_load_${i}`,
          manifestVersion: 1,
          phaseCount: 1,
          taskCount: 10,
          totalWeight: 17,
        },
        payload: {
          phases: [
            {
              id: 'p1',
              name: 'Build',
              tasks: Array.from({ length: 10 }, (_, k) => ({
                id: `t${k}`,
                title: `T${k}`,
                size: k < 3 ? 'xs' : 's',
              })),
            },
          ],
        },
        source: 'mcp',
      },
    ];
    for (let k = 0; k < 8; k++) {
      const verified = rnd() > 0.15;
      batch.push({
        type: 'task.done',
        actor: { kind: 'agent', id: sessionId },
        scope: { sessionId, projectId, taskId: `t${k}` },
        meta: {
          sessionId,
          projectId,
          taskId: `t${k}`,
          phaseId: 'p1',
          weight: k < 3 ? 1 : 2,
          evidenceKind: 'test',
          evidenceVerified: verified,
          flag: verified ? null : 'evidence_unverified',
          fileChangesSinceLast: 1,
        },
        payload: { evidence: { kind: 'test', ref: 'x' } },
        source: 'mcp',
      });
    }
    for (let k = 0; k < 44; k++) {
      const at = new Date(start + k * 2 * MIN).toISOString();
      batch.push({
        type: 'usage.recorded',
        actor: { kind: 'system', id: 'sidecar' },
        scope: { sessionId },
        meta: {
          sessionId,
          model,
          inputTokens: 1000 + k,
          outputTokens: 300,
          cacheReadTokens: 5000,
          cacheWrite5mTokens: 100,
          cacheWrite1hTokens: 0,
          messages: 1,
          contextTokens: 20_000 + k * 1000,
          firstAt: at,
          lastAt: at,
        },
        payload: { messageIds: [`m_${i}_${k}`] },
        source: 'sidecar',
      });
    }
    const decisionId = `dec_load_${i}`;
    batch.push({
      type: 'decision.requested',
      actor: SYS,
      scope: { decisionId, sessionId, projectId },
      meta: {
        decisionId,
        kind: 'agent_decision',
        test: 'irreversible',
        requiredRole: 'approver',
        requiresPasskey: false,
        subjectType: 'session',
        subjectId: sessionId,
        sessionId,
        projectId,
        optionIds: ['a', 'b'],
        recommendedOptionId: 'a',
        requesterId: `session:${sessionId}`,
        excludedApproverIds: [],
        eligibleUserIds: null,
        dueAt: null,
      },
      payload: {
        title: 'Pick a schema',
        question: 'Which?',
        options: [
          { id: 'a', label: 'A' },
          { id: 'b', label: 'B' },
        ],
      },
      source: 'api',
    });
    if (!live) {
      batch.push(
        {
          type: 'decision.resolved',
          actor: { kind: 'human', id: 'usr_load_0' },
          scope: { decisionId },
          meta: {
            decisionId,
            kind: 'agent_decision',
            optionId: 'a',
            resolvedBy: 'usr_load_0',
            method: 'button',
            passkeyVerified: false,
            selfApproved: false,
            ageMs: 600_000,
          },
          payload: {},
          source: 'api',
        },
        {
          type: 'session.liveness_changed',
          actor: SYS,
          scope: { sessionId },
          meta: { sessionId, from: 'working', to: null, reason: 'load' },
          source: 'system',
        },
        {
          type: 'session.ended',
          actor: SYS,
          scope: { sessionId },
          meta: { sessionId, outcome: 'completed' },
          source: 'supervisor',
        },
      );
    } else {
      batch.push({
        type: 'session.liveness_changed',
        actor: SYS,
        scope: { sessionId },
        meta: { sessionId, from: 'working', to: i % 3 === 0 ? 'stalled' : 'working', reason: 'load' },
        source: 'system',
      });
    }
    yield { at: live ? now - (sessions - i) * 5 * MIN : start + 2 * HOUR, batch };
  }
}

/** Append ~`target` events through the real store (hash chain, encrypted bodies, every projector). */
export function appendHistory(h: Harness, target: number, days = 30): number {
  const now = h.t.clock.now();
  let appended = 0;
  for (const { at, batch } of history(now, Math.ceil(target / EVENTS_PER_SESSION), days)) {
    h.t.clock.set(at);
    h.t.rt.store.appendMany(batch);
    appended += batch.length;
  }
  h.t.clock.set(now);
  return appended;
}

/**
 * Feed ~`target` events straight into a tower projector on the harness database (one transaction). Builds the same
 * read models without the chain's per-event hashing and encryption, so read-path timing can be measured at scale.
 */
export function projectHistory(h: Harness, target: number, days = 30): number {
  const db = h.t.rt.store.db;
  const projector = createTowerProjector();
  let seq = h.t.rt.store.head().seq;
  db.exec('BEGIN');
  try {
    for (const { at, batch } of history(h.t.clock.now(), Math.ceil(target / EVENTS_PER_SESSION), days)) {
      for (const input of batch) {
        seq++;
        const e: StoredEvent = {
          seq,
          id: `evt_load_${seq}`,
          ts: new Date(at).toISOString(),
          type: input.type,
          actor: input.actor,
          scope: input.scope ?? {},
          meta: input.meta as JsonObject,
          payloadHash: null,
          bodyScope: null,
          source: input.source,
          sourceTs: null,
          idempotencyKey: null,
          causationId: null,
          prevHash: '',
          hash: '',
        };
        projector.apply({ db, replaying: true }, e, (input.payload ?? null) as JsonValue | null);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return seq - h.t.rt.store.head().seq;
}
