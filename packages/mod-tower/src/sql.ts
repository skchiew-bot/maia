import type { DatabaseSync, StatementSync } from 'node:sqlite';

const cache = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/**
 * Prepared-statement cache: the projector runs on every ingested event and a snapshot issues dozens of reads,
 * so compiling SQL once per connection matters. SQLite re-prepares transparently after a rebuild's DROP/CREATE.
 */
export function stmt(db: DatabaseSync, sql: string): StatementSync {
  let byDb = cache.get(db);
  if (!byDb) cache.set(db, (byDb = new Map()));
  let s = byDb.get(sql);
  if (!s) byDb.set(sql, (s = db.prepare(sql)));
  return s;
}
