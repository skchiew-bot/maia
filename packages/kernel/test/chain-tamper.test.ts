/**
 * Tamper detection (§13, R2): whatever a hostile editor of aoc.db changes with the append-only triggers dropped,
 * verifyChain and verifyChainAsync must both say so, with the same result and the first bad row named correctly.
 * An in-file chain cannot show that its tail was cut off: that is what the off-host anchors are for.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EventStore, FakeClock, forSeeds, Rng, silentLogger, type ChainVerifyResult, type NewEvent } from '../src';

const CHAIN_LENGTH = 24;

/** Every third event (seq 1, 4, 7, …) carries an encrypted body; the rest are header-only. */
function build(): EventStore {
  const store = new EventStore({ dataDir: ':memory:', clock: new FakeClock(), log: silentLogger, masterKey: randomBytes(32) });
  for (let i = 0; i < CHAIN_LENGTH; i++) {
    const sessionId = `ses_${(i % 4) + 1}`;
    const e: NewEvent =
      i % 3 === 0
        ? { type: 'session.nudged', actor: { kind: 'human', id: 'usr_1' }, scope: { sessionId, projectId: 'prj_1' }, meta: { sessionId }, payload: { text: `n${i}` }, source: 'api' }
        : i % 3 === 1
          ? { type: 'session.restarted', actor: { kind: 'human', id: 'usr_1' }, scope: { sessionId }, meta: { sessionId }, source: 'api', idempotencyKey: `k${i}`, causationId: `evt_${i}` }
          : { type: 'session.restarted', actor: { kind: 'agent', id: sessionId }, scope: { sessionId, threadId: 'thr_1' }, meta: { sessionId }, source: 'hook', sourceTs: '2026-10-09T01:00:00.000Z' };
    store.append(e);
  }
  store.db.exec('DROP TRIGGER events_append_only_u');
  store.db.exec('DROP TRIGGER events_append_only_d');
  return store;
}

const flip = (s: string, i: number): string => {
  const c = s[i]!;
  const repl = c === '0' ? '1' : /[0-9a-f]/.test(c) ? '0' : c === 'a' ? 'b' : 'a';
  return s.slice(0, i) + repl + s.slice(i + 1);
};

/** Edits row `k` (or around it) and returns the seq at which verification should first fail. */
interface Tamper {
  name: string;
  apply(store: EventStore, k: number, rng: Rng): number;
}

const set = (store: EventStore, sql: string, ...args: (string | number)[]) => void store.db.prepare(sql).run(...args);
const simple = (name: string, sql: string): Tamper => ({
  name,
  apply: (store, k) => (set(store, sql, k), k),
});
const hexColumn = (col: 'prev_hash' | 'hash'): Tamper => ({
  name: col,
  apply: (store, k) => {
    const row = store.db.prepare(`SELECT ${col} AS v FROM events WHERE seq = ?`).get(k) as { v: string };
    set(store, `UPDATE events SET ${col} = ? WHERE seq = ?`, flip(row.v, 10), k);
    return k;
  },
});

const SWAPPED = ['id', 'ts', 'type', 'actor_kind', 'actor_id', 'scope_json', 'project_id', 'thread_id', 'session_id', 'task_id', 'ticket_id', 'change_id', 'decision_id', 'user_id', 'meta', 'payload_hash', 'body_scope', 'source', 'source_ts', 'idempotency_key', 'causation_id', 'prev_hash', 'hash'];

