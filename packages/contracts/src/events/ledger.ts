/** Build-ledger events (owner: mod-ledger). Plan manifests, tasks with evidence, phases, drift, enhancements (§1, §4, §9). */
import { z } from 'zod';
import { EVIDENCE_KINDS, PLAYBOOK_STEP_STATES, TASK_SIZES } from '../mcp';
import { defineEvent, meta, payload, zId, zLabel, zNonNeg } from './define';

const task = z.object({ id: zId, title: z.string(), size: z.enum(TASK_SIZES), acceptance: z.string().optional() });

export const LEDGER_EVENTS = [
  defineEvent({
    type: 'project.created',
    owner: 'ledger',
    description: 'A project (the unit of work, §1) was created.',
    meta: meta({ projectId: zId, slug: zLabel }),
    payload: payload({ name: z.string(), description: z.string().optional(), repoPath: z.string().optional(), defaultBranch: z.string().optional() }),
  }),
  defineEvent({
    type: 'project.updated',
    owner: 'ledger',
    description: 'Project settings changed.',
    meta: meta({ projectId: zId }),
    payload: payload({ name: z.string().optional(), description: z.string().optional(), repoPath: z.string().optional(), defaultBranch: z.string().optional() }),
  }),
  defineEvent({
    type: 'thread.created',
    owner: 'ledger',
    description: 'A durable project thread (spans many disposable sessions, §5).',
    meta: meta({ threadId: zId, projectId: zId }),
    payload: payload({ title: z.string() }),
  }),
  defineEvent({
    type: 'thread.writer_acquired',
    owner: 'ledger',
    description: 'A session became the single active writer of a thread.',
    meta: meta({ threadId: zId, sessionId: zId }),
    payload: null,
  }),
  defineEvent({
    type: 'thread.writer_released',
    owner: 'ledger',
    description: 'The active writer released the thread.',
    meta: meta({ threadId: zId, sessionId: zId, reason: z.enum(['ended', 'rollover', 'failed', 'stopped']) }),
    payload: null,
  }),
  defineEvent({
    type: 'plan.declared',
    owner: 'ledger',
    description: 'Plan manifest declared at session start (a session without one is blocked, §4).',
    meta: meta({
      sessionId: zId,
      projectId: zId,
      threadId: zId.nullable(),
      manifestVersion: z.number().int().min(1),
      phaseCount: z.number().int().min(1),
      taskCount: z.number().int().min(1),
      totalWeight: zNonNeg,
    }),
    payload: payload({ summary: z.string().optional(), phases: z.array(z.object({ id: zId, name: z.string(), tasks: z.array(task) })) }),
  }),
  defineEvent({
    type: 'plan.amended',
    owner: 'ledger',
    description: 'Audited manifest amendment; visibly changes the denominator (§4, §9).',
    meta: meta({
      sessionId: zId,
      projectId: zId,
      manifestVersion: z.number().int().min(2),
      added: z.number().int().min(0),
      removed: z.number().int().min(0),
      resized: z.number().int().min(0),
      prevTotalWeight: zNonNeg,
      newTotalWeight: zNonNeg,
    }),
    payload: payload({
      reason: z.string(),
      add: z.array(task.extend({ phaseId: zId, phaseName: z.string().optional() })).optional(),
      remove: z.array(zId).optional(),
      resize: z.array(z.object({ taskId: zId, size: z.enum(TASK_SIZES) })).optional(),
    }),
  }),
  defineEvent({
    type: 'task.done',
    owner: 'ledger',
    description: 'Task closed with evidence; flagged when no file change happened since the previous close (§4, R9).',
    meta: meta({
      sessionId: zId,
      projectId: zId,
      taskId: zId,
      phaseId: zId,
      weight: zNonNeg,
      evidenceKind: z.enum(EVIDENCE_KINDS),
      evidenceVerified: z.boolean(),
      flag: z.enum(['no_file_change', 'evidence_unverified']).nullable(),
      fileChangesSinceLast: z.number().int().min(0),
    }),
    payload: payload({ evidence: z.object({ kind: z.enum(EVIDENCE_KINDS), ref: z.string(), detail: z.string().optional() }) }),
  }),
  defineEvent({
    type: 'phase.completed',
    owner: 'ledger',
    description: 'All tasks of a phase done; pins an immutable git tag/SHA for rollback (§8).',
    meta: meta({ sessionId: zId, projectId: zId, phaseId: zId, pinnedSha: z.string().max(64).nullable(), pinnedTag: z.string().max(200).nullable() }),
    payload: null,
  }),
  defineEvent({
    type: 'drift.detected',
    owner: 'ledger',
    description: 'Work drifted from the declared plan (amber drift mark on the timeline).',
    meta: meta({
      sessionId: zId,
      projectId: zId,
      kind: z.enum(['off_plan_change', 'playbook_deviation', 'scope_growth', 'overrun']),
      severity: z.enum(['low', 'medium', 'high']),
    }),
    payload: payload({ detail: z.string() }),
  }),
  defineEvent({
    type: 'enhancement.recorded',
    owner: 'ledger',
    description: 'An enhancement beyond the original plan was recorded (first-class build activity, §1).',
    meta: meta({ projectId: zId, sessionId: zId.nullable(), changeId: zId.nullable() }),
    payload: payload({ title: z.string(), detail: z.string().optional() }),
  }),
  defineEvent({
    type: 'playbook.step_reported',
    owner: 'ledger',
    description: 'Agent reported progress through a playbook step.',
    meta: meta({ sessionId: zId, playbookId: zId.nullable(), state: z.enum(PLAYBOOK_STEP_STATES) }),
    payload: payload({ step: z.string(), note: z.string().optional() }),
  }),
] as const;
