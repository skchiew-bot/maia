/**
 * Core event catalog (lead-owned): sessions, tools, usage/throttle, decisions, prompts.
 * Emitted by supervisor, mod-sessions, hooks/sidecar ingest and mod-decisions; consumed by everyone.
 */
import { z } from 'zod';
import { DECISION_KINDS, LIVENESS_STATES, ROLES, SESSION_LIFECYCLE } from '../domain';
import { DECISION_TESTS } from '../mcp';
import { defineEvent, meta, payload, zId, zIso, zLabel, zNonNeg } from './define';

const liveness = z.enum(LIVENESS_STATES).nullable();

export const SESSION_EVENTS = [
  defineEvent({
    type: 'session.launch_requested',
    owner: 'supervisor',
    description: 'A managed session launch was requested (process type fixed at launch from the registry, §2.2).',
    meta: meta({
      sessionId: zId,
      projectId: zId,
      threadId: zId,
      processType: zLabel,
      model: zLabel,
      readOnly: z.boolean(),
      credentialProfile: zLabel.nullable(),
      ticketId: zId.nullable(),
      parentSessionId: zId.nullable(),
      phaseId: zId.nullable(),
      /**
       * The user the session belongs to (null: nobody, e.g. an intake triage run). Absent on events written
       * before it existed: projections then fall back to the human actor, else the parent session's owner.
       */
      ownerId: zId.nullable().optional(),
      /** Change record the session works under (its env carries AOC_CHANGE_ID). */
      changeId: zId.nullable().optional(),
    }),
    payload: payload({ prompt: z.string(), cwd: z.string() }),
  }),
  defineEvent({
    type: 'session.launched',
    owner: 'supervisor',
    description: 'The claude process for a managed session started.',
    meta: meta({ sessionId: zId, claudeSessionId: z.string().uuid(), pid: z.number().int(), model: zLabel, turn: z.number().int() }),
    payload: payload({ cwd: z.string(), argv: z.array(z.string()), transcriptPath: z.string() }),
  }),
  defineEvent({
    type: 'session.observed',
    owner: 'sessions',
    description: 'First sighting of an observed (non-managed) Claude Code session via global hooks — read-only.',
    meta: meta({ sessionId: zId, claudeSessionId: z.string().min(1).max(64), projectId: zId.nullable() }),
    payload: payload({ cwd: z.string(), transcriptPath: z.string() }),
  }),
  defineEvent({
    type: 'session.turn_started',
    owner: 'supervisor',
    description: 'A turn (one claude -p invocation) started.',
    meta: meta({
      sessionId: zId,
      turn: z.number().int().min(1),
      reason: z.enum(['launch', 'resume', 'nudge', 'restart', 'continue', 'topup', 'throttle_reset', 'decision_answered', 'operator_prompt', 'rollover']),
    }),
    payload: payload({ injectedText: z.string().optional() }),
  }),
  defineEvent({
    type: 'session.turn_ended',
    owner: 'supervisor',
    description: 'A turn ended (process exited).',
    meta: meta({
      sessionId: zId,
      turn: z.number().int().min(1),
      outcome: z.enum(['end_turn', 'decision', 'credit_cap', 'throttled', 'error', 'interrupted', 'crashed', 'stop_requested', 'rollover']),
      exitCode: z.number().int().nullable(),
      durationMs: zNonNeg,
    }),
    payload: payload({ resultText: z.string().optional() }),
  }),
  defineEvent({
    type: 'session.lifecycle_changed',
    owner: 'supervisor',
    description: 'Session lifecycle state changed.',
    meta: meta({ sessionId: zId, from: z.enum(SESSION_LIFECYCLE).nullable(), to: z.enum(SESSION_LIFECYCLE), reason: zLabel }),
    payload: null,
  }),
  defineEvent({
    type: 'session.liveness_changed',
    owner: 'sessions',
    description: 'Derived liveness state changed (heartbeats themselves are never chained, §13).',
    meta: meta({ sessionId: zId, from: liveness, to: liveness, reason: zLabel }),
    payload: null,
  }),
  defineEvent({
    type: 'session.nudged',
    owner: 'supervisor',
    description: 'Operator nudge: end the current turn and resume with operator text.',
    meta: meta({ sessionId: zId }),
    payload: payload({ text: z.string() }),
  }),
  defineEvent({
    type: 'session.restarted',
    owner: 'supervisor',
    description: 'Operator restart of a dead/stalled session (resume from its transcript).',
    meta: meta({ sessionId: zId }),
    payload: null,
  }),
  defineEvent({
    type: 'session.stop_requested',
    owner: 'supervisor',
    description: 'Operator asked the session to stop at the next task boundary (or now if idle).',
    meta: meta({ sessionId: zId, immediate: z.boolean() }),
    payload: payload({ reason: z.string().optional() }),
  }),
  defineEvent({
    type: 'session.blocked',
    owner: 'sessions',
    description: 'A guard or boundary check blocked the session.',
    meta: meta({
      sessionId: zId,
      reason: z.enum(['no_manifest', 'credit_cap', 'writer_lock', 'read_only', 'self_modification', 'protected_operation', 'diagnosis_budget']),
    }),
    payload: null,
  }),
  defineEvent({
    type: 'session.git_pushed',
    owner: 'supervisor',
    description:
      "A managed session pushed through the supervisor's push gateway (§3, R-02). The supervisor checked every ref against the session's credential profile and forwarded the allowed ones upstream with the credential only it holds. Ref names are agent-chosen text: they stay in the encrypted body.",
    meta: meta({
      sessionId: zId,
      credentialProfile: zLabel,
      refs: z.number().int().min(1),
      forwarded: z.number().int().min(0),
      refused: z.number().int().min(0),
      failed: z.number().int().min(0),
    }),
    payload: payload({
      results: z.array(
        z.object({
          ref: z.string(),
          oldSha: z.string(),
          newSha: z.string(),
          result: z.enum(['forwarded', 'refused', 'failed']),
          reason: z.string().nullable(),
        }),
      ),
    }),
  }),
  defineEvent({
    type: 'session.ended',
    owner: 'supervisor',
    description: 'Session finished for good.',
    meta: meta({ sessionId: zId, outcome: z.enum(['completed', 'failed', 'killed', 'retired', 'abandoned']) }),
    payload: null,
  }),
  defineEvent({
    type: 'session.rollover_started',
    owner: 'supervisor',
    description: 'Context rollover began at a clean task boundary; handoff brief distilled and validated (§5).',
    meta: meta({ threadId: zId, fromSessionId: zId, contextTokens: zNonNeg, contextPct: zNonNeg, briefHash: z.string() }),
    payload: payload({ brief: z.string() }),
  }),
  defineEvent({
    type: 'session.rollover_completed',
    owner: 'supervisor',
    description: 'Successor session launched and the old one retired.',
    meta: meta({ threadId: zId, fromSessionId: zId, toSessionId: zId }),
    payload: null,
  }),
  defineEvent({
    type: 'session.rollover_aborted',
    owner: 'supervisor',
    description: 'Rollover refused/aborted (not at a clean boundary, brief invalid, open decisions...).',
    meta: meta({ threadId: zId, fromSessionId: zId, reason: zLabel }),
    payload: payload({ problems: z.array(z.string()) }),
  }),
] as const;

