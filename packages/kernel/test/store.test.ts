import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { EventStore, EventValidationError, FakeClock, silentLogger, type Projector } from '../src';

const mk = (dataDir = ':memory:', key = randomBytes(32)) =>
  new EventStore({ dataDir, clock: new FakeClock(), log: silentLogger, masterKey: key });

const nudge = (sessionId: string, text: string) => ({
  type: 'session.nudged' as const,
  actor: { kind: 'human' as const, id: 'usr_1' },
  scope: { sessionId },
  meta: { sessionId },
  payload: { text },
  source: 'api' as const,
});

describe('EventStore', () => {
  it('appends a verifiable hash chain with encrypted, blinded bodies', () => {
    const s = mk();
    const a = s.append(nudge('ses_a', 'hello'));
    const b = s.append(nudge('ses_a', 'world'));
    expect(b.seq).toBe(2);
    expect(b.prevHash).toBe(a.hash);
    expect(s.readPayload(a)).toEqual({ text: 'hello' });
    expect(s.verifyBody(a)).toBe(true);
    expect(JSON.stringify(a.meta)).not.toContain('hello');
    const v = s.verifyChain({ atSeqs: [1] });
    expect(v.ok).toBe(true);
    expect(v.hashesAt[1]).toBe(a.hash);
    const raw = s.bodies.db.prepare('SELECT ct FROM bodies').all() as { ct: Uint8Array }[];
    expect(Buffer.concat(raw.map((r) => Buffer.from(r.ct))).toString('utf8')).not.toContain('hello');
  });

  it('rejects invalid events and free text in meta', () => {
    const s = mk();
    expect(() => s.append({ ...nudge('ses_a', 'x'), meta: { sessionId: 'ses_a', text: 'leak' } as never })).toThrow(EventValidationError);
    expect(s.head().seq).toBe(0);
  });

  it('is append-only (triggers) and detects tampering when triggers are bypassed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-store-'));
    const key = randomBytes(32);
    const s = mk(dir, key);
    s.append(nudge('ses_a', 'one'));
    s.append(nudge('ses_a', 'two'));
    expect(() => s.db.exec("UPDATE events SET type = 'x' WHERE seq = 1")).toThrow(/append-only/);
    expect(() => s.db.exec('DELETE FROM events WHERE seq = 1')).toThrow(/append-only/);
    s.close();
    const raw = new DatabaseSync(join(dir, 'aoc.db'));
    raw.exec('DROP TRIGGER events_append_only_u');
    raw.exec(`UPDATE events SET meta = '{"sessionId":"ses_b"}' WHERE seq = 1`);
    raw.close();
    const s2 = mk(dir, key);
    const v = s2.verifyChain();
    expect(v.ok).toBe(false);
    expect(v.firstBadSeq).toBe(1);
  });

  it('is idempotent per idempotencyKey', () => {
    const s = mk();
    const a = s.append({ ...nudge('ses_a', 'x'), idempotencyKey: 'k1' });
    const b = s.append({ ...nudge('ses_a', 'x'), idempotencyKey: 'k1' });
    expect(b.id).toBe(a.id);
    expect(s.head().seq).toBe(1);
  });

  it('crypto-shreds a scope: bodies gone, chain still valid, projections scrubbed', () => {
    const s = mk();
    const p: Projector = {
      name: 'nudges',
      tables: ['t_nudges'],
      ddl: ['CREATE TABLE IF NOT EXISTS t_nudges (id TEXT PRIMARY KEY, session_id TEXT, text TEXT)'],
      handles: ['session.nudged'],
      apply({ db }, e, payload) {
        db.prepare('INSERT INTO t_nudges VALUES (?,?,?)').run(e.id, e.scope.sessionId ?? null, (payload as { text: string } | null)?.text ?? '[erased]');
      },
      onErase(db, scope) {
        db.prepare("UPDATE t_nudges SET text = '[erased]' WHERE session_id = ?").run(scope);
      },
    };
    s.registerProjector(p);
    const a = s.append(nudge('ses_a', 'secret phone 0123'));
    s.append(nudge('ses_b', 'keep'));
    const erased = s.eraseScope('ses_a', { actor: { kind: 'human', id: 'usr_1' }, reason: 'pdpa_request' });
    expect(erased.type).toBe('body.erased');
    expect(erased.meta).toMatchObject({ scopeId: 'ses_a', bodyCount: 1 });
    expect(s.readPayload(a)).toBeNull();
    expect(s.verifyChain().ok).toBe(true);
    expect(s.db.prepare("SELECT text FROM t_nudges WHERE session_id='ses_a'").get()).toEqual({ text: '[erased]' });
    s.rebuildProjections();
    expect((s.db.prepare('SELECT text FROM t_nudges ORDER BY text').all() as { text: string }[]).map((r) => r.text)).toEqual(['[erased]', 'keep']);
    // writes to the scope after erasure use a fresh key generation
    const c = s.append(nudge('ses_a', 'after'));
    expect(s.readPayload(c)).toEqual({ text: 'after' });
  });

  it('isolates a failing projector (degraded) without blocking ingestion', () => {
    const s = mk();
    s.registerProjector({ name: 'boom', tables: [], ddl: [], apply() { throw new Error('bug'); } });
    const e = s.append(nudge('ses_a', 'x'));
    expect(e.seq).toBe(1);
    expect(s.projectionHealth()[0]).toMatchObject({ name: 'boom', status: 'degraded', failedSeq: 1 });
  });
});

