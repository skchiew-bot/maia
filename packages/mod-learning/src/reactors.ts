import type { JsonValue, MetaOf, StoredEvent } from '@aoc/contracts';
import { gateVerdict } from '@aoc/distill';
import type { Reactor } from '@aoc/kernel';
import { clip, LESSON_GATE, SYSTEM, type LearningEngine, type RecordErrorInput } from './engine';
import { reopensOn, REPEAT_THRESHOLD } from './rules';
import { toolErrorText } from './signature';

type Obj = Record<string, JsonValue>;
const obj = (p: JsonValue | null): Obj | null =>
  p && typeof p === 'object' && !Array.isArray(p) ? (p as Obj) : null;
const text = (v: JsonValue | undefined): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/**
 * Turns failures elsewhere in the platform into error occurrences: failed tool calls, UAT rejections (high
 * priority — they feed in first and weigh more), and rollbacks. One occurrence per source event (idempotent).
 */
export function sourcesReactor(engine: () => LearningEngine): Reactor {
  return {
    name: 'learning.sources',
    handles: ['tool.used', 'ticket.uat_result', 'rollback.verified', 'rollback.requested'],
    react(e, payload) {
      const input = occurrenceFrom(engine(), e, obj(payload));
      if (!input) return;
      engine().recordError(
        {
          ...input,
          sourceTs: e.sourceTs ?? e.ts,
          causationId: e.id,
          idempotencyKey: `error.observed:${e.id}`,
        },
        SYSTEM,
        'system',
      );
    },
  };
}

function latestSession(
  engine: LearningEngine,
  table: 'lrn_ticket_sessions' | 'lrn_change_sessions',
  key: 'ticket_id' | 'change_id',
  id: string | null,
): string | null {
  if (!id) return null;
  return (
    engine.one<{ session_id: string }>(
      `SELECT session_id FROM ${table} WHERE ${key} = ? ORDER BY seq DESC LIMIT 1`,
      id,
    )?.session_id ?? null
  );
}

function occurrenceFrom(engine: LearningEngine, e: StoredEvent, p: Obj | null): RecordErrorInput | null {
  switch (e.type) {
    case 'tool.used': {
      const m = e.meta as MetaOf<'tool.used'>;
      if (m.ok) return null;
      const paths = Array.isArray(p?.filePaths)
        ? p.filePaths.filter((x): x is string => typeof x === 'string')
        : [];
      return {
        source: 'tool',
        sessionId: m.sessionId,
        message: toolErrorText(text(p?.outputSummary)) ?? `${m.toolName} failed`,
        context: `tool ${m.toolName}: ${clip(text(p?.inputSummary) ?? '', 500)}`,
        filePath: paths[0] ?? null,
      };
    }
    case 'ticket.uat_result': {
      const m = e.meta as MetaOf<'ticket.uat_result'>;
      if (m.verdict !== 'fail') return null;
      // the requester is deliberately not carried over (R11); the build session links model and process type
      return {
        source: 'uat',
        priority: 'high',
        sessionId: latestSession(engine, 'lrn_ticket_sessions', 'ticket_id', m.ticketId),
        projectId: e.scope.projectId ?? null,
        ticketId: m.ticketId,
        message: text(p?.comment) ?? 'UAT rejected by the requester',
      };
    }
    case 'rollback.requested': {
      const m = e.meta as MetaOf<'rollback.requested'>;
      return {
        source: 'rollback',
        priority: 'high',
        sessionId: latestSession(engine, 'lrn_change_sessions', 'change_id', m.changeId),
        projectId: m.projectId,
        message: text(p?.reason) ?? 'rollback requested',
      };
    }
    case 'rollback.verified': {
      const m = e.meta as MetaOf<'rollback.verified'>;
      if (m.clean) return null;
      const rb = engine.one<{ project_id: string }>(
        'SELECT project_id FROM lrn_rollbacks WHERE rollback_id = ?',
        m.rollbackId,
      );
      return {
        source: 'rollback',
        sessionId: null,
        projectId: e.scope.projectId ?? rb?.project_id ?? null,
        message: text(p?.report) ?? `rollback verification failed (${m.testsFailed} failing tests)`,
      };
    }
    default:
      return null;
  }
}

/**
 * Rule assignment: a signature a human already placed in a class goes to that class. When a human assigns,
 * earlier same-signature occurrences that are unassigned or only machine-assigned follow (human > ai/rule).
 */
