/** Evidence pack & compliance mapping events (owner: mod-evidence, §13, §14). */
import { z } from 'zod';
import { defineEvent, meta, payload, zHash, zId, zIso } from './define';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().int().min(0);

export const EVIDENCE_EVENTS = [
  defineEvent({
    type: 'evidence_pack.generated',
    owner: 'evidence',
    description:
      'Frozen, hash-verified, date-ranged, control-mapped evidence bundle generated and stored write-once.',
    meta: meta({
      packId: zId,
      from: day,
      to: day,
      generatedAt: zIso,
      /** sha256 of the stored zip bytes; re-checked before every download. */
      packHash: zHash,
      bytes: count,
      eventCount: count,
      headSeq: count,
      mappingVersion: z.string().max(40),
      mappingHash: zHash,
      mappingStamped: z.boolean(),
      rateCardVersion: count,
      chainOk: z.boolean(),
      anchorsChecked: count,
      anchorsMatched: count,
    }),
    payload: null,
  }),
  defineEvent({
    type: 'evidence_pack.integrity_failed',
    owner: 'evidence',
    description:
      'A stored evidence pack no longer matches its recorded hash (altered or missing); the download was refused.',
    meta: meta({
      packId: zId,
      expectedHash: zHash,
      actualHash: zHash.nullable(),
      reason: z.enum(['hash_mismatch', 'missing']),
    }),
    payload: null,
  }),
  defineEvent({
    type: 'mapping.published',
    owner: 'evidence',
    description: 'A compliance-mapping version became active (provisional until stamped).',
    meta: meta({
      version: z.string().max(40),
      hash: zHash,
      rows: count,
      source: z.enum(['config', 'builtin']),
    }),
    payload: null,
  }),
  defineEvent({
    type: 'mapping.stamped',
    owner: 'evidence',
    description:
      '"Mapping reviewed by compliance lead on X" stamp, bound to the exact mapping hash reviewed.',
    meta: meta({ version: z.string().max(40), hash: zHash, stampedBy: z.string().max(64) }),
    payload: payload({ note: z.string().optional() }),
  }),
] as const;
