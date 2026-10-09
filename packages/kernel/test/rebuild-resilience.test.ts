/**
 * A projector that throws on one event must never make the log unrebuildable. Live, a failing projector is isolated
 * in a savepoint and marked degraded (ingestion goes on); a rebuild has to treat the same event the same way, or one
 * poison event turns "degraded" into "aocd cannot start": start-up rebuilds every degraded projection first.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AocConfigSchema } from '@aoc/contracts';
import { AocRuntime, EventStore, FakeClock, silentLogger, type AocModule, type NewEvent, type Projector } from '../src';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const nudge = (sessionId: string): NewEvent => ({
  type: 'session.nudged',
  actor: { kind: 'human', id: 'usr_1' },
  scope: { sessionId },
  meta: { sessionId },
  payload: { text: `to ${sessionId}` },
  source: 'api',
});

/** Writes a row per event, then throws on the poison session: a half-done row must not survive either. */
function fragile(name: string): Projector {
  return {
    name,
    tables: [`t_${name}`],
    ddl: [`CREATE TABLE IF NOT EXISTS t_${name} (seq INTEGER PRIMARY KEY, session_id TEXT)`],
    apply({ db }, e) {
      db.prepare(`INSERT INTO t_${name} VALUES (?, ?)`).run(e.seq, e.scope.sessionId ?? null);
      if (e.scope.sessionId === 'ses_poison') throw new Error('cannot project this event');
    },
  };
}
function steady(name: string): Projector {
  return {
    name,
    tables: [`t_${name}`],
    ddl: [`CREATE TABLE IF NOT EXISTS t_${name} (seq INTEGER PRIMARY KEY)`],
    apply({ db }, e) {
      db.prepare(`INSERT INTO t_${name} VALUES (?)`).run(e.seq);
    },
  };
}

const rows = (s: EventStore, table: string) => (s.db.prepare(`SELECT seq FROM ${table} ORDER BY seq`).all() as { seq: number }[]).map((r) => r.seq);

describe('rebuilding a log that holds an event a projector cannot handle', () => {
  it('skips the event for that projector, marks it degraded, and rebuilds everything else completely', () => {
    const s = new EventStore({ dataDir: ':memory:', clock: new FakeClock(), log: silentLogger, masterKey: randomBytes(32) });
    s.registerProjector(fragile('a'));
    s.registerProjector(steady('b'));
    for (const sid of ['ses_1', 'ses_poison', 'ses_2', 'ses_3']) s.append(nudge(sid));
    expect(s.projectionHealth()).toMatchObject([{ name: 'a', status: 'degraded', failedSeq: 2 }]);
    const liveA = rows(s, 't_a');
    expect(liveA).toEqual([1, 3, 4]);

    expect(() => s.rebuildProjections()).not.toThrow();
    expect(rows(s, 't_a'), 'the same rows the live path kept').toEqual(liveA);
    expect(rows(s, 't_b')).toEqual([1, 2, 3, 4]);
    expect(s.projectionHealth()).toMatchObject([{ name: 'a', status: 'degraded', failedSeq: 2 }]);
    expect(s.verifyChain().ok).toBe(true);

    // Rebuilding only the healthy projector must not clear the other one's flag.
    s.rebuildProjections(['b']);
    expect(s.projectionHealth()).toMatchObject([{ name: 'a', status: 'degraded' }]);
  });

  it('start-up survives it: the runtime comes up with the projection degraded instead of failing to start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-poison-'));
    dirs.push(dir);
    const key = randomBytes(32);
    const config = AocConfigSchema.parse({ dataDir: dir });
    const modules = (): AocModule[] => [{ name: 'fragile', projectors: [fragile('a')] }, { name: 'steady', projectors: [steady('b')] }];
    const first = await AocRuntime.create({ config, modules: modules(), clock: new FakeClock(), log: silentLogger, masterKey: key });
    for (const sid of ['ses_1', 'ses_poison', 'ses_2']) first.store.append(nudge(sid));
    expect(first.store.projectionHealth()).toMatchObject([{ name: 'a', status: 'degraded' }]);
    await first.stop();

    // The degraded projection is rebuilt at start-up, and the poison event is in the log for good.
    const second = await AocRuntime.create({ config, modules: modules(), clock: new FakeClock(), log: silentLogger, masterKey: key });
    expect(rows(second.store, 't_a')).toEqual([1, 3]);
    expect(rows(second.store, 't_b')).toEqual([1, 2, 3]);
    expect(second.store.projectionHealth()).toMatchObject([{ name: 'a', status: 'degraded', failedSeq: 2 }]);
    await second.stop();
  });

  it('a projector fixed since heals on the next rebuild', () => {
    const s = new EventStore({ dataDir: ':memory:', clock: new FakeClock(), log: silentLogger, masterKey: randomBytes(32) });
    let broken = true;
    const p: Projector = {
      ...steady('c'),
      apply(ctx, e) {
        if (broken && e.seq === 2) throw new Error('bug');
        steady('c').apply(ctx, e, null);
      },
    };
    s.registerProjector(p);
    for (const sid of ['ses_1', 'ses_2', 'ses_3']) s.append(nudge(sid));
    expect(rows(s, 't_c')).toEqual([1, 3]);
    broken = false;
    s.rebuildProjections();
    expect(rows(s, 't_c')).toEqual([1, 2, 3]);
    expect(s.projectionHealth()).toEqual([]);
  });
});
