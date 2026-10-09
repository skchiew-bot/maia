/**
 * What an erasure must leave behind (§13): nothing that was in the erased bodies. The plaintext of a scope is
 * collected from its decrypted bodies before the erasure, then searched for in every table of the database
 * (projections, FTS shadow tables, the event table's clear columns) and in the raw database and WAL files.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { EventStore } from '@aoc/kernel';

const leaves = (v: unknown, out: string[]): void => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) leaves(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) leaves(x, out);
};

/** Every body in the log, grouped by the body scope that decides who can erase it. */
export function bodiesByScope(store: EventStore): Map<string, string[]> {
  const byScope = new Map<string, string[]>();
  const rows = store.db.prepare('SELECT seq FROM events WHERE payload_hash IS NOT NULL AND body_scope IS NOT NULL ORDER BY seq').all() as { seq: number }[];
  for (const { seq } of rows) {
    const e = store.get(seq)!;
    const payload = store.readPayload(e);
    if (payload === null) continue;
    const list = byScope.get(e.bodyScope!) ?? [];
    leaves(payload, list);
    byScope.set(e.bodyScope!, list);
  }
  return byScope;
}

/**
 * Strings that appear only in the bodies of `scope`: ids, enum values and text that the clear chain or other scopes
 * also hold may legitimately survive, so they are not evidence of a leak.
 */
export function plaintextOnlyIn(store: EventStore, scope: string, minLength = 6): string[] {
  const all = bodiesByScope(store);
  const mine = [...new Set(all.get(scope) ?? [])].filter((s) => s.trim().length >= minLength);
  const others: string[] = [];
  for (const [k, list] of all) if (k !== scope) others.push(...list);
  const clear = (store.db.prepare('SELECT group_concat(meta || scope_json || actor_id || coalesce(idempotency_key, \'\') || coalesce(causation_id, \'\'), \' \') AS t FROM events').get() as { t: string | null }).t ?? '';
  const elsewhere = `${others.join('\u0000')}\u0000${clear}`;
  return mine.filter((s) => !elsewhere.includes(s));
}

export interface Hit {
  where: string;
  needle: string;
}

/** Search every table of the database for any of the needles. */
export function scanTables(db: DatabaseSync, needles: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  for (const t of names) {
    let rows: Record<string, unknown>[];
    try {
      rows = db.prepare(`SELECT * FROM "${t}"`).all() as Record<string, unknown>[];
    } catch {
      continue;
    }
    for (const row of rows) {
      for (const [col, v] of Object.entries(row)) {
        const text = typeof v === 'string' ? v : v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : '';
        if (!text) continue;
        for (const n of needles) if (text.includes(n)) hits.push({ where: `${t}.${col}`, needle: n });
      }
    }
  }
  return hits;
}

/** Search the database file and its write-ahead log for any of the needles. */
export function scanFiles(dataDir: string, needles: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  for (const f of ['aoc.db', 'aoc.db-wal']) {
    const path = join(dataDir, f);
    if (!existsSync(path)) continue;
    const bytes = readFileSync(path);
    for (const n of needles) if (bytes.includes(Buffer.from(n, 'utf8'))) hits.push({ where: f, needle: n });
  }
  return hits;
}

/**
 * Terms the FTS index of the knowledge layer holds that no remaining document would put there. A delete in FTS5 only
 * adds tombstones, so the terms of an erased document stay in the index segments until a merge; this compares the
 * live index with a fresh one built from the documents that are left.
 */
export function ftsOrphanTerms(db: DatabaseSync): string[] {
  const vocab = (table: string): Set<string> => {
    db.exec(`DROP TABLE IF EXISTS temp.v_check`);
    db.exec(`CREATE VIRTUAL TABLE temp.v_check USING fts5vocab(main, ${table}, row)`);
    const terms = new Set((db.prepare('SELECT term FROM temp.v_check').all() as { term: string }[]).map((r) => r.term));
    db.exec(`DROP TABLE temp.v_check`);
    return terms;
  };
  const live = vocab('reg_knowledge');
  db.exec('DROP TABLE IF EXISTS main.zz_fresh');
  db.exec("CREATE VIRTUAL TABLE main.zz_fresh USING fts5(title, body, tokenize = 'porter unicode61 remove_diacritics 2')");
  try {
    db.exec('INSERT INTO main.zz_fresh (rowid, title, body) SELECT rowid, title, body FROM reg_knowledge');
    const fresh = vocab('zz_fresh');
    return [...live].filter((t) => !fresh.has(t)).sort();
  } finally {
    db.exec('DROP TABLE IF EXISTS main.zz_fresh');
  }
}
