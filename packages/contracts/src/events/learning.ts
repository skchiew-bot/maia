/** Error-learning events (owner: mod-learning, §11). Root-cause classes only — never per-person blame (R11). */
import { z } from 'zod';
import { OFFENCE_STATES, ROOT_CAUSE_DIMENSIONS } from '../domain';
import { defineEvent, meta, payload, zId, zLabel, zNonNeg } from './define';

export const ERROR_SOURCES = ['tool', 'test', 'uat', 'rollback', 'hook', 'agent_report', 'ci'] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];
export const ERROR_PRIORITIES = ['normal', 'high'] as const;
export type ErrorPriority = (typeof ERROR_PRIORITIES)[number];
export const ROOT_CAUSE_ASSIGNERS = ['human', 'ai', 'rule'] as const;
export type RootCauseAssigner = (typeof ROOT_CAUSE_ASSIGNERS)[number];
/** Lessons are scoped to a process type or a code area — never global (R10). */
export const LESSON_SCOPE_TYPES = ['process_type', 'code_area'] as const;
export type LessonScopeType = (typeof LESSON_SCOPE_TYPES)[number];

export const LEARNING_EVENTS = [
  defineEvent({
    type: 'error.observed',
    owner: 'learning',
    description:
      'An error occurrence (tool failure, test failure, UAT failure, rollback cause, agent report). Carries the session id only for model/process-type analysis; never the person (R11).',
    meta: meta({
      errorId: zId,
      source: z.enum(ERROR_SOURCES),
      sessionId: zId.nullable(),
      projectId: zId.nullable(),
      processType: zLabel.nullable(),
      model: z.string().max(80).nullable(),
      /** sha256 of the normalised message (numbers, hex, ids, paths, quoted values, timestamps stripped). */
      signature: z.string().max(64),
      /** Repo-relative code area (never an absolute path). */
      codeArea: z.string().max(200).nullable(),
      priority: z.enum(ERROR_PRIORITIES),
      /** Direct cost known at observation (usually 0); recurrence cost adds the session's usage in the window after the error. */
      costUsd: zNonNeg,
      costMs: zNonNeg,
    }),
    payload: payload({
      message: z.string(),
      context: z.string().optional(),
      fix: z.string().optional(),
      /** The reporter's own (unverified) root-cause label — a hint for classification, never authoritative. */
      rootCauseHint: z.string().optional(),
    }),
  }),
  defineEvent({
    type: 'rootcause.class_defined',
    owner: 'learning',
    description: 'A root-cause class (clusters occurrences by cause, not by error text).',
    meta: meta({ classId: zId, dimension: z.enum(ROOT_CAUSE_DIMENSIONS) }),
    payload: payload({ name: z.string(), description: z.string().optional() }),
  }),
  defineEvent({
    type: 'rootcause.assigned',
    owner: 'learning',
    description: 'An error occurrence was attributed to a root-cause class.',
    meta: meta({
      errorId: zId,
      classId: zId,
      assignedBy: z.enum(ROOT_CAUSE_ASSIGNERS),
      confidence: z.number().min(0).max(1),
    }),
    payload: null,
  }),
  defineEvent({
    type: 'offence.transitioned',
    owner: 'learning',
    description:
      'Repeat-offence lifecycle: detected → root_caused → fix_applied → verified_closed (or reopened).',
    meta: meta({
      offenceId: zId,
      classId: zId,
      from: z.enum(OFFENCE_STATES).nullable(),
      to: z.enum(OFFENCE_STATES),
      occurrences: z.number().int().min(0),
      costOfRecurrenceUsd: zNonNeg,
    }),
    payload: payload({ note: z.string().optional(), fix: z.string().optional() }),
  }),
  defineEvent({
    type: 'lesson.proposed',
    owner: 'learning',
    description:
      'Distilled lesson proposed; binding requires a human decision (one bad lesson corrupts the fleet).',
    meta: meta({
      lessonId: zId,
      classId: zId.nullable(),
      scopeType: z.enum(LESSON_SCOPE_TYPES),
      scopeValue: z.string().max(200),
      decisionId: zId,
    }),
    payload: payload({ rule: z.string(), fix: z.string(), rationale: z.string().optional() }),
  }),
  defineEvent({
    type: 'lesson.bound',
    owner: 'learning',
    description: 'Lesson approved and now injected into sessions in scope.',
    meta: meta({ lessonId: zId, decisionId: zId }),
    payload: null,
  }),
  defineEvent({
    type: 'lesson.rejected',
    owner: 'learning',
    description: 'Lesson rejected.',
    meta: meta({ lessonId: zId, decisionId: zId }),
    payload: null,
  }),
  defineEvent({
    type: 'lesson.applied',
    owner: 'learning',
    description: 'Lesson injected into a session (usage tracking for retirement and payoff).',
    meta: meta({ lessonId: zId, sessionId: zId }),
    payload: null,
  }),
  defineEvent({
    type: 'lesson.retired',
    owner: 'learning',
    description:
      'Lesson retired (unused for N runs, superseded, or manual) — keeps the rulebook small (R10).',
    meta: meta({
      lessonId: zId,
      reason: z.enum(['unused', 'superseded', 'manual']),
      runsUnused: z.number().int().min(0),
    }),
    payload: null,
  }),
] as const;
