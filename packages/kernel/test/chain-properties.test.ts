/**
 * Randomized properties of the hash-chained event store (spec §13, R2). Every case is seeded: a failure names its
 * seed, and `AOC_SEED=<n> pnpm --filter @aoc/kernel test chain-properties` replays it.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { StoredEvent } from '@aoc/contracts';
import {
  EventStore,
  EventValidationError,
  FakeClock,
  forSeeds,
  sha256hex,
  silentLogger,
  type NewEvent,
  type Projector,
  type Rng,
} from '../src';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'aoc-chainprop-'));
  dirs.push(d);
  return d;
}

function openStore(dir: string, key: Buffer, clock = new FakeClock()): EventStore {
  return new EventStore({ dataDir: dir, clock, log: silentLogger, masterKey: key });
}

const SESSIONS = ['ses_a', 'ses_b', 'ses_c'];
const invalid = new WeakSet<NewEvent>();

/** A catalog-valid event: header-only (restarted) or with an encrypted body (nudged). */
function genEvent(rng: Rng, opts: { sessionId?: string; key?: string | null } = {}): NewEvent {
  const sessionId = opts.sessionId ?? rng.pick(SESSIONS);
  const key = opts.key === undefined ? (rng.chance(0.3) ? `key-${rng.int(1, 10)}` : undefined) : (opts.key ?? undefined);
  const base = {
    actor: { kind: 'human' as const, id: 'usr_prop' },
    scope: { sessionId },
    source: 'api' as const,
    ...(key ? { idempotencyKey: key } : {}),
  };
  return rng.chance(0.5)
    ? ({ ...base, type: 'session.restarted', meta: { sessionId } } as NewEvent)
    : ({ ...base, type: 'session.nudged', meta: { sessionId }, payload: { text: `note ${rng.hex(6)}` } } as NewEvent);
}

/** An event the store must refuse; a batch holding one must leave no trace at all. */
function genInvalid(rng: Rng): NewEvent {
  const e = genEvent(rng, { key: null });
  const bad: NewEvent = (() => {
    switch (rng.int(0, 3)) {
      case 0:
        return { ...e, meta: { ...(e.meta as object), text: 'free text in meta' } } as unknown as NewEvent;
      case 1:
        return { ...e, type: 'no.such.event' } as unknown as NewEvent;
      case 2:
        return { ...e, sourceTs: 'yesterday-ish' };
      default:
        return { ...e, idempotencyKey: `bad\u0000key${rng.hex(2)}` };
    }
  })();
  invalid.add(bad);
  return bad;
}

