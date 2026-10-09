/** Audit-integrity events (owner: mod-audit, §13). */
import { z } from 'zod';
import { defineEvent, meta, payload, zHash, zId, zLabel } from './define';

/** `aoc-backup-<UTC yyyymmddThhmmssZ>-<8 id chars>.aocbk` — generated, never user text. */
export const BACKUP_FILE_RE = /^aoc-backup-\d{8}T\d{6}Z-[0-9A-Z]{8}\.aocbk$/;
const zKeyId = z.string().regex(/^[0-9a-f]{16}$/);
const zCount = z.number().int().min(0);
export const BACKUP_STAGES = ['key', 'snapshot', 'package', 'copy', 'prune'] as const;

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
  defineEvent({
    type: 'backup.completed',
    owner: 'audit',
    description:
      'Encrypted backup of the event log, the body store, blobs, RFC 3161 tokens and evidence packs written (G-21, R6). Never contains the KEK.',
    meta: meta({
      backupId: zId,
      file: z.string().regex(BACKUP_FILE_RE),
      /** Size and SHA-256 of the encrypted file: an off-host copy can be checked without the key. */
      bytes: zCount,
      sha256: zHash,
      /** Fingerprints (not the keys): which backup key decrypts the file, which KEK unwraps its bodies. */
      keyId: zKeyId,
      kekId: zKeyId,
      /** Chain head inside the backup. */
      headSeq: zCount,
      headHash: zHash,
      files: zCount,
      aocDbBytes: zCount,
      bodiesDbBytes: zCount,
      blobs: zCount,
      blobBytes: zCount,
      /** Blob files already gone when they were copied (their scope was being erased). */
      skippedBlobs: zCount,
      /** Events whose body was already absent (not erased) in the live store when the snapshot was taken. */
      bodiesMissing: zCount,
      /** backupCopyCommand result (null = no copy command configured). */
      copied: z.boolean().nullable(),
      pruned: zCount,
      retained: zCount,
    }),
    payload: null,
  }),
  defineEvent({
    type: 'backup.failed',
    owner: 'audit',
    description: 'A backup step failed: backup key checks, snapshot, packaging, the off-host copy or retention pruning.',
    meta: meta({ backupId: zId.nullable(), stage: z.enum(BACKUP_STAGES), reason: zLabel }),
    payload: payload({ detail: z.string().optional() }),
  }),
] as const;
