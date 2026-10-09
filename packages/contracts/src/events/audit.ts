/** Audit-integrity events (owner: mod-audit, §13). */
import { z } from 'zod';
import { defineEvent, meta, payload, zId, zLabel } from './define';

export const AUDIT_EVENTS = [
  defineEvent({
    type: 'anchor.created',
    owner: 'audit',
    description: 'Chain head anchored off-host (signed git commit to a separate repo, or RFC 3161 timestamp).',
    meta: meta({
      anchorId: zId,
      seq: z.number().int().min(1),
      hash: z.string().length(64),
      provider: z.enum(['git', 'rfc3161']),
      proofRef: z.string().max(300),
      /** git: the anchor commit was GPG-signed. */
      signed: z.boolean().optional(),
      /** git: the anchor commit reached the configured off-host remote (false = local only until the next push). */
      pushed: z.boolean().optional(),
    }),
    payload: null,
  }),
  defineEvent({
    type: 'anchor.failed',
    owner: 'audit',
    description: 'Anchoring failed (retried; alerts if the nightly anchor is missed).',
    meta: meta({ provider: z.enum(['git', 'rfc3161']), reason: zLabel }),
    payload: payload({ detail: z.string().optional() }),
  }),
  defineEvent({
    type: 'chain.verified',
    owner: 'audit',
    description: 'Verify run: recomputed chain tested against every external anchor.',
    meta: meta({
      ok: z.boolean(),
      headSeq: z.number().int().min(0),
      checked: z.number().int().min(0),
      anchorsChecked: z.number().int().min(0),
      anchorsMatched: z.number().int().min(0),
      firstBadSeq: z.number().int().nullable(),
      /** Events after the last anchor (not yet protected off-host). */
      unanchoredTail: z.number().int().min(0).optional(),
    }),
    payload: payload({ problems: z.array(z.string()) }),
  }),
  defineEvent({
    type: 'body.erased',
    owner: 'audit',
    description: 'Crypto-shred: a body-store key scope destroyed (PDPA erasure / leaked secret). Chain stays valid.',
    meta: meta({ scopeId: z.string().max(64), reason: z.enum(['pdpa_request', 'secret_leak', 'retention', 'other']), erasedBy: z.string().max(64), bodyCount: z.number().int().min(0), decisionId: zId.nullable() }),
    payload: null,
  }),
  defineEvent({
    type: 'selfmod.blocked',
    owner: 'audit',
    description: 'An AOC-managed agent attempted to modify the governance/audit/credit core (self-modification boundary).',
    meta: meta({
      sessionId: zId,
      rule: zLabel,
      pathHash: z.string().max(64),
      /** The attempt was also written to the external (outside-AOC) audit log. */
      externalLogged: z.boolean().optional(),
    }),
    payload: payload({ path: z.string(), toolName: z.string() }),
  }),
  defineEvent({
    type: 'config.changed',
    owner: 'audit',
    description: 'A governed configuration file changed (detected by hash at startup).',
    meta: meta({ key: zLabel, versionHash: z.string().max(64), previousHash: z.string().max(64).nullable() }),
    payload: null,
  }),
] as const;
