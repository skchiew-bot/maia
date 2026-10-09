/** Evidence pack & compliance mapping events (owner: mod-evidence, §13, §14). */
import { z } from 'zod';
import { defineEvent, meta, payload, zId } from './define';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const EVIDENCE_EVENTS = [
  defineEvent({
    type: 'evidence_pack.generated',
    owner: 'evidence',
    description: 'Frozen, hash-verified, date-ranged, control-mapped evidence bundle generated.',
    meta: meta({
      packId: zId,
      from: day,
      to: day,
      packHash: z.string().length(64),
      eventCount: z.number().int().min(0),
      mappingVersion: z.string().max(40),
      mappingStamped: z.boolean(),
      rateCardVersion: z.number().int().min(0),
      chainOk: z.boolean(),
    }),
    payload: null,
  }),
  defineEvent({
    type: 'mapping.published',
    owner: 'evidence',
    description: 'A compliance-mapping version loaded/published (provisional until stamped).',
    meta: meta({ version: z.string().max(40), hash: z.string().length(64), rows: z.number().int().min(0) }),
    payload: null,
  }),
  defineEvent({
    type: 'mapping.stamped',
    owner: 'evidence',
    description: '"Mapping reviewed by compliance lead on X" stamp.',
    meta: meta({ version: z.string().max(40), hash: z.string().length(64), stampedBy: z.string().max(64) }),
    payload: payload({ note: z.string().optional() }),
  }),
] as const;
