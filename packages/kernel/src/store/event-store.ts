import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  newId,
  validateEvent,
  type Actor,
  type EventHeader,
  type EventType,
  type JsonObject,
  type JsonValue,
  type MetaOf,
  type NewEventInput,
  type PayloadOf,
  type Scope,
  type StoredEvent,
} from '@aoc/contracts';
import { canonicalJson, sha256hex } from '../canonical';
import type { Clock } from '../clock';
import type { Logger } from '../logger';
import { BodyStore } from './body-store';

/** Typed input for a catalog event. */
export type NewEvent<T extends EventType = EventType> = NewEventInput<T, MetaOf<T>, PayloadOf<T>>;

export interface ProjectionContext {
  db: DatabaseSync;
  /** true while rebuilding from the log (projectors must not have side effects either way). */
  replaying: boolean;
}

export interface Projector {
  name: string;
  /** Tables owned (dropped and recreated on rebuild). */
  tables: string[];
  ddl: string[];
  /** Event types handled; omit for all. */
  handles?: readonly string[];
  /** Bump when apply() semantics change without a DDL change, to force a rebuild from the log on next start. */
  version?: number;
  apply(ctx: ProjectionContext, e: StoredEvent, payload: JsonValue | null): void;
  /** Scrub free text belonging to an erased body scope (crypto-shred, §13). */
  onErase?(db: DatabaseSync, scopeId: string): void;
}

export type CommitListener = (e: StoredEvent, payload: JsonValue | null) => void;

export class EventValidationError extends Error {
  constructor(
    readonly type: string,
    readonly problems: string[],
  ) {
    super(`invalid ${type}: ${problems.join('; ')}`);
  }
}

export interface ListQuery {
  fromSeq?: number;
  toSeq?: number;
  types?: string[];
  typePrefix?: string;
  sessionId?: string;
  projectId?: string;
  ticketId?: string;
  changeId?: string;
  decisionId?: string;
  actorId?: string;
  fromTs?: string;
  toTs?: string;
  limit?: number;
  order?: 'asc' | 'desc';
}

export interface ChainVerifyResult {
  ok: boolean;
  chainId: string;
  headSeq: number;
  headHash: string;
  checked: number;
  firstBadSeq: number | null;
  problems: string[];
  /** seq → recomputed hash (only for requested seqs, used by anchor verification). */
  hashesAt: Record<number, string>;
}

interface EventRow {
  seq: number;
  id: string;
  ts: string;
  type: string;
  actor_kind: string;
  actor_id: string;
  scope_json: string;
  project_id: string | null;
  thread_id: string | null;
  session_id: string | null;
  task_id: string | null;
  ticket_id: string | null;
  change_id: string | null;
  decision_id: string | null;
  user_id: string | null;
  meta: string;
  payload_hash: string | null;
  body_scope: string | null;
  source: string;
  source_ts: string | null;
  idempotency_key: string | null;
  causation_id: string | null;
  prev_hash: string;
  hash: string;
}