const TAMPERS: Tamper[] = [
  {
    name: 'meta, still JSON',
    apply: (store, k) => {
      const row = store.db.prepare('SELECT meta FROM events WHERE seq = ?').get(k) as { meta: string };
      set(store, 'UPDATE events SET meta = ? WHERE seq = ?', row.meta.replace(/ses_(\d)/, 'ses_9$1'), k);
      return k;
    },
  },
  {
    name: 'meta, no longer JSON',
    apply: (store, k) => {
      const row = store.db.prepare('SELECT meta FROM events WHERE seq = ?').get(k) as { meta: string };
      set(store, 'UPDATE events SET meta = ? WHERE seq = ?', `x${row.meta.slice(1)}`, k);
      return k;
    },
  },
  {
    name: 'meta, a number JSON cannot carry',
    apply: (store, k) => (set(store, `UPDATE events SET meta = '{"sessionId":"ses_1","n":1e999}' WHERE seq = ?`, k), k),
  },
  {
    name: 'scope_json, no longer JSON',
    apply: (store, k) => (set(store, "UPDATE events SET scope_json = 'not json' WHERE seq = ?", k), k),
  },
  hexColumn('prev_hash'),
  hexColumn('hash'),
  simple('ts', "UPDATE events SET ts = '2026-10-09T01:00:00.001Z' WHERE seq = ?"),
  simple('type', "UPDATE events SET type = 'session.stopped' WHERE seq = ?"),
  simple('actor_id', "UPDATE events SET actor_id = 'usr_other' WHERE seq = ?"),
  simple('actor_kind', "UPDATE events SET actor_kind = 'system' WHERE seq = ?"),
  simple('source', "UPDATE events SET source = 'system' WHERE seq = ?"),
  simple('source_ts', "UPDATE events SET source_ts = '2020-01-01T00:00:00.000Z' WHERE seq = ?"),
  simple('causation_id', "UPDATE events SET causation_id = 'evt_forged' WHERE seq = ?"),
  simple('idempotency_key', "UPDATE events SET idempotency_key = 'forged-key-1' WHERE seq = ?"),
  simple('id', "UPDATE events SET id = 'evt_forged' || seq WHERE seq = ?"),
  simple('scope_json', `UPDATE events SET scope_json = '{"sessionId":"ses_forged"}' WHERE seq = ?`),
  simple('indexed scope column only', "UPDATE events SET project_id = 'prj_forged' WHERE seq = ?"),
  simple('indexed scope column cleared', 'UPDATE events SET session_id = NULL WHERE seq = ?'),
  {
    name: 'payload_hash',
    apply: (store, k) => {
      const row = store.db.prepare('SELECT seq, payload_hash AS v FROM events WHERE seq >= ? AND payload_hash IS NOT NULL ORDER BY seq LIMIT 1').get(k) as { seq: number; v: string };
      set(store, 'UPDATE events SET payload_hash = ? WHERE seq = ?', flip(row.v, 3), row.seq);
      return row.seq;
    },
  },
  {
    name: 'a deleted row',
    // The hole is seen at the first row after it.
    apply: (store, k) => (set(store, 'DELETE FROM events WHERE seq = ?', k), k + 1),
  },
  {
    name: 'two rows swapped',
    apply: (store, k, rng) => {
      const j = k + rng.int(1, 3);
      const a = store.db.prepare('SELECT * FROM events WHERE seq = ?').get(k) as Record<string, string | null>;
      const b = store.db.prepare('SELECT * FROM events WHERE seq = ?').get(j) as Record<string, string | null>;
      // id and idempotency_key are UNIQUE: park them first.
      set(store, "UPDATE events SET id = 'tmp_a', idempotency_key = NULL WHERE seq = ?", k);
      set(store, "UPDATE events SET id = 'tmp_b', idempotency_key = NULL WHERE seq = ?", j);
      const upd = `UPDATE events SET ${SWAPPED.map((c) => `${c} = ?`).join(', ')} WHERE seq = ?`;
      store.db.prepare(upd).run(...SWAPPED.map((c) => b[c] as never), k);
      store.db.prepare(upd).run(...SWAPPED.map((c) => a[c] as never), j);
      return k;
    },
  },
];

describe('hash-chain tamper detection (§13, R2)', () => {
  it('verifyChain and verifyChainAsync both detect every kind of edit, agree exactly, and name the first bad row', async () => {
    const seen = new Set<string>();
    await forSeeds(
      'kernel tamper detection',
      async (rng, seed) => {
        const store = build();
        expect(store.verifyChain({ atSeqs: [1, CHAIN_LENGTH] })).toMatchObject({ ok: true, checked: CHAIN_LENGTH });
        const tamper = TAMPERS[(seed - 1) % TAMPERS.length]!;
        // Never the last rows: a missing tail is invisible in-file (next test), and some edits look ahead a few rows.
        const k = rng.int(2, CHAIN_LENGTH - 6);
        const firstBad = tamper.apply(store, k, rng);
        seen.add(tamper.name);

        let sync: ChainVerifyResult;
        let chunked: ChainVerifyResult;
        try {
          sync = store.verifyChain({ atSeqs: [1] });
          chunked = await store.verifyChainAsync({ atSeqs: [1], batch: 5 });
        } catch (err) {
          throw new Error(`verification threw instead of reporting "${tamper.name}" at seq ${k}: ${String(err)}`);
        }
        expect(sync.ok, `${tamper.name} at seq ${k} went undetected`).toBe(false);
        expect(sync.firstBadSeq, `${tamper.name} at seq ${k}`).toBe(firstBad);
        expect(chunked).toEqual(sync);
        store.close();
      },
      { count: TAMPERS.length * 3 },
    );
    if (!process.env.AOC_SEED) expect([...seen].sort()).toEqual(TAMPERS.map((t) => t.name).sort());
  });

  it('cutting rows off the tail leaves a self-consistent chain: only the recorded head (an anchor) shows it', () => {
    const store = build();
    const head = store.head();
    store.db.prepare('DELETE FROM events WHERE seq > ?').run(CHAIN_LENGTH - 5);
    const v = store.verifyChain();
    // Nothing inside the file is wrong: that is why mod-audit compares recomputed hashes with off-host anchors (R2).
    expect(v.ok).toBe(true);
    expect(v.headSeq).toBe(CHAIN_LENGTH - 5);
    expect(v.headHash).not.toBe(head.hash);
    store.close();
  });

  it('a different rng stream picks other rows (the generator is seeded, not fixed)', () => {
    expect(new Rng(1).int(0, 1_000_000)).not.toBe(new Rng(2).int(0, 1_000_000));
    expect(new Rng(7).int(0, 1_000_000)).toBe(new Rng(7).int(0, 1_000_000));
  });
});
