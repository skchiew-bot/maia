/** Process-type registry and playbook events (owner: mod-registry). */
import { z } from 'zod';
import { defineEvent, meta, payload, zId, zLabel } from './define';

/** Length caps on a playbook's text (O-17): an approved playbook is injected into every run of its type. */
export const PLAYBOOK_TITLE_MAX = 200;
export const PLAYBOOK_STEPS_MAX = 100;
export const PLAYBOOK_STEP_TITLE_MAX = 200;
export const PLAYBOOK_STEP_DETAIL_MAX = 2000;
export const PLAYBOOK_RATIONALE_MAX = 4000;

export const REGISTRY_EVENTS = [
  defineEvent({
    type: 'registry.changed',
    owner: 'registry',
    description: 'The fixed process-type registry file changed (detected at startup; audited, §2.2).',
    meta: meta({ versionHash: z.string().max(64), previousHash: z.string().max(64).nullable(), typeCount: z.number().int().min(0) }),
    payload: payload({
      diffSummary: z.string(),
      /** `version` field of the registry file. */
      registryVersion: z.string().optional(),
      /** The validated registry as loaded — the audit trail of what the fixed list was, and the base of the next diff. */
      snapshot: z.unknown().optional(),
    }),
  }),
  defineEvent({
    type: 'playbook.proposed',
    owner: 'registry',
    description: 'Distilled playbook proposed from a successful discovery run; needs Approver sign-off.',
    meta: meta({
      playbookId: zId,
      processType: zLabel,
      sourceSessionId: zId.nullable(),
      version: z.number().int().min(1),
      stepCount: z.number().int().min(1),
      decisionId: zId,
      /** llm = refined by the distillation model; fallback = deterministic ordered task titles. */
      method: z.enum(['llm', 'fallback']),
      /**
       * Provenance (O-17), absent on events written before it: every session of the run (the most recent ones),
       * the ticket it worked on, and the sessions that read untrusted input.
       */
      sourceSessionIds: z.array(zId).max(20).optional(),
      ticketId: zId.nullable().optional(),
      untrustedSessionIds: z.array(zId).max(20).optional(),
    }),
    payload: payload({
      title: z.string().max(PLAYBOOK_TITLE_MAX),
      steps: z
        .array(
          z.object({
            id: zId,
            title: z.string().max(PLAYBOOK_STEP_TITLE_MAX),
            detail: z.string().max(PLAYBOOK_STEP_DETAIL_MAX).optional(),
          }),
        )
        .max(PLAYBOOK_STEPS_MAX),
      rationale: z.string().max(PLAYBOOK_RATIONALE_MAX).optional(),
    }),
  }),
  defineEvent({
    type: 'playbook.approved',
    owner: 'registry',
    description: 'Playbook approved; execution runs of that process type follow it.',
    meta: meta({ playbookId: zId, decisionId: zId, approverId: z.string().max(64) }),
    payload: null,
  }),
  defineEvent({
    type: 'playbook.rejected',
    owner: 'registry',
    description: 'Playbook rejected.',
    meta: meta({ playbookId: zId, decisionId: zId, approverId: z.string().max(64) }),
    payload: null,
  }),
  defineEvent({
    type: 'playbook.retired',
    owner: 'registry',
    description: 'Playbook retired (manual / obsolete / quality, superseded by a newer approved version, or its approval decision withdrawn).',
    meta: meta({ playbookId: zId, reason: zLabel }),
    payload: null,
  }),
] as const;