export const ACTIVITY_EVENTS = [
  defineEvent({
    type: 'prompt.submitted',
    owner: 'sessions',
    description: 'A prompt entered the session (operator surface, supervisor injection, or developer terminal for observed sessions). Logged, never progress.',
    meta: meta({ sessionId: zId, origin: z.enum(['operator', 'supervisor', 'terminal']) }),
    payload: payload({ text: z.string() }),
  }),
  defineEvent({
    type: 'tool.used',
    owner: 'sessions',
    description: 'A tool call completed (PostToolUse). fileChanging marks Edit/Write/MultiEdit/NotebookEdit success.',
    meta: meta({
      sessionId: zId,
      toolName: z.string().min(1).max(128),
      fileChanging: z.boolean(),
      ok: z.boolean(),
      toolUseId: z.string().max(128).nullable(),
    }),
    payload: payload({ inputSummary: z.string(), outputSummary: z.string().optional(), filePaths: z.array(z.string()).optional() }),
  }),
  defineEvent({
    type: 'tool.denied',
    owner: 'sessions',
    description: 'A PreToolUse guard denied a tool call; may have raised a decision card.',
    meta: meta({
      sessionId: zId,
      toolName: z.string().min(1).max(128),
      guard: zLabel,
      decision: z.enum(['deny', 'ask']),
      decisionId: zId.nullable(),
    }),
    payload: payload({ reason: z.string(), inputSummary: z.string() }),
  }),
  defineEvent({
    type: 'usage.recorded',
    owner: 'sessions',
    description: 'Per-session token usage batch from the sidecar (deduped by message.id). Metering derives notional cost.',
    meta: meta({
      sessionId: zId,
      model: z.string().min(1).max(80),
      inputTokens: zNonNeg,
      outputTokens: zNonNeg,
      cacheReadTokens: zNonNeg,
      cacheWrite5mTokens: zNonNeg,
      cacheWrite1hTokens: zNonNeg,
      messages: z.number().int().min(1),
      contextTokens: zNonNeg,
      firstAt: zIso,
      lastAt: zIso,
    }),
    payload: payload({ messageIds: z.array(z.string()) }),
  }),
  defineEvent({
    type: 'throttle.hit',
    owner: 'sessions',
    description: 'Plan usage limit hit; session is Throttled until resetAt (§4, §10 idle-time metering).',
    meta: meta({ sessionId: zId, resetAt: zIso.nullable(), source: z.enum(['stream', 'transcript', 'exit']) }),
    payload: payload({ message: z.string() }),
  }),
  defineEvent({
    type: 'throttle.cleared',
    owner: 'sessions',
    description: 'Throttle cleared (session resumed); idleMs is productivity lost to throttling.',
    meta: meta({ sessionId: zId, idleMs: zNonNeg }),
    payload: null,
  }),
] as const;