describe('chain continuity under interleaved writes (§13)', () => {
  it('append, appendMany, idempotent replays, rejected batches and failing projectors keep one contiguous, verifiable chain', async () => {
    await forSeeds('kernel chain continuity', async (rng) => {
      const dir = tempDir();
      const key = randomBytes(32);
      const clock = new FakeClock();
      const store = openStore(dir, key, clock);
      const genesis = sha256hex(`aoc-genesis:${store.chainId}`);
      const mirror: Projector = {
        name: 'mirror',
        tables: ['t_mirror'],
        ddl: ['CREATE TABLE IF NOT EXISTS t_mirror (seq INTEGER PRIMARY KEY, id TEXT NOT NULL, session_id TEXT)'],
        apply({ db }, e) {
          // Writes first, fails afterwards: the half-done row must not survive the projector's savepoint.
          db.prepare('INSERT INTO t_mirror VALUES (?,?,?)').run(e.seq, e.id, e.scope.sessionId ?? null);
          if (e.scope.sessionId === 'ses_poison') throw new Error('projector bug');
        },
      };
      const tally: Projector = {
        name: 'tally',
        tables: ['t_tally'],
        ddl: ['CREATE TABLE IF NOT EXISTS t_tally (seq INTEGER PRIMARY KEY)'],
        apply({ db }, e) {
          db.prepare('INSERT INTO t_tally VALUES (?)').run(e.seq);
        },
      };
      store.registerProjector(mirror);
      store.registerProjector(tally);
      const heard: number[] = [];
      store.subscribe(() => {
        throw new Error('a listener bug must not undo a commit');
      });
      store.subscribe((e) => heard.push(e.seq));

      const model: { e: StoredEvent; payload: unknown }[] = [];
      const byKey = new Map<string, StoredEvent>();

      const apply = (inputs: NewEvent[]) => {
        const before = store.head();
        if (inputs.some((i) => invalid.has(i))) {
          // A key an earlier event of the batch would have claimed must not stay claimed.
          expect(() => store.appendMany(inputs)).toThrow(EventValidationError);
          expect(store.head()).toEqual(before);
          return;
        }
        const out = store.appendMany(inputs);
        expect(out).toHaveLength(inputs.length);
        out.forEach((e, i) => {
          const k = inputs[i]!.idempotencyKey;
          const prior = k ? byKey.get(k) : undefined;
          if (prior) {
            expect(e.id, 'a replayed key returns the original event').toBe(prior.id);
            return;
          }
          model.push({ e, payload: inputs[i]!.payload ?? null });
          if (k) byKey.set(k, e);
        });
        expect(store.head().seq).toBe(model.length);
      };

      const check = async () => {
        const rows = store.list({ limit: 100_000 });
        expect(rows.map((e) => [e.seq, e.id, e.hash])).toEqual(model.map(({ e }) => [e.seq, e.id, e.hash]));
        expect(store.head().seq).toBe(model.length);
        expect(store.head().hash).toBe(model.length ? model.at(-1)!.e.hash : genesis);
        rows.forEach((e, i) => expect(e.prevHash).toBe(i === 0 ? genesis : rows[i - 1]!.hash));
        const v = store.verifyChain();
        expect(v).toMatchObject({ ok: true, headSeq: model.length, checked: model.length, firstBadSeq: null });
        expect(await store.verifyChainAsync({ batch: 7 })).toEqual(v);
        // No body outlives a rolled-back batch, and every committed body still opens and matches its blinded hash.
        const bodies = (store.bodies.db.prepare('SELECT COUNT(*) AS n FROM bodies').get() as { n: number }).n;
        expect(bodies).toBe(model.filter((m) => m.e.payloadHash !== null).length);
        for (const m of model) {
          expect(store.readPayload(m.e)).toEqual(m.payload);
          if (m.e.payloadHash) expect(store.verifyBody(m.e)).toBe(true);
        }
        // Projections: the failing projector's half-written rows are gone, the healthy one has every event.
        const poisoned = model.filter((m) => m.e.scope.sessionId === 'ses_poison').map((m) => m.e.seq);
        const tallied = (store.db.prepare('SELECT seq FROM t_tally ORDER BY seq').all() as { seq: number }[]).map((r) => r.seq);
        expect(tallied).toEqual(model.map((m) => m.e.seq));
        const mirrored = (store.db.prepare('SELECT seq FROM t_mirror ORDER BY seq').all() as { seq: number }[]).map((r) => r.seq);
        expect(mirrored).toEqual(model.map((m) => m.e.seq).filter((s) => !poisoned.includes(s)));
        const health = store.projectionHealth().find((h) => h.name === 'mirror');
        expect(health?.status ?? null).toBe(poisoned.length ? 'degraded' : null);
        if (poisoned.length) expect(health?.failedSeq).toBe(poisoned.at(-1));
        expect(heard).toEqual(model.map((m) => m.e.seq));
      };

      const ops = rng.int(25, 60);
      for (let i = 0; i < ops; i++) {
        clock.advance(rng.int(0, 2000));
        const poison = rng.chance(0.08) ? 'ses_poison' : undefined;
        switch (rng.weighted([['one', 4], ['batch', 3], ['bad', 2], ['replay', 3]] as const)) {
          case 'one':
            apply([genEvent(rng, { sessionId: poison })]);
            break;
          case 'batch':
            apply(Array.from({ length: rng.int(1, 5) }, () => genEvent(rng, { sessionId: rng.chance(0.1) ? 'ses_poison' : undefined })));
            break;
          case 'bad': {
            const batch = Array.from({ length: rng.int(1, 4) }, () => genEvent(rng));
            batch.splice(rng.int(0, batch.length), 0, genInvalid(rng));
            apply(batch);
            break;
          }
          default:
            // Same key, different content: the original wins and nothing new is written.
            apply([genEvent(rng, { key: byKey.size ? rng.pick([...byKey.keys()]) : 'key-1' })]);
        }
        if (i % 9 === 0) await check();
      }
      await check();

      // A restart sees the same chain and keeps appending onto it.
      store.close();
      const again = openStore(dir, key, clock);
      expect(again.head()).toMatchObject({ seq: model.length, hash: model.length ? model.at(-1)!.e.hash : genesis });
      const next = again.append(genEvent(rng, { key: null }));
      expect(next.seq).toBe(model.length + 1);
      expect(next.prevHash).toBe(model.length ? model.at(-1)!.e.hash : genesis);
      expect(again.verifyChain().ok).toBe(true);
      again.close();
    });
  });
});