export function ruleReactor(engine: () => LearningEngine): Reactor {
  return {
    name: 'learning.rule-assign',
    handles: ['error.observed', 'rootcause.assigned'],
    react(e) {
      const eng = engine();
      if (e.type === 'error.observed') {
        const { errorId } = e.meta as MetaOf<'error.observed'>;
        const row = eng.errorRow(errorId);
        if (!row || row.class_id) return;
        const human = eng.one<{ class_id: string }>(
          "SELECT class_id FROM lrn_errors WHERE signature = ? AND assigned_by = 'human' ORDER BY assigned_seq DESC LIMIT 1",
          row.signature,
        );
        if (human)
          eng.assign(errorId, human.class_id, 'rule', 1, SYSTEM, {
            source: 'system',
            causationId: e.id,
            idempotencyKey: `rootcause.rule:${errorId}:${e.id}`,
          });
        return;
      }
      const m = e.meta as MetaOf<'rootcause.assigned'>;
      if (m.assignedBy !== 'human') return;
      const row = eng.errorRow(m.errorId);
      if (!row || row.class_id !== m.classId || row.assigned_by !== 'human') return; // superseded by a later decision
      const latest = eng.one<{ error_id: string }>(
        "SELECT error_id FROM lrn_errors WHERE signature = ? AND assigned_by = 'human' ORDER BY assigned_seq DESC LIMIT 1",
        row.signature,
      );
      if (latest?.error_id !== m.errorId) return;
      const targets = eng.all<{ error_id: string }>(
        "SELECT error_id FROM lrn_errors WHERE signature = ? AND error_id <> ? AND (class_id IS NULL OR (assigned_by IN ('ai','rule') AND class_id <> ?)) ORDER BY seq",
        row.signature,
        m.errorId,
        m.classId,
      );
      if (!targets.length) return;
      eng.ctx.store.appendMany(
        targets.map((t) =>
          eng.assignEvent(t.error_id, m.classId, 'rule', 1, SYSTEM, {
            source: 'system',
            causationId: e.id,
            idempotencyKey: `rootcause.rule:${t.error_id}:${e.id}`,
          }),
        ),
      );
    },
  };
}

/** Repeat-offence detection (class reaches ≥2 occurrences) and reopen on any recurrence after a fix. */
export function offenceReactor(engine: () => LearningEngine): Reactor {
  return {
    name: 'learning.offences',
    handles: ['rootcause.assigned'],
    react(e) {
      const eng = engine();
      const { errorId, classId } = e.meta as MetaOf<'rootcause.assigned'>;
      const row = eng.errorRow(errorId);
      if (!row || row.class_id !== classId) return;
      const off = eng.offenceForClass(classId);
      if (!off) {
        const n = eng.one<{ n: number }>(
          'SELECT COUNT(*) AS n FROM lrn_errors WHERE class_id = ?',
          classId,
        )!.n;
        if (n >= REPEAT_THRESHOLD) eng.detectOffence(classId, e.id);
        return;
      }
      if (reopensOn(off.state) && off.fix_seq !== null && row.seq > off.fix_seq) {
        eng.transitionOffence(off, 'reopened', {}, SYSTEM, {
          source: 'system',
          causationId: e.id,
          idempotencyKey: `offence.reopened:${off.offence_id}:${off.fix_seq}`,
        });
      }
    },
  };
}

/**
 * Lesson binding follows the Approver gate: a person choosing bind → lesson.bound; anything else (reject, a
 * policy resolution, withdrawal, expiry) → lesson.rejected.
 */
export function lessonDecisionReactor(engine: () => LearningEngine): Reactor {
  return {
    name: 'learning.lesson-decisions',
    handles: ['decision.resolved', 'decision.withdrawn', 'decision.expired'],
    react(e) {
      const verdict = gateVerdict(LESSON_GATE, e);
      if (!verdict) return;
      const eng = engine();
      const { decisionId } = e.meta as
        | MetaOf<'decision.resolved'>
        | MetaOf<'decision.withdrawn'>
        | MetaOf<'decision.expired'>;
      const lesson = eng.one<{ lesson_id: string; status: string }>(
        'SELECT lesson_id, status FROM lrn_lessons WHERE decision_id = ?',
        decisionId,
      );
      if (!lesson || lesson.status !== 'proposed') return;
      eng.ctx.store.append({
        type: verdict === 'approved' ? 'lesson.bound' : 'lesson.rejected',
        actor: SYSTEM,
        meta: { lessonId: lesson.lesson_id, decisionId },
        source: 'system',
        causationId: e.id,
        idempotencyKey: `lesson.decided:${lesson.lesson_id}`,
      });
    },
  };
}