const SCOPE_COLUMNS = [
  ['projectId', 'project_id'],
  ['threadId', 'thread_id'],
  ['sessionId', 'session_id'],
  ['taskId', 'task_id'],
  ['ticketId', 'ticket_id'],
  ['changeId', 'change_id'],
  ['decisionId', 'decision_id'],
  ['userId', 'user_id'],
] as const satisfies readonly (readonly [keyof Scope, keyof EventRow])[];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chain_info (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  project_id TEXT, thread_id TEXT, session_id TEXT, task_id TEXT, ticket_id TEXT, change_id TEXT, decision_id TEXT, user_id TEXT,
  meta TEXT NOT NULL,
  payload_hash TEXT,
  body_scope TEXT,
  source TEXT NOT NULL,
  source_ts TEXT,
  idempotency_key TEXT UNIQUE,
  causation_id TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_type ON events(type, seq);
CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS events_project ON events(project_id, seq);
CREATE INDEX IF NOT EXISTS events_ticket ON events(ticket_id, seq);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_causation ON events(causation_id);
CREATE TRIGGER IF NOT EXISTS events_append_only_u BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS events_append_only_d BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TABLE IF NOT EXISTS projection_health (name TEXT PRIMARY KEY, status TEXT NOT NULL, last_error TEXT, failed_seq INTEGER, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projection_state (name TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, rebuilt_at TEXT NOT NULL);
`;

export interface EventStoreOptions {
  /** Directory for aoc.db + bodies.db, or ':memory:' (tests). */
  dataDir: string;
  clock: Clock;
  log: Logger;
  masterKey: Buffer;
}

/**
 * The append-only, hash-chained event log (§13). aocd's single process is the sole writer (§15.1):
 * appends are synchronous and serialised by the event loop, so the chain can never fork.
 */
export class EventStore {
  readonly db: DatabaseSync;
  readonly bodies: BodyStore;
  readonly chainId: string;
  private readonly projectors: Projector[] = [];
  private readonly stale = new Set<string>();
  private readonly listeners = new Set<CommitListener>();
  private headSeq = 0;
  private headHash: string;
  private readonly genesis: string;

  constructor(private readonly opts: EventStoreOptions) {
    const mem = opts.dataDir === ':memory:';
    // Owner-only: the chain, decrypted read models and (in development) the generated KEK live here.
    if (!mem) mkdirSync(opts.dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(mem ? ':memory:' : join(opts.dataDir, 'aoc.db'));
    // secure_delete: projection text scrubbed on erasure (§13) is zeroed on disk, not left in freed pages.
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
    this.db.exec(SCHEMA);
    const blobDir = mem ? mkdtempSync(join(tmpdir(), 'aoc-blobs-')) : join(opts.dataDir, 'blobs');
    this.bodies = new BodyStore(mem ? ':memory:' : join(opts.dataDir, 'bodies.db'), opts.masterKey, blobDir);
    let chainId = (this.db.prepare("SELECT v FROM chain_info WHERE k = 'chain_id'").get() as { v: string } | undefined)?.v;
    if (!chainId) {
      chainId = randomBytes(16).toString('hex');
      this.db.prepare("INSERT INTO chain_info (k, v) VALUES ('chain_id', ?)").run(chainId);
      this.db.prepare("INSERT INTO chain_info (k, v) VALUES ('created_at', ?)").run(opts.clock.iso());
    }
    this.chainId = chainId;
    this.genesis = sha256hex(`aoc-genesis:${chainId}`);
    const head = this.db.prepare('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined;
    this.headSeq = head?.seq ?? 0;
    this.headHash = head?.hash ?? this.genesis;
  }

  // ── projectors & listeners ────────────────────────────────────────────────
  registerProjector(p: Projector): void {
    if (this.projectors.some((x) => x.name === p.name)) throw new Error(`duplicate projector ${p.name}`);
    const fingerprint = projectorFingerprint(p);
    const known = this.db.prepare('SELECT fingerprint FROM projection_state WHERE name = ?').get(p.name) as
      | { fingerprint: string }
      | undefined;
    if (known?.fingerprint === fingerprint) {
      for (const ddl of p.ddl) this.db.exec(ddl);
    } else if (!known && this.headSeq === 0) {
      // Fresh log: nothing to replay.
      for (const ddl of p.ddl) this.db.exec(ddl);
      this.markProjectionCurrent(p.name, fingerprint);
    } else {
      // New module on an existing log, or its schema/semantics changed: its tables are rebuilt from the log
      // (rebuildStaleProjections) before anything reads or appends. Old tables may lack new columns, so drop first.
      for (const t of p.tables) this.db.exec(`DROP TABLE IF EXISTS ${t}`);
      for (const ddl of p.ddl) this.db.exec(ddl);
      this.stale.add(p.name);
    }
    this.projectors.push(p);
  }

  /**
   * Rebuild every projector registered as stale (new on an existing log, or changed) plus any marked degraded by
   * a failed apply. Called once at startup after all projectors are registered. Returns the rebuilt names.
   */
  rebuildStaleProjections(): string[] {
    const degraded = this.projectionHealth()
      .filter((h) => h.status === 'degraded')
      .map((h) => h.name);
    const names = [...new Set([...this.stale, ...degraded])].filter((n) => this.projectors.some((p) => p.name === n));
    if (!names.length) return [];
    this.rebuildProjections(names);
    for (const n of names) this.markProjectionCurrent(n, projectorFingerprint(this.projectors.find((p) => p.name === n)!));
    this.stale.clear();
    return names;
  }

  private markProjectionCurrent(name: string, fingerprint: string): void {
    this.db
      .prepare(
        `INSERT INTO projection_state (name, fingerprint, rebuilt_at) VALUES (?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET fingerprint = excluded.fingerprint, rebuilt_at = excluded.rebuilt_at`,
      )
      .run(name, fingerprint, this.opts.clock.iso());
  }

  /** Post-commit listener (SSE, reactors). Called synchronously after COMMIT, in seq order. */
  subscribe(listener: CommitListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── append ────────────────────────────────────────────────────────────────
  append<T extends EventType>(input: NewEvent<T>): StoredEvent<T, MetaOf<T>> {
    return this.appendMany([input])[0] as StoredEvent<T, MetaOf<T>>;
  }

  /** Atomic multi-append (one transaction). Idempotent per idempotencyKey. */
  appendMany(inputs: NewEvent[]): StoredEvent[] {
    const out: StoredEvent[] = [];
    const committed: { e: StoredEvent; payload: JsonValue | null }[] = [];
    const writtenBodies: string[] = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const input of inputs) {
        if (input.idempotencyKey) {
          const existing = this.findByIdempotencyKey(input.idempotencyKey);
          if (existing) {
            out.push(existing);
            continue;
          }
        }
        const problems = [...validateEvent(input.type, input.meta, input.payload ?? null), ...headerProblems(input as NewEventInput)];
        if (problems.length) throw new EventValidationError(input.type, problems);
        const { e, payload } = this.write(input as NewEventInput, writtenBodies);
        out.push(e);
        committed.push({ e, payload });
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      for (const id of writtenBodies) this.bodies.delete(id);
      const head = this.db.prepare('SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1').get() as { seq: number; hash: string } | undefined;
      this.headSeq = head?.seq ?? 0;
      this.headHash = head?.hash ?? this.genesis;
      throw err;
    }
    for (const c of committed) {
      for (const l of this.listeners) {
        try {
          l(c.e, c.payload);
        } catch (err) {
          this.opts.log.error('commit listener failed', { type: c.e.type, seq: c.e.seq, err: String(err) });
        }
      }
    }
    return out;
  }

  /**
   * Writes one event. Actor, scope, meta and body are brought to their canonical JSON form first, because that is what
   * is chained, stored and read back: the event returned to the caller, handed to the projectors and to the commit
   * listeners is then exactly what a rebuild or a later read produces, not the caller's own objects (key order,
   * `undefined` members, fields that are not part of the record). A projector therefore cannot write one thing live
   * and another after a rebuild, whatever the writer passed.
   */
  private write(input: NewEventInput, writtenBodies: string[]): { e: StoredEvent; payload: JsonValue | null } {
    const seq = this.headSeq + 1;
    const id = newId('event', this.opts.clock.now());
    const ts = this.opts.clock.iso();
    const actor: Actor = { kind: input.actor.kind, id: input.actor.id };
    const scope = normalized(cleanScope(input.scope ?? {}));
    const meta = normalized((input.meta ?? {}) as JsonObject);
    const hasBody = input.payload !== undefined && input.payload !== null;
    let payload: JsonValue | null = null;
    let payloadHash: string | null = null;
    let bodyScope: string | null = null;
    if (hasBody) {
      bodyScope = input.bodyScope ?? scope.sessionId ?? scope.ticketId ?? scope.projectId ?? 'global';
      // Blinded hash: the blind lives only inside the encrypted body, so after crypto-shred the
      // chained hash cannot be brute-forced back to low-entropy personal data.
      const blind = randomBytes(16).toString('hex');
      const canon = canonicalJson(input.payload);
      payload = JSON.parse(canon) as JsonValue;
      payloadHash = sha256hex(`${blind}:${canon}`);
      this.bodies.put(id, bodyScope, canonicalJson({ b: blind, p: payload }), ts);
      writtenBodies.push(id);
    }
    const header = {
      v: 1,
      chainId: this.chainId,
      seq,
      id,
      ts,
      type: input.type,
      actor,
      scope,
      meta,
      payloadHash,
      bodyScope,
      source: input.source,
      sourceTs: input.sourceTs ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      causationId: input.causationId ?? null,
      prevHash: this.headHash,
    };
    const hash = sha256hex(canonicalJson(header));
    this.db
      .prepare(
        `INSERT INTO events (seq, id, ts, type, actor_kind, actor_id, scope_json, project_id, thread_id, session_id, task_id, ticket_id, change_id, decision_id, user_id,
          meta, payload_hash, body_scope, source, source_ts, idempotency_key, causation_id, prev_hash, hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        seq,
        id,
        ts,
        input.type,
        actor.kind,
        actor.id,
        canonicalJson(scope),
        scope.projectId ?? null,
        scope.threadId ?? null,
        scope.sessionId ?? null,
        scope.taskId ?? null,
        scope.ticketId ?? null,
        scope.changeId ?? null,
        scope.decisionId ?? null,
        scope.userId ?? null,
        canonicalJson(meta),
        payloadHash,
        bodyScope,
        input.source,
        header.sourceTs,
        header.idempotencyKey,
        header.causationId,
        header.prevHash,
        hash,
      );
    this.headSeq = seq;
    this.headHash = hash;
    const e: StoredEvent = {
      seq,
      id,
      ts,
      type: input.type,
      actor,
      scope,
      meta,
      payloadHash,
      bodyScope,
      source: input.source,
      sourceTs: header.sourceTs,
      idempotencyKey: header.idempotencyKey,
      causationId: header.causationId,
      prevHash: header.prevHash,
      hash,
    };
    this.project(e, payload, false);
    return { e, payload };
  }

  /** Each projector runs in its own savepoint: a failing projector is marked degraded (rebuildable) without blocking ingestion. */
  private project(e: StoredEvent, payload: JsonValue | null, replaying: boolean): void {
    for (const p of this.projectors) {
      if (p.handles && !p.handles.includes(e.type)) continue;
      const err = this.applyIsolated(p, e, payload, replaying);
      if (err !== null) this.markDegraded(p.name, e.seq, err);
    }
  }

  /** Apply one event to one projector inside a savepoint; the error it threw (its half-done writes undone), or null. */
  private applyIsolated(p: Projector, e: StoredEvent, payload: JsonValue | null, replaying: boolean): string | null {
    const sp = `p_${p.name.replace(/[^a-z0-9_]/gi, '_')}`;
    this.db.exec(`SAVEPOINT ${sp}`);
    try {
      p.apply({ db: this.db, replaying }, e, payload);
      this.db.exec(`RELEASE ${sp}`);
      return null;
    } catch (err) {
      this.db.exec(`ROLLBACK TO ${sp}`);
      this.db.exec(`RELEASE ${sp}`);
      this.opts.log.error('projector failed', { projector: p.name, type: e.type, seq: e.seq, replaying, err: String(err) });
      return String(err);
    }
  }

  private markDegraded(name: string, seq: number, error: string): void {
    this.db
      .prepare(
        `INSERT INTO projection_health (name, status, last_error, failed_seq, updated_at) VALUES (?, 'degraded', ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET status='degraded', last_error=excluded.last_error, failed_seq=excluded.failed_seq, updated_at=excluded.updated_at`,
      )
      .run(name, error.slice(0, 500), seq, this.opts.clock.iso());
  }

  // ── reads ─────────────────────────────────────────────────────────────────
  head(): { seq: number; hash: string; chainId: string } {
    return { seq: this.headSeq, hash: this.headHash, chainId: this.chainId };
  }

  get(seqOrId: number | string): StoredEvent | null {
    const row = (
      typeof seqOrId === 'number'
        ? this.db.prepare('SELECT * FROM events WHERE seq = ?').get(seqOrId)
        : this.db.prepare('SELECT * FROM events WHERE id = ?').get(seqOrId)
    ) as EventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  findByIdempotencyKey(key: string): StoredEvent | null {
    const row = this.db.prepare('SELECT * FROM events WHERE idempotency_key = ?').get(key) as EventRow | undefined;
    return row ? rowToEvent(row) : null;
  }

  findByCausation(causationId: string, type?: string): StoredEvent[] {
    const rows = (
      type
        ? this.db.prepare('SELECT * FROM events WHERE causation_id = ? AND type = ? ORDER BY seq').all(causationId, type)
        : this.db.prepare('SELECT * FROM events WHERE causation_id = ? ORDER BY seq').all(causationId)
    ) as unknown as EventRow[];
    return rows.map(rowToEvent);
  }

  list(q: ListQuery = {}): StoredEvent[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.fromSeq !== undefined) (where.push('seq >= ?'), args.push(q.fromSeq));
    if (q.toSeq !== undefined) (where.push('seq <= ?'), args.push(q.toSeq));
    if (q.types?.length) (where.push(`type IN (${q.types.map(() => '?').join(',')})`), args.push(...q.types));
    if (q.typePrefix) (where.push('type LIKE ?'), args.push(`${q.typePrefix}%`));
    if (q.sessionId) (where.push('session_id = ?'), args.push(q.sessionId));
    if (q.projectId) (where.push('project_id = ?'), args.push(q.projectId));
    if (q.ticketId) (where.push('ticket_id = ?'), args.push(q.ticketId));
    if (q.changeId) (where.push('change_id = ?'), args.push(q.changeId));
    if (q.decisionId) (where.push('decision_id = ?'), args.push(q.decisionId));
    if (q.actorId) (where.push('actor_id = ?'), args.push(q.actorId));
    if (q.fromTs) (where.push('ts >= ?'), args.push(q.fromTs));
    if (q.toTs) (where.push('ts <= ?'), args.push(q.toTs));
    const sql = `SELECT * FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq ${q.order === 'desc' ? 'DESC' : 'ASC'} LIMIT ?`;
    args.push(Math.min(q.limit ?? 1000, 100_000));
    return (this.db.prepare(sql).all(...args) as unknown as EventRow[]).map(rowToEvent);
  }

  /** Decrypt an event body; null when header-only or crypto-shredded. */
  readPayload(e: Pick<StoredEvent, 'id' | 'payloadHash'>): JsonValue | null {
    if (!e.payloadHash) return null;
    const text = this.bodies.get(e.id);
    if (text === null) return null;
    return (JSON.parse(text) as { b: string; p: JsonValue }).p;
  }

  /** Check a body against its chained blinded hash (false if tampered or unreadable; null if erased/absent). */
  verifyBody(e: Pick<StoredEvent, 'id' | 'payloadHash'>): boolean | null {
    if (!e.payloadHash) return null;
    try {
      const text = this.bodies.get(e.id);
      if (text === null) return null;
      const { b, p } = JSON.parse(text) as { b: string; p: JsonValue };
      return sha256hex(`${b}:${canonicalJson(p)}`) === e.payloadHash;
    } catch {
      // AES-GCM refuses a ciphertext that was edited or moved to another event: that is the finding, not a crash.
      return false;
    }
  }

  static headerOf(e: StoredEvent): EventHeader {
    return { seq: e.seq, id: e.id, ts: e.ts, type: e.type, actor: e.actor, scope: e.scope, meta: e.meta };
  }

  // ── verification ──────────────────────────────────────────────────────────
  /**
   * Recompute every hash and link in one synchronous pass (tests, offline tools). NOTE: an in-file chain alone is
   * defeatable (drop trigger + recompute); mod-audit compares `hashesAt` with off-host anchors — that is the real
   * verification (§13, R2). Inside aocd use verifyChainAsync, which never stalls the sole writer.
   */
  verifyChain(opts: { atSeqs?: number[]; batch?: number } = {}): ChainVerifyResult {
    const v = new ChainVerifier(this.chainId, this.genesis, opts.atSeqs);
    const stmt = this.db.prepare('SELECT * FROM events WHERE seq >= ? ORDER BY seq LIMIT ?');
    const batch = opts.batch ?? 5000;
    let from = 1;
    for (;;) {
      const rows = stmt.all(from, batch) as unknown as EventRow[];
      if (!rows.length) break;
      for (const r of rows) v.add(r);
      from = rows[rows.length - 1]!.seq + 1;
    }
    return v.result();
  }

  /**
   * verifyChain in chunks of `batch` rows, yielding to the event loop between chunks, so ingest, the API and SSE
   * keep being served while a large chain is recomputed. Verifies the events present when called (up to `toSeq`,
   * default the stored head at that moment); events appended meanwhile are left for the next run. Rows are
   * immutable, so the result equals a synchronous pass over the same range.
   */
  async verifyChainAsync(
    opts: { atSeqs?: number[]; batch?: number; toSeq?: number; signal?: AbortSignal } = {},
  ): Promise<ChainVerifyResult> {
    const toSeq =
      opts.toSeq ?? (this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM events').get() as { s: number }).s;
    const v = new ChainVerifier(this.chainId, this.genesis, opts.atSeqs);
    const stmt = this.db.prepare('SELECT * FROM events WHERE seq >= ? AND seq <= ? ORDER BY seq LIMIT ?');
    const batch = opts.batch ?? 500;
    let from = 1;
    while (from <= toSeq) {
      opts.signal?.throwIfAborted();
      const rows = stmt.all(from, toSeq, batch) as unknown as EventRow[];
      if (!rows.length) break;
      for (const r of rows) v.add(r);
      from = rows[rows.length - 1]!.seq + 1;
      if (from <= toSeq) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return v.result();
  }

  // ── erasure & rebuild ─────────────────────────────────────────────────────
  /**
   * Crypto-shred a body scope and scrub projections; the chain remains valid. Appends body.erased.
   * Write-ahead: everything that can refuse (the record's validity, a projector that cannot scrub) and the record
   * itself come before the irreversible shred, so a body is never destroyed without its body.erased event.
   */
  eraseScope(scopeId: string, input: { actor: Actor; reason: 'pdpa_request' | 'secret_leak' | 'retention' | 'other'; decisionId?: string | null }): StoredEvent {
    const meta = {
      scopeId,
      reason: input.reason,
      erasedBy: input.actor.id,
      bodyCount: this.bodies.countScope(scopeId),
      decisionId: input.decisionId ?? null,
    };
    const problems = validateEvent('body.erased', meta, null);
    if (problems.length) throw new EventValidationError('body.erased', problems);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of this.projectors) p.onErase?.(this.db, scopeId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    const erased = this.append({ type: 'body.erased', actor: input.actor, meta, source: 'api' });
    this.bodies.eraseScope(scopeId, this.opts.clock.iso());
    this.purgeResidue();
    return erased;
  }

  /**
   * secure_delete zeroes the cells a DELETE removes, but when SQLite rebalances sibling pages it rebuilds one in
   * place and leaves the cells it moved in the page's unallocated gap, outside every table, so erased rows can
   * outlive their own deletion. VACUUM writes every page afresh. The scrub and the shred are done by now: a VACUUM
   * that cannot run is logged, not thrown, so the erasure is still reported as done.
   */
  private purgeResidue(): void {
    try {
      this.db.exec('VACUUM');
    } catch (err) {
      this.opts.log.error('VACUUM after an erasure failed: erased text may remain in aoc.db until the next one', { err: String(err) });
    }
    // The WAL still holds page images from before the scrub: fold it into the main file and truncate it. A reader
    // holding an older snapshot (a backup copying the database) stops that: the pages stay until the next checkpoint.
    const checkpoint = this.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number } | undefined;
    if (checkpoint?.busy)
      this.opts.log.warn('the WAL could not be truncated after an erasure: a reader holds an older snapshot, so pre-erasure pages stay in aoc.db and its WAL until the next checkpoint');
  }

  projectorNames(): string[] {
    return this.projectors.map((p) => p.name);
  }

  /**
   * Drop and rebuild projections from the log (payloads decrypted; null where erased). An event a projector cannot
   * handle is isolated exactly as it is live: skipped for that projector, which is marked degraded again. Aborting
   * instead would make one poison event unrebuildable, and aocd rebuilds degraded projections before it starts.
   */
  rebuildProjections(names?: string[]): void {
    const targets = this.projectors.filter((p) => !names || names.includes(p.name));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of targets) {
        for (const t of p.tables) this.db.exec(`DROP TABLE IF EXISTS ${t}`);
        for (const ddl of p.ddl) this.db.exec(ddl);
      }
      const failed = new Map<string, { seq: number; error: string }>();
      let from = 1;
      for (;;) {
        const rows = this.db.prepare('SELECT * FROM events WHERE seq >= ? ORDER BY seq LIMIT 2000').all(from) as unknown as EventRow[];
        if (!rows.length) break;
        for (const r of rows) {
          const e = rowToEvent(r);
          const payload = this.readPayload(e);
          for (const p of targets) {
            if (p.handles && !p.handles.includes(e.type)) continue;
            const err = this.applyIsolated(p, e, payload, true);
            if (err !== null) failed.set(p.name, { seq: e.seq, error: err });
          }
        }
        from = rows[rows.length - 1]!.seq + 1;
      }
      for (const p of targets) {
        this.db.prepare('DELETE FROM projection_health WHERE name = ?').run(p.name);
        const f = failed.get(p.name);
        if (f) this.markDegraded(p.name, f.seq, f.error);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  projectionHealth(): { name: string; status: string; lastError: string | null; failedSeq: number | null }[] {
    return (this.db.prepare('SELECT name, status, last_error, failed_seq FROM projection_health').all() as unknown as {
      name: string;
      status: string;
      last_error: string | null;
      failed_seq: number | null;
    }[]).map((r) => ({ name: r.name, status: r.status, lastError: r.last_error, failedSeq: r.failed_seq }));
  }

  close(): void {
    this.db.close();
    this.bodies.close();
  }
}

/** Recomputes the chain row by row (rows must arrive in seq order); shared by the sync and chunked verifiers. */
class ChainVerifier {
  private readonly want: Set<number>;
  private readonly hashesAt: Record<number, string> = {};
  private readonly problems: string[] = [];
  private prev: string;
  private expectSeq = 1;
  private checked = 0;
  private firstBad: number | null = null;

  constructor(
    private readonly chainId: string,
    genesis: string,
    atSeqs: number[] = [],
  ) {
    this.prev = genesis;
    this.want = new Set(atSeqs);
  }

  add(r: EventRow): void {
    let e: StoredEvent;
    let recomputed: string;
    try {
      e = rowToEvent(r);
      recomputed = this.hashOf(e);
    } catch {
      // A column the chain hashes is not JSON (or holds a number JSON cannot carry): the row cannot be recomputed.
      // That is itself the finding. Report it at its seq instead of letting the verifier die, and keep linking on
      // the stored hashes so rows after it are still checked.
      if (r.seq !== this.expectSeq) this.problem(r.seq, `gap: expected seq ${this.expectSeq}, found ${r.seq}`);
      if (r.prev_hash !== this.prev) this.problem(r.seq, `seq ${r.seq}: prevHash does not link`);
      this.problem(r.seq, `seq ${r.seq}: row cannot be read (scope or meta is not valid JSON)`);
      this.prev = r.hash;
      this.expectSeq = r.seq + 1;
      this.checked++;
      return;
    }
    if (e.seq !== this.expectSeq) this.problem(e.seq, `gap: expected seq ${this.expectSeq}, found ${e.seq}`);
    if (e.prevHash !== this.prev) this.problem(e.seq, `seq ${e.seq}: prevHash does not link`);
    if (recomputed !== e.hash) this.problem(e.seq, `seq ${e.seq}: hash mismatch`);
    // Queries filter on the indexed copies of the scope, which the hash does not cover: they must agree with it.
    if (SCOPE_COLUMNS.some(([k, col]) => ((e.scope as Record<string, string | undefined>)[k] ?? null) !== (r[col] ?? null))) {
      this.problem(e.seq, `seq ${e.seq}: indexed scope columns disagree with the chained scope`);
    }
    if (this.want.has(e.seq)) this.hashesAt[e.seq] = recomputed;
    this.prev = e.hash;
    this.expectSeq = e.seq + 1;
    this.checked++;
  }

  private hashOf(e: StoredEvent): string {
    return sha256hex(
      canonicalJson({
        v: 1,
        chainId: this.chainId,
        seq: e.seq,
        id: e.id,
        ts: e.ts,
        type: e.type,
        actor: e.actor,
        scope: e.scope,
        meta: e.meta,
        payloadHash: e.payloadHash,
        bodyScope: e.bodyScope,
        source: e.source,
        sourceTs: e.sourceTs,
        idempotencyKey: e.idempotencyKey,
        causationId: e.causationId,
        prevHash: e.prevHash,
      }),
    );
  }

  private problem(seq: number, text: string): void {
    if (this.problems.length < 50) this.problems.push(text);
    this.firstBad ??= seq;
  }

  result(): ChainVerifyResult {
    return {
      ok: this.firstBad === null,
      chainId: this.chainId,
      headSeq: this.expectSeq - 1,
      headHash: this.prev,
      checked: this.checked,
      firstBadSeq: this.firstBad,
      problems: [...this.problems],
      hashesAt: this.hashesAt,
    };
  }
}

function projectorFingerprint(p: Projector): string {
  return sha256hex(canonicalJson({ tables: p.tables, ddl: p.ddl, handles: p.handles ?? null, version: p.version ?? 0 }));
}

const MAX_IDEMPOTENCY_KEY = 512;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * sourceTs and idempotencyKey are chained in clear (and exported in evidence packs) like meta, but the catalog
 * does not cover them: bound them here so no writer can chain free text or bulk data that can never be erased.
 */
function headerProblems(input: NewEventInput): string[] {
  const problems: string[] = [];
  const ts = input.sourceTs;
  if (ts !== undefined && ts !== null && !(typeof ts === 'string' && ts.length >= 10 && ts.length <= 40 && !Number.isNaN(Date.parse(ts)))) {
    problems.push('sourceTs: must be an ISO-8601 timestamp');
  }
  const key = input.idempotencyKey;
  if (key !== undefined && key !== null && !(typeof key === 'string' && key.length >= 1 && key.length <= MAX_IDEMPOTENCY_KEY && !CONTROL_CHARS.test(key))) {
    problems.push(`idempotencyKey: must be 1–${MAX_IDEMPOTENCY_KEY} characters without control characters`);
  }
  return problems;
}

/** A value as the log will hold it: canonical JSON read back (sorted keys, no `undefined`). */
function normalized<T>(v: T): T {
  return JSON.parse(canonicalJson(v)) as T;
}

function cleanScope(s: Scope): Scope {
  const out: Scope = {};
  for (const [k, v] of Object.entries(s)) if (v !== undefined && v !== null && v !== '') (out as Record<string, string>)[k] = v;
  return out;
}

function rowToEvent(r: EventRow): StoredEvent {
  return {
    seq: r.seq,
    id: r.id,
    ts: r.ts,
    type: r.type,
    actor: { kind: r.actor_kind as Actor['kind'], id: r.actor_id },
    scope: JSON.parse(r.scope_json) as Scope,
    meta: JSON.parse(r.meta) as JsonObject,
    payloadHash: r.payload_hash,
    bodyScope: r.body_scope,
    source: r.source as StoredEvent['source'],
    sourceTs: r.source_ts,
    idempotencyKey: r.idempotency_key,
    causationId: r.causation_id,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}
