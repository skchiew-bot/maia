/** Process-type registry and playbook events (owner: mod-registry). */
import { z } from 'zod';
import { defineEvent, meta, payload, zId, zLabel } from './define';

export const REGISTRY_EVENTS = [
  defineEvent({
    type: 'registry.changed',
    owner: 'registry',
    description: 'The fixed process-type registry file changed (detected at startup; audited, §2.2).',
    meta: meta({ versionHash: z.string().max(64), previousHash: z.string().max(64).nullable(), typeCount: z.number().int().min(0) }),
    payload: payload({ diffSummary: z.string() }),
  }),
  defineEvent({
    type: 'playbook.proposed',
    owner: 'registry',
    description: 'Distilled playbook proposed from a successful discovery run; needs Approver sign-off.',
    meta: meta({ playbookId: zId, processType: zLabel, sourceSessionId: zId.nullable(), version: z.number().int().min(1), stepCount: z.number().int().min(1), decisionId: zId }),
    payload: payload({ title: z.string(), steps: z.array(z.object({ id: zId, title: z.string(), detail: z.string().optional() })), rationale: z.string().optional() }),
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
    description: 'Playbook retired.',
    meta: meta({ playbookId: zId, reason: zLabel }),
    payload: null,
  }),
] as const;
