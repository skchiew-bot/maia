import type { StoredEvent } from '@aoc/contracts';
import type { Projector } from '@aoc/kernel';

/** Read models of mod-audit. Only chained meta is projected (no free text), so crypto-shred needs no scrubbing here. */
export const auditProjector: Projector = {
  name: 'audit',
  tables: [
    'aud_anchors',
    'aud_anchor_failures',
    'aud_verifications',
    'aud_config',
    'aud_erasures',
    'aud_erasure_requests',
    'aud_erasure_request_scopes',
    'aud_selfmod',
    'aud_backups',
    'aud_backup_failures',
  ],
  ddl: [
    `CREATE TABLE IF NOT EXISTS aud_anchors (
      anchor_id TEXT PRIMARY KEY, provider TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, proof_ref TEXT NOT NULL,
      signed INTEGER, pushed INTEGER, event_seq INTEGER NOT NULL, anchored_at TEXT NOT NULL)`,
    'CREATE INDEX IF NOT EXISTS aud_anchors_seq ON aud_anchors(seq)',
    'CREATE TABLE IF NOT EXISTS aud_anchor_failures (event_seq INTEGER PRIMARY KEY, provider TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL)',
    `CREATE TABLE IF NOT EXISTS aud_verifications (
      event_seq INTEGER PRIMARY KEY, at TEXT NOT NULL, ok INTEGER NOT NULL, head_seq INTEGER NOT NULL, checked INTEGER NOT NULL,
      anchors_checked INTEGER NOT NULL, anchors_matched INTEGER NOT NULL, first_bad_seq INTEGER)`,
    'CREATE TABLE IF NOT EXISTS aud_config (key TEXT PRIMARY KEY, version_hash TEXT NOT NULL, previous_hash TEXT, event_seq INTEGER NOT NULL, changed_at TEXT NOT NULL)',
    `CREATE TABLE IF NOT EXISTS aud_erasures (
      event_seq INTEGER PRIMARY KEY, scope_id TEXT NOT NULL, reason TEXT NOT NULL, erased_by TEXT NOT NULL, body_count INTEGER NOT NULL,
      decision_id TEXT, at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS aud_erasure_requests (
      request_id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE, reason TEXT NOT NULL, requester_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL, at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS aud_erasure_request_scopes (
      request_id TEXT NOT NULL, scope_id TEXT NOT NULL, PRIMARY KEY (request_id, scope_id))`,
    'CREATE TABLE IF NOT EXISTS aud_selfmod (event_seq INTEGER PRIMARY KEY, session_id TEXT NOT NULL, rule TEXT NOT NULL, path_hash TEXT NOT NULL, at TEXT NOT NULL)',
    `CREATE TABLE IF NOT EXISTS aud_backups (
      event_seq INTEGER PRIMARY KEY, backup_id TEXT NOT NULL, at TEXT NOT NULL, file TEXT NOT NULL, bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL, key_id TEXT NOT NULL, head_seq INTEGER NOT NULL, head_hash TEXT NOT NULL, copied INTEGER)`,
    'CREATE TABLE IF NOT EXISTS aud_backup_failures (event_seq INTEGER PRIMARY KEY, backup_id TEXT, stage TEXT NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL)',
  ],
  handles: [
    'anchor.created',
    'anchor.failed',
    'chain.verified',
    'config.changed',
    'body.erased',
    'erasure.requested',
    'selfmod.blocked',
    'backup.completed',
    'backup.failed',
  ],
  apply({ db }, e: StoredEvent) {
    const m = e.meta as Record<string, unknown>;
    const bool = (v: unknown) => (typeof v === 'boolean' ? (v ? 1 : 0) : null);
    switch (e.type) {
      case 'anchor.created':
        db.prepare('INSERT OR IGNORE INTO aud_anchors VALUES (?,?,?,?,?,?,?,?,?)').run(
          m.anchorId as string,
          m.provider as string,
          m.seq as number,
          m.hash as string,
          m.proofRef as string,
          bool(m.signed),
          bool(m.pushed),
          e.seq,
          e.ts,
        );
        break;
      case 'anchor.failed':
        db.prepare('INSERT OR IGNORE INTO aud_anchor_failures VALUES (?,?,?,?)').run(
          e.seq,
          m.provider as string,
          m.reason as string,
          e.ts,
        );
        break;
      case 'chain.verified':
        db.prepare('INSERT OR IGNORE INTO aud_verifications VALUES (?,?,?,?,?,?,?,?)').run(
          e.seq,
          e.ts,
          m.ok ? 1 : 0,
          m.headSeq as number,
          m.checked as number,
          m.anchorsChecked as number,
          m.anchorsMatched as number,
          (m.firstBadSeq as number | null) ?? null,
        );
        break;
      case 'config.changed':
        db.prepare(
          `INSERT INTO aud_config VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET version_hash=excluded.version_hash,
           previous_hash=excluded.previous_hash, event_seq=excluded.event_seq, changed_at=excluded.changed_at`,
        ).run(
          m.key as string,
          m.versionHash as string,
          (m.previousHash as string | null) ?? null,
          e.seq,
          e.ts,
        );
        break;
      case 'body.erased':
        db.prepare('INSERT OR IGNORE INTO aud_erasures VALUES (?,?,?,?,?,?,?)').run(
          e.seq,
          m.scopeId as string,
          m.reason as string,
          m.erasedBy as string,
          m.bodyCount as number,
          (m.decisionId as string | null) ?? null,
          e.ts,
        );
        break;
      case 'erasure.requested': {
        db.prepare('INSERT OR IGNORE INTO aud_erasure_requests VALUES (?,?,?,?,?,?)').run(
          m.requestId as string,
          m.decisionId as string,
          m.reason as string,
          e.actor.id,
          e.seq,
          e.ts,
        );
        const scope = db.prepare('INSERT OR IGNORE INTO aud_erasure_request_scopes VALUES (?,?)');
        for (const s of m.scopeIds as string[]) scope.run(m.requestId as string, s);
        break;
      }
      case 'selfmod.blocked':
        db.prepare('INSERT OR IGNORE INTO aud_selfmod VALUES (?,?,?,?,?)').run(
          e.seq,
          m.sessionId as string,
          m.rule as string,
          m.pathHash as string,
          e.ts,
        );
        break;
      case 'backup.completed':
        db.prepare('INSERT OR IGNORE INTO aud_backups VALUES (?,?,?,?,?,?,?,?,?,?)').run(
          e.seq,
          m.backupId as string,
          e.ts,
          m.file as string,
          m.bytes as number,
          m.sha256 as string,
          m.keyId as string,
          m.headSeq as number,
          m.headHash as string,
          bool(m.copied),
        );
        break;
      case 'backup.failed':
        db.prepare('INSERT OR IGNORE INTO aud_backup_failures VALUES (?,?,?,?,?)').run(
          e.seq,
          (m.backupId as string | null) ?? null,
          m.stage as string,
          m.reason as string,
          e.ts,
        );
        break;
      default:
        break;
    }
  },
};
