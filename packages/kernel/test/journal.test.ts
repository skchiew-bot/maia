import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestRuntime, EventStore, FakeClock, silentLogger } from '../src';

const journalMode = (db: DatabaseSync): string =>
  (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('SQLite journal mode (§15.1: hash-chained SQLite in WAL)', () => {
  it('aoc.db and bodies.db are in WAL mode, recorded in the files themselves', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-wal-'));
    dirs.push(dir);
    const store = new EventStore({
      dataDir: dir,
      clock: new FakeClock(),
      log: silentLogger,
      masterKey: randomBytes(32),
    });
    store.append({
      type: 'session.nudged',
      actor: { kind: 'human', id: 'usr_1' },
      scope: { sessionId: 'ses_a' },
      meta: { sessionId: 'ses_a' },
      payload: { text: 'a body, so bodies.db is written too' },
      source: 'api',
    });
    expect(journalMode(store.db)).toBe('wal');
    expect(journalMode(store.bodies.db)).toBe('wal');
    for (const file of ['aoc.db', 'bodies.db']) {
      expect(existsSync(join(dir, `${file}-wal`)), file).toBe(true);
      // WAL persists in the database header: every other connection (Verify, backup, sqlite3) sees it.
      const other = new DatabaseSync(join(dir, file));
      expect(journalMode(other), file).toBe('wal');
      other.close();
    }
    store.close();
  });

  it('the runtime opens both databases of an on-disk data dir in WAL', async () => {
    const t = await createTestRuntime({ modules: [], onDisk: true });
    expect(journalMode(t.rt.store.db)).toBe('wal');
    expect(journalMode(t.rt.store.bodies.db)).toBe('wal');
    await t.close();
  });
});