const optionSchema = z.object({ id: zId, label: z.string(), description: z.string().optional() });

export const DECISION_EVENTS = [
  defineEvent({
    type: 'decision.requested',
    owner: 'decisions',
    description: 'A human-required decision card was raised.',
    meta: meta({
      decisionId: zId,
      kind: z.enum(DECISION_KINDS),
      test: z.enum(DECISION_TESTS).nullable(),
      requiredRole: z.enum(ROLES),
      requiresPasskey: z.boolean(),
      subjectType: zLabel,
      subjectId: zId,
      sessionId: zId.nullable(),
      projectId: zId.nullable(),
      optionIds: z.array(zId).min(1),
      recommendedOptionId: zId.nullable(),
      requesterId: z.string().max(64),
      /** Separation of duties: these users may never resolve this decision. */
      excludedApproverIds: z.array(z.string().max(64)),
      /** If set, only these users may resolve (e.g. the ticket requester for UAT sign-off). */
      eligibleUserIds: z.array(z.string().max(64)).nullable(),
      dueAt: zIso.nullable(),
    }),
    payload: payload({
      title: z.string(),
      question: z.string(),
      options: z.array(optionSchema),
      recommendation: z.object({ optionId: zId, rationale: z.string() }).optional(),
      context: z.string().optional(),
    }),
  }),
  defineEvent({
    type: 'decision.resolved',
    owner: 'decisions',
    description: 'A decision was resolved by an eligible human (or by explicit policy, e.g. the 25%-once credit auto-grant).',
    meta: meta({
      decisionId: zId,
      kind: z.enum(DECISION_KINDS),
      optionId: zId,
      resolvedBy: z.string().max(64),
      method: z.enum(['button', 'passkey', 'policy']),
      passkeyVerified: z.boolean(),
      selfApproved: z.boolean(),
      ageMs: zNonNeg,
    }),
    payload: payload({ comment: z.string().optional() }),
  }),
  defineEvent({
    type: 'decision.withdrawn',
    owner: 'decisions',
    description: 'Decision withdrawn (superseded, session ended, subject resolved elsewhere).',
    meta: meta({ decisionId: zId, reason: zLabel }),
    payload: payload({ note: z.string().optional() }),
  }),
  defineEvent({
    type: 'decision.expired',
    owner: 'decisions',
    description: 'Decision expired unanswered (policy-defined deadline passed).',
    meta: meta({ decisionId: zId, ageMs: zNonNeg }),
    payload: null,
  }),
  defineEvent({
    type: 'decision.escalated',
    owner: 'decisions',
    description: 'Decision escalated to a role (never back to the requester, §6).',
    meta: meta({ decisionId: zId, toRole: z.enum(ROLES), reason: zLabel }),
    payload: null,
  }),
] as const;

export const CORE_EVENTS = [...SESSION_EVENTS, ...ACTIVITY_EVENTS, ...DECISION_EVENTS] as const;
