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
  private readonly listeners = new Set<CommitListener>();
  private headSeq = 0;
  private headHash: string;
  private readonly genesis: string;

  constructor(private readonly opts: EventStoreOptions) {
    const mem = opts.dataDir === ':memory:';
    if (!mem) mkdirSync(opts.dataDir, { recursive: true });
    this.db = new DatabaseSync(mem ? ':memory:' : join(opts.dataDir, 'aoc.db'));
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;');
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
    for (const ddl of p.ddl) this.db.exec(ddl);
    this.projectors.push(p);
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
        const problems = validateEvent(input.type, input.meta, input.payload ?? null);
        if (problems.length) throw new EventValidationError(input.type, problems);
        const e = this.write(input as NewEventInput, writtenBodies);
        out.push(e);
        committed.push({ e, payload: (input.payload ?? null) as JsonValue | null });
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

  private write(input: NewEventInput, writtenBodies: string[]): StoredEvent {
    const seq = this.headSeq + 1;
    const id = newId('event', this.opts.clock.now());
    const ts = this.opts.clock.iso();
    const scope = cleanScope(input.scope ?? {});
    const meta = (input.meta ?? {}) as JsonObject;
    const hasBody = input.payload !== undefined && input.payload !== null;
    let payloadHash: string | null = null;
    let bodyScope: string | null = null;
    if (hasBody) {
      bodyScope = input.bodyScope ?? scope.sessionId ?? scope.ticketId ?? scope.projectId ?? 'global';
      // Blinded hash: the blind lives only inside the encrypted body, so after crypto-shred the
      // chained hash cannot be brute-forced back to low-entropy personal data.
      const blind = randomBytes(16).toString('hex');
      const canon = canonicalJson(input.payload);
      payloadHash = sha256hex(`${blind}:${canon}`);
      this.bodies.put(id, bodyScope, canonicalJson({ b: blind, p: input.payload }), ts);
      writtenBodies.push(id);
    }
    const header = {
      v: 1,
      chainId: this.chainId,
      seq,
      id,
      ts,
      type: input.type,
      actor: input.actor,
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
        input.actor.kind,
        input.actor.id,
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
      actor: input.actor,
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
    this.project(e, (input.payload ?? null) as JsonValue | null, false);
    return e;
  }

  /** Each projector runs in its own savepoint: a failing projector is marked degraded (rebuildable) without blocking ingestion. */
  private project(e: StoredEvent, payload: JsonValue | null, replaying: boolean): void {
    for (const p of this.projectors) {
      if (p.handles && !p.handles.includes(e.type)) continue;
      const sp = `p_${p.name.replace(/[^a-z0-9_]/gi, '_')}`;
      this.db.exec(`SAVEPOINT ${sp}`);
      try {
        p.apply({ db: this.db, replaying }, e, payload);
        this.db.exec(`RELEASE ${sp}`);
      } catch (err) {
        this.db.exec(`ROLLBACK TO ${sp}`);
        this.db.exec(`RELEASE ${sp}`);
        this.opts.log.error('projector failed', { projector: p.name, type: e.type, seq: e.seq, err: String(err) });
        this.db
          .prepare(
            `INSERT INTO projection_health (name, status, last_error, failed_seq, updated_at) VALUES (?, 'degraded', ?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET status='degraded', last_error=excluded.last_error, failed_seq=excluded.failed_seq, updated_at=excluded.updated_at`,
          )
          .run(p.name, String(err).slice(0, 500), e.seq, this.opts.clock.iso());
      }
    }
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

  /** Check a body against its chained blinded hash (false if tampered; null if erased/absent). */
  verifyBody(e: Pick<StoredEvent, 'id' | 'payloadHash'>): boolean | null {
    if (!e.payloadHash) return null;
    const text = this.bodies.get(e.id);
    if (text === null) return null;
    const { b, p } = JSON.parse(text) as { b: string; p: JsonValue };
    return sha256hex(`${b}:${canonicalJson(p)}`) === e.payloadHash;
  }

  static headerOf(e: StoredEvent): EventHeader {
    return { seq: e.seq, id: e.id, ts: e.ts, type: e.type, actor: e.actor, scope: e.scope, meta: e.meta };
  }

  // ── verification ──────────────────────────────────────────────────────────
  /**
   * Recompute every hash and link. NOTE: an in-file chain alone is defeatable (drop trigger + recompute);
   * mod-audit compares `hashesAt` with off-host anchors — that is the real verification (§13, R2).
   */
  verifyChain(opts: { atSeqs?: number[]; batch?: number } = {}): ChainVerifyResult {
    const want = new Set(opts.atSeqs ?? []);
    const hashesAt: Record<number, string> = {};
    const problems: string[] = [];
    let prev = this.genesis;
    let expectSeq = 1;
    let checked = 0;
    let firstBad: number | null = null;
    const batch = opts.batch ?? 5000;
    let from = 1;
    for (;;) {
      const rows = this.db.prepare('SELECT * FROM events WHERE seq >= ? ORDER BY seq LIMIT ?').all(from, batch) as unknown as EventRow[];
      if (!rows.length) break;
      for (const r of rows) {
        const e = rowToEvent(r);
        if (e.seq !== expectSeq) {
          problems.push(`gap: expected seq ${expectSeq}, found ${e.seq}`);
          firstBad ??= e.seq;
        }
        if (e.prevHash !== prev) {
          problems.push(`seq ${e.seq}: prevHash does not link`);
          firstBad ??= e.seq;
        }
        const recomputed = sha256hex(
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
        if (recomputed !== e.hash) {
          problems.push(`seq ${e.seq}: hash mismatch`);
          firstBad ??= e.seq;
        }
        if (want.has(e.seq)) hashesAt[e.seq] = recomputed;
        prev = e.hash;
        expectSeq = e.seq + 1;
        checked++;
      }
      from = rows[rows.length - 1]!.seq + 1;
    }
    return { ok: problems.length === 0, chainId: this.chainId, headSeq: expectSeq - 1, headHash: prev, checked, firstBadSeq: firstBad, problems: problems.slice(0, 50), hashesAt };
  }

  // ── erasure & rebuild ─────────────────────────────────────────────────────
  /** Crypto-shred a body scope and scrub projections; the chain remains valid. Appends body.erased. */
  eraseScope(scopeId: string, input: { actor: Actor; reason: 'pdpa_request' | 'secret_leak' | 'retention' | 'other'; decisionId?: string | null }): StoredEvent {
    const n = this.bodies.eraseScope(scopeId, this.opts.clock.iso());
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of this.projectors) p.onErase?.(this.db, scopeId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.append({
      type: 'body.erased',
      actor: input.actor,
      meta: { scopeId, reason: input.reason, erasedBy: input.actor.id, bodyCount: n, decisionId: input.decisionId ?? null },
      source: 'api',
    });
  }

  /** Drop and rebuild projections from the log (payloads decrypted; null where erased). */
  rebuildProjections(names?: string[]): void {
    const targets = this.projectors.filter((p) => !names || names.includes(p.name));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const p of targets) {
        for (const t of p.tables) this.db.exec(`DROP TABLE IF EXISTS ${t}`);
        for (const ddl of p.ddl) this.db.exec(ddl);
      }
      let from = 1;
      for (;;) {
        const rows = this.db.prepare('SELECT * FROM events WHERE seq >= ? ORDER BY seq LIMIT 2000').all(from) as unknown as EventRow[];
        if (!rows.length) break;
        for (const r of rows) {
          const e = rowToEvent(r);
          const payload = this.readPayload(e);
          for (const p of targets) {
            if (p.handles && !p.handles.includes(e.type)) continue;
            p.apply({ db: this.db, replaying: true }, e, payload);
          }
        }
        from = rows[rows.length - 1]!.seq + 1;
      }
      for (const p of targets) this.db.prepare('DELETE FROM projection_health WHERE name = ?').run(p.name);
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
