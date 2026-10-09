/**
 * A projector must see an event exactly as a rebuild will see it (CLAUDE.md: projections are a pure function of the
 * log). The chain stores meta and bodies as canonical JSON (keys sorted, undefined members dropped), and a rebuild
 * reads them back from that; so the live path has to hand projectors the same normalised values, not the caller's
 * objects, or a projector that keeps JSON text, looks at `key in meta` or walks the keys of a payload writes one
 * thing live and another after every restart's rebuild.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EventStore, FakeClock, silentLogger, type NewEvent, type Projector } from '../src';

/** Keeps what it was given, as text and as facts about its shape. */
const witness: Projector = {
  name: 'witness',
  tables: ['t_witness'],
  ddl: ['CREATE TABLE IF NOT EXISTS t_witness (seq INTEGER PRIMARY KEY, meta TEXT, meta_keys TEXT, has_stale INTEGER, payload TEXT, payload_keys TEXT, scope TEXT)'],
  apply({ db }, e, payload) {
    db.prepare('INSERT INTO t_witness VALUES (?,?,?,?,?,?,?)').run(
      e.seq,
      JSON.stringify(e.meta),
      Object.keys(e.meta).join(','),
      'stale' in e.meta ? 1 : 0,
      JSON.stringify(payload),
      payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload).join(',') : '',
      JSON.stringify(e.scope),
    );
  },
};

const open = () => {
  const s = new EventStore({ dataDir: ':memory:', clock: new FakeClock(), log: silentLogger, masterKey: randomBytes(32) });
  s.registerProjector(witness);
  return s;
};
const table = (s: EventStore) => s.db.prepare('SELECT * FROM t_witness ORDER BY seq').all();

/** Keys out of order, nested keys out of order, a member that is `undefined`, an array holding `undefined`. */
const awkward: NewEvent[] = [
  {
    type: 'thread.writer_released',
    actor: { kind: 'system', id: 'ledger' },
    scope: { threadId: 'thr_1', sessionId: 'ses_1' },
    meta: { reason: 'ended', sessionId: 'ses_1', threadId: 'thr_1', stale: undefined },
    source: 'system',
  },
  {
    type: 'session.nudged',
    actor: { kind: 'human', id: 'usr_1' },
    scope: { sessionId: 'ses_1' },
    meta: { sessionId: 'ses_1' },
    payload: { text: 'hello', zebra: { z: 1, a: [3, undefined, { y: 1, b: 2 }] }, apple: undefined, mid: 2 },
    source: 'api',
  } as unknown as NewEvent,
];

describe('what a projector sees live is what a rebuild reads back', () => {
  it('keeps the same text, the same keys in the same order, and no members the log does not hold', () => {
    const s = open();
    for (const e of awkward) s.append(e);
    const live = table(s);
    s.rebuildProjections();
    expect(table(s)).toEqual(live);
    // ... and not only up to key order: the rows are identical as text.
    expect(JSON.stringify(table(s))).toBe(JSON.stringify(live));
  });

  it('hands back, from append, the event as it will be read from the log', () => {
    const s = open();
    const stored = awkward.map((e) => s.append(e));
    for (const e of stored) expect(JSON.stringify(e)).toBe(JSON.stringify(s.get(e.seq)));
  });

  it('gives commit listeners the same body a replay holds', () => {
    const s = open();
    const seen: unknown[] = [];
    s.subscribe((_e, payload) => seen.push(payload));
    s.append(awkward[1]!);
    expect(JSON.stringify(seen[0])).toBe(JSON.stringify(s.readPayload(s.get(1)!)));
  });

  it('chains only the actor\'s kind and id: a wider object (a user record, say) does not make the chain unverifiable', () => {
    const s = open();
    const user = { kind: 'human', id: 'usr_1', name: 'Aminah binti Yusof', email: 'aminah@example.com' } as unknown as NewEvent['actor'];
    const e = s.append({ ...awkward[1]!, actor: user });
    expect(e.actor).toEqual({ kind: 'human', id: 'usr_1' });
    expect(s.verifyChain()).toMatchObject({ ok: true });
    const rows = s.db.prepare('SELECT hash FROM events ORDER BY seq').all();
    s.rebuildProjections();
    expect(s.db.prepare('SELECT hash FROM events ORDER BY seq').all()).toEqual(rows);
    expect(JSON.stringify(s.get(1))).not.toContain('Aminah');
  });
});
