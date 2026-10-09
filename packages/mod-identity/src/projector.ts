import type { DatabaseSync } from 'node:sqlite';
import type { IdentityTokenKind, MetaOf, PayloadOf, StoredEvent } from '@aoc/contracts';
import type { Projector } from '@aoc/kernel';

export const ERASED = '[erased]';

export interface UserRow {
  id: string;
  name: string;
  email: string | null;
  role: 'approver' | 'builder' | 'requester';
  compliance_lead: number;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface TokenRow {
  id: string;
  kind: IdentityTokenKind;
  prefix: string;
  hash: string;
  user_id: string | null;
  session_id: string | null;
  parent_id: string | null;
  label: string | null;
  created_at: string;
  created_by: string;
  expires_at: string | null;
  revoked_at: string | null;
  revoke_reason: string | null;
}

export interface PasskeyRow {
  id: string;
  user_id: string;
  credential_id: string | null;
  public_key: string | null;
  counter: number;
  transports: string | null;
  label: string | null;
  device_type: 'singleDevice' | 'multiDevice' | null;
  backed_up: number | null;
  created_at: string;
  last_used_at: string | null;
  removed_at: string | null;
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS idn_users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    role TEXT NOT NULL,
    compliance_lead INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_seq INTEGER NOT NULL,
    body_scope TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS idn_tokens (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    prefix TEXT NOT NULL,
    hash TEXT NOT NULL,
    user_id TEXT,
    session_id TEXT,
    parent_id TEXT,
    label TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    revoke_reason TEXT,
    body_scope TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idn_tokens_prefix ON idn_tokens(prefix)',
  'CREATE INDEX IF NOT EXISTS idn_tokens_user ON idn_tokens(user_id)',
  'CREATE INDEX IF NOT EXISTS idn_tokens_session ON idn_tokens(session_id)',
  'CREATE INDEX IF NOT EXISTS idn_tokens_parent ON idn_tokens(parent_id)',
  `CREATE TABLE IF NOT EXISTS idn_passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    credential_id TEXT,
    public_key TEXT,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    label TEXT,
    device_type TEXT,
    backed_up INTEGER,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    removed_at TEXT,
    body_scope TEXT
  )`,
  'CREATE INDEX IF NOT EXISTS idn_passkeys_user ON idn_passkeys(user_id)',
];

const HANDLES = [
  'user.created',
  'user.updated',
  'token.issued',
  'token.revoked',
  'passkey.registered',
  'passkey.removed',
  'passkey.counter_updated',
  'passkey.asserted',
] as const;

/** Read model for users, token metadata (hashes only) and passkeys. Payload null = crypto-shredded body. */
export const identityProjector: Projector = {
  name: 'identity',
  tables: ['idn_users', 'idn_tokens', 'idn_passkeys'],
  ddl: DDL,
  handles: HANDLES,
  apply({ db }, e, payload) {
    switch (e.type) {
      case 'user.created':
        return userCreated(db, e, payload as PayloadOf<'user.created'> | null);
      case 'user.updated':
        return userUpdated(db, e, payload as PayloadOf<'user.updated'> | null);
      case 'token.issued': {
        const m = e.meta as MetaOf<'token.issued'>;
        const p = payload as PayloadOf<'token.issued'> | null;
        db.prepare(
          `INSERT INTO idn_tokens (id, kind, prefix, hash, user_id, session_id, parent_id, label, created_at, created_by, expires_at, body_scope)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
        ).run(
          m.tokenId,
          m.kind,
          m.tokenPrefix,
          m.tokenHash,
          m.userId,
          m.sessionId,
          m.parentTokenId,
          p?.label ?? null,
          e.ts,
          e.actor.id,
          m.expiresAt,
          e.bodyScope,
        );
        return;
      }
      case 'token.revoked': {
        const m = e.meta as MetaOf<'token.revoked'>;
        db.prepare(
          'UPDATE idn_tokens SET revoked_at = ?, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL',
        ).run(e.ts, m.reason, m.tokenId);
        return;
      }
      case 'passkey.registered':
        return passkeyRegistered(db, e, payload as PayloadOf<'passkey.registered'> | null);
      case 'passkey.removed': {
        const m = e.meta as MetaOf<'passkey.removed'>;
        db.prepare('UPDATE idn_passkeys SET removed_at = ? WHERE id = ? AND removed_at IS NULL').run(
          e.ts,
          m.credentialIdHash,
        );
        return;
      }
      case 'passkey.counter_updated': {
        const m = e.meta as MetaOf<'passkey.counter_updated'>;
        db.prepare('UPDATE idn_passkeys SET counter = MAX(counter, ?) WHERE id = ?').run(
          m.counter,
          m.credentialIdHash,
        );
        return;
      }
      case 'passkey.asserted': {
        const m = e.meta as MetaOf<'passkey.asserted'>;
        db.prepare('UPDATE idn_passkeys SET last_used_at = ? WHERE id = ?').run(e.ts, m.credentialIdHash);
        return;
      }
    }
  },
  onErase(db, scopeId) {
    db.prepare('UPDATE idn_users SET name = ?, email = NULL WHERE body_scope = ?').run(ERASED, scopeId);
    db.prepare('UPDATE idn_tokens SET label = NULL WHERE body_scope = ?').run(scopeId);
    db.prepare(
      'UPDATE idn_passkeys SET label = NULL, credential_id = NULL, public_key = NULL WHERE body_scope = ?',
    ).run(scopeId);
  },
};

function userCreated(db: DatabaseSync, e: StoredEvent, p: PayloadOf<'user.created'> | null): void {
  const m = e.meta as MetaOf<'user.created'>;
  db.prepare(
    `INSERT INTO idn_users (id, name, email, role, compliance_lead, active, created_at, updated_at, created_seq, body_scope)
     VALUES (?,?,?,?,?,1,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
  ).run(
    m.userId,
    p?.name ?? ERASED,
    p?.email ?? null,
    m.role,
    m.complianceLead ? 1 : 0,
    e.ts,
    e.ts,
    e.seq,
    e.bodyScope,
  );
}

function userUpdated(db: DatabaseSync, e: StoredEvent, p: PayloadOf<'user.updated'> | null): void {
  const m = e.meta as MetaOf<'user.updated'>;
  const sets = ['updated_at = ?'];
  const args: (string | number | null)[] = [e.ts];
  if (m.role !== null) (sets.push('role = ?'), args.push(m.role));
  if (m.active !== null) (sets.push('active = ?'), args.push(m.active ? 1 : 0));
  if (m.complianceLead !== null) (sets.push('compliance_lead = ?'), args.push(m.complianceLead ? 1 : 0));
  if (typeof p?.name === 'string') (sets.push('name = ?'), args.push(p.name));
  if (p && p.email !== undefined) (sets.push('email = ?'), args.push(p.email ?? null));
  db.prepare(`UPDATE idn_users SET ${sets.join(', ')} WHERE id = ?`).run(...args, m.userId);
}

function passkeyRegistered(
  db: DatabaseSync,
  e: StoredEvent,
  p: PayloadOf<'passkey.registered'> | null,
): void {
  const m = e.meta as MetaOf<'passkey.registered'>;
  const c = p?.credential;
  db.prepare(
    `INSERT INTO idn_passkeys (id, user_id, credential_id, public_key, counter, transports, label, device_type, backed_up, created_at, last_used_at, removed_at, body_scope)
     VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)
     ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, credential_id = excluded.credential_id, public_key = excluded.public_key,
       counter = excluded.counter, transports = excluded.transports, label = excluded.label, device_type = excluded.device_type,
       backed_up = excluded.backed_up, created_at = excluded.created_at, last_used_at = NULL, removed_at = NULL, body_scope = excluded.body_scope`,
  ).run(
    m.credentialIdHash,
    m.userId,
    c?.id ?? null,
    c?.publicKey ?? null,
    c?.counter ?? 0,
    c?.transports ? JSON.stringify(c.transports) : null,
    p?.label ?? null,
    p?.deviceType ?? null,
    p?.backedUp === undefined ? null : p.backedUp ? 1 : 0,
    e.ts,
    e.bodyScope,
  );
}