describe('projection back-fill', () => {
  const counter = (version = 0, extraDdl: string[] = []): Projector => ({
    name: 'count',
    tables: ['t_count'],
    ddl: ['CREATE TABLE IF NOT EXISTS t_count (session_id TEXT PRIMARY KEY, n INTEGER NOT NULL)', ...extraDdl],
    handles: ['session.nudged'],
    version,
    apply({ db }, e) {
      db.prepare('INSERT INTO t_count VALUES (?, 1) ON CONFLICT(session_id) DO UPDATE SET n = n + 1').run(e.scope.sessionId ?? '');
    },
  });
  const rows = (s: EventStore) => s.db.prepare('SELECT session_id, n FROM t_count ORDER BY session_id').all();
  const reopen = (dir: string, key: Parameters<typeof mk>[1], p: Projector) => {
    const s = mk(dir, key);
    s.registerProjector(p);
    return { s, rebuilt: s.rebuildStaleProjections() };
  };

  it('back-fills a projector added to an existing log, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-proj-'));
    const key = randomBytes(32);
    const first = mk(dir, key);
    first.append(nudge('ses_a', 'one'));
    first.append(nudge('ses_a', 'two'));
    first.append(nudge('ses_b', 'three'));
    first.close();

    const a = reopen(dir, key, counter());
    expect(a.rebuilt).toEqual(['count']);
    expect(rows(a.s)).toEqual([{ session_id: 'ses_a', n: 2 }, { session_id: 'ses_b', n: 1 }]);
    a.s.append(nudge('ses_b', 'four'));
    a.s.close();

    // Unchanged on the next start: no rebuild, nothing double-counted.
    const b = reopen(dir, key, counter());
    expect(b.rebuilt).toEqual([]);
    expect(rows(b.s)).toEqual([{ session_id: 'ses_a', n: 2 }, { session_id: 'ses_b', n: 2 }]);
    b.s.close();

    // A schema or version change rebuilds it from the log (old tables dropped first, so new indexes apply).
    const c = reopen(dir, key, counter(1, ['CREATE INDEX IF NOT EXISTS t_count_n ON t_count(n)']));
    expect(c.rebuilt).toEqual(['count']);
    expect(rows(c.s)).toEqual([{ session_id: 'ses_a', n: 2 }, { session_id: 'ses_b', n: 2 }]);
    c.s.close();
  });

  it('needs no rebuild on a fresh log, and heals degraded projectors at startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-proj-'));
    const key = randomBytes(32);
    let broken = true;
    const flaky: Projector = { ...counter(), apply(ctx, e, p) { if (broken) throw new Error('bug'); counter().apply(ctx, e, p); } };
    const s = mk(dir, key);
    s.registerProjector(flaky);
    expect(s.rebuildStaleProjections()).toEqual([]);
    s.append(nudge('ses_a', 'x'));
    expect(s.projectionHealth()[0]).toMatchObject({ name: 'count', status: 'degraded' });
    s.close();

    broken = false;
    const again = reopen(dir, key, flaky);
    expect(again.rebuilt).toEqual(['count']);
    expect(rows(again.s)).toEqual([{ session_id: 'ses_a', n: 1 }]);
    expect(again.s.projectionHealth()).toEqual([]);
    again.s.close();
  });
});

describe('BodyStore blobs', () => {
  it('stores encrypted blobs and shreds them with the scope', () => {
    const s = mk();
    const data = Buffer.from('fake video bytes '.repeat(100));
    s.bodies.putBlob('att_1', 'tkt_1', data, '2026-10-09T00:00:00Z');
    expect(s.bodies.getBlob('att_1')?.equals(data)).toBe(true);
    s.eraseScope('tkt_1', { actor: { kind: 'human', id: 'usr_1' }, reason: 'pdpa_request' });
    expect(s.bodies.getBlob('att_1')).toBeNull();
  });
});
