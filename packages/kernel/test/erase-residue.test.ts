/**
 * Erasing a scope must leave none of its text in the raw aoc.db file or its WAL (§13, gap G-39). `secure_delete` zeroes
 * what a DELETE removes, but SQLite rebuilds a b-tree page when it rebalances siblings and leaves the cells it moved
 * behind in the page's unallocated gap, so rows that were once on such a page can survive their own deletion.
 * Which rows depends on the exact layout of the table, hence seeded layouts: many scopes, rows added in batches
 * (interleaved or scope by scope), short or long rows.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { EventStore, FakeClock, createLogger, forSeeds, silentLogger, type Projector, type Rng } from '../src';

/** What the sessions projector does with message ids: one row per id, keyed by the owning scope. */
const rows: Projector = {
  name: 'rows',
  tables: ['res_rows'],
  ddl: ['CREATE TABLE IF NOT EXISTS res_rows (scope_id TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY (scope_id, text))'],
  handles: ['session.nudged'],
  apply({ db }, e, payload) {
    const text = (payload as { text: string } | null)?.text;
    if (text === undefined) return;
    const ins = db.prepare('INSERT OR IGNORE INTO res_rows (scope_id, text) VALUES (?, ?)');
    for (const t of text.split('\n')) ins.run(e.scope.sessionId!, t);
  },
  onErase(db, scopeId) {
    db.prepare('DELETE FROM res_rows WHERE scope_id = ?').run(scopeId);
  },
};

interface Layout {
  scopes: string[];
  texts: Map<string, string[]>;
}

/** Appends a seeded layout to the store, one event per batch of rows. */
function fill(s: EventStore, rng: Rng): Layout {
  const scopes = Array.from({ length: rng.int(8, 40) }, () => `ses_${rng.hex(8)}`);
  const texts = new Map<string, string[]>(scopes.map((sc) => [sc, []]));
  const interleave = rng.chance(0.5);
  const long = rng.chance(0.5);
  const row = () => {
    const n = long ? rng.int(16, 190) : 20;
    return `msg_${rng.hex(Math.ceil(n / 2)).slice(0, n)}`;
  };
  const batch = (scope: string, n: number) => {
    const batchTexts = Array.from({ length: n }, row);
    texts.get(scope)!.push(...batchTexts);
    s.append({
      type: 'session.nudged',
      actor: { kind: 'human', id: 'usr_1' },
      scope: { sessionId: scope },
      meta: { sessionId: scope },
      payload: { text: batchTexts.join('\n') },
      source: 'api',
    });
  };
  if (interleave) {
    const events = scopes.length * rng.int(4, 12);
    for (let i = 0; i < events; i++) batch(rng.pick(scopes), rng.int(1, 10));
  } else {
    for (const sc of scopes) {
      for (let left = rng.int(5, 120); left > 0; ) {
        const n = Math.min(left, rng.int(1, 12));
        batch(sc, n);
        left -= n;
      }
    }
  }
  return { scopes, texts };
}

const onDisk = (dir: string): Buffer[] =>
  ['aoc.db', 'aoc.db-wal']
    .map((f) => join(dir, f))
    .filter((p) => existsSync(p))
    .map((p) => readFileSync(p));

describe('erasing a scope leaves nothing of its rows in the database file', () => {
  it('holds for seeded table layouts, and the scan can see rows that were not erased', async () => {
    await forSeeds(
      'erasure residue',
      (rng) => {
        const dir = mkdtempSync(join(tmpdir(), 'aoc-residue-'));
        const s = new EventStore({ dataDir: dir, clock: new FakeClock(), log: silentLogger, masterKey: randomBytes(32) });
        try {
          s.registerProjector(rows);
          const { scopes, texts } = fill(s, rng);
          s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); // the rows have reached the main file
          const victim = rng.pick(scopes);
          s.eraseScope(victim, { actor: { kind: 'human', id: 'usr_approver' }, reason: 'pdpa_request' });

          const files = onDisk(dir);
          const survivor = texts.get(scopes.find((sc) => sc !== victim)!)![0]!;
          expect(files.some((b) => b.includes(Buffer.from(survivor))), 'the scan finds text that was not erased').toBe(true);
          const left = texts.get(victim)!.filter((t) => files.some((b) => b.includes(Buffer.from(t))));
          expect(left, `${left.length} of ${texts.get(victim)!.length} erased rows of ${victim} are still in the file`).toEqual([]);
          expect(s.db.prepare('SELECT count(*) AS n FROM res_rows WHERE scope_id = ?').get(victim)).toEqual({ n: 0 });
        } finally {
          s.close();
          rmSync(dir, { recursive: true, force: true });
        }
      },
      // 187 and 269 are layouts that left a row behind before the erasure vacuumed the file.
      { count: 25, pinned: [187, 269] },
    );
  }, 300_000);

  it('says so when a reader holds an older snapshot, because the WAL cannot be truncated then; the text goes with the next checkpoint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-residue-'));
    const logged: string[] = [];
    const log = createLogger({ level: 'warn', sink: (line) => logged.push(line) });
    const s = new EventStore({ dataDir: dir, clock: new FakeClock(), log, masterKey: randomBytes(32) });
    const reader = new DatabaseSync(join(dir, 'aoc.db'), { readOnly: true });
    try {
      s.registerProjector(rows);
      const secret = 'NRIC 850101-14-5555 and a note nobody else may keep';
      s.append({ type: 'session.nudged', actor: { kind: 'human', id: 'usr_1' }, scope: { sessionId: 'ses_a' }, meta: { sessionId: 'ses_a' }, payload: { text: secret }, source: 'api' });
      s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      // A backup copying the database holds a snapshot like this one for as long as it takes.
      reader.exec('BEGIN');
      reader.prepare('SELECT count(*) FROM res_rows').get();

      s.eraseScope('ses_a', { actor: { kind: 'human', id: 'usr_approver' }, reason: 'pdpa_request' });
      expect(logged.join('\n')).toMatch(/WAL could not be truncated/);
      expect(onDisk(dir).some((b) => b.includes(Buffer.from('850101-14-5555')))).toBe(true);

      reader.exec('COMMIT');
      s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      expect(onDisk(dir).some((b) => b.includes(Buffer.from('850101-14-5555')))).toBe(false);
    } finally {
      reader.close();
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('says nothing when nobody is reading', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-residue-'));
    const logged: string[] = [];
    const s = new EventStore({ dataDir: dir, clock: new FakeClock(), log: createLogger({ level: 'warn', sink: (line) => logged.push(line) }), masterKey: randomBytes(32) });
    try {
      s.registerProjector(rows);
      s.append({ type: 'session.nudged', actor: { kind: 'human', id: 'usr_1' }, scope: { sessionId: 'ses_a' }, meta: { sessionId: 'ses_a' }, payload: { text: 'a note' }, source: 'api' });
      s.eraseScope('ses_a', { actor: { kind: 'human', id: 'usr_approver' }, reason: 'pdpa_request' });
      expect(logged).toEqual([]);
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
