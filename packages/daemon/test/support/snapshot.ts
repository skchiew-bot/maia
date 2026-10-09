import type { DatabaseSync } from 'node:sqlite';
import type { Projector } from '@aoc/kernel';

/** Tables the kernel and runtime own (not projections). */
const CORE_TABLES = new Set(['events', 'chain_info', 'projection_health', 'projection_state', 'reactor_cursors', 'reactor_failures', 'job_runs', 'sqlite_sequence']);

type Row = Record<string, unknown>;

export interface TableSnapshot {
  /** Rows in rowid order, each as canonical JSON (blobs as hex). */
  ordered: string[];
}

export interface Snapshot {
  tables: Record<string, TableSnapshot>;
}

const sortDeep = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(sortDeep)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as Row).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sortDeep(x)]))
      : v;

/** A JSON document kept as text in a column is the same document whatever order its keys were written in. */
const normalizeCell = (v: unknown): unknown => {
  if (v instanceof Uint8Array) return `0x${Buffer.from(v).toString('hex')}`;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && /^\s*[[{]/.test(v)) {
    try {
      return { json: sortDeep(JSON.parse(v)) };
    } catch {
      return v;
    }
  }
  return v;
};

/**
 * Surrogate keys that number rows by the history of inserts and deletes (an INTEGER PRIMARY KEY that is only the join
 * key to an FTS rowid): a rebuild renumbers them after a delete, and nothing reads their value. Compared as consistency
 * (every document has its index row) rather than as content.
 */
const SURROGATE_KEYS: Record<string, string[]> = { reg_kn_docs: ['k'] };

const canon = (row: Row, table: string): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(row)
        .filter(([k]) => !SURROGATE_KEYS[table]?.includes(k))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, normalizeCell(v)]),
    ),
  );

export function declaredTables(projectors: readonly Projector[]): string[] {
  return [...new Set(projectors.flatMap((p) => p.tables))].sort();
}

/** Every table of the database that is neither the kernel's, a declared projection table, nor an FTS shadow of one. */
export function undeclaredTables(db: DatabaseSync, projectors: readonly Projector[]): string[] {
  const declared = new Set(declaredTables(projectors));
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
  return names
    .filter((n) => !CORE_TABLES.has(n) && !declared.has(n))
    .filter((n) => ![...declared].some((d) => /^(?:_data|_idx|_content|_docsize|_config)$/.test(n.slice(d.length)) && n.startsWith(d)))
    .sort();
}

/** SELECT * of every projection table, in rowid order. */
export function snapshotProjections(db: DatabaseSync, projectors: readonly Projector[]): Snapshot {
  const tables: Record<string, TableSnapshot> = {};
  for (const t of declaredTables(projectors)) {
    const exists = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = ? AND type IN ('table')").get(t);
    if (!exists) {
      tables[t] = { ordered: ['<missing>'] };
      continue;
    }
    let rows: Row[];
    try {
      rows = db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all() as Row[];
    } catch {
      rows = db.prepare(`SELECT * FROM "${t}"`).all() as Row[];
    }
    tables[t] = { ordered: rows.map((r) => canon(r, t)) };
  }
  return { tables };
}

export interface Diff {
  table: string;
  kind: 'content' | 'order';
  /** Rows only in `a` (live) / only in `b` (rebuilt), capped. */
  onlyA: string[];
  onlyB: string[];
}

const multiset = (xs: string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return m;
};

export function diffSnapshots(a: Snapshot, b: Snapshot, only?: readonly string[]): Diff[] {
  const out: Diff[] = [];
  for (const t of new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])) {
    if (only && !only.includes(t)) continue;
    const ra = a.tables[t]?.ordered ?? [];
    const rb = b.tables[t]?.ordered ?? [];
    const ma = multiset(ra);
    const mb = multiset(rb);
    const onlyA: string[] = [];
    const onlyB: string[] = [];
    for (const [k, n] of ma) if ((mb.get(k) ?? 0) < n) onlyA.push(k);
    for (const [k, n] of mb) if ((ma.get(k) ?? 0) < n) onlyB.push(k);
    if (onlyA.length || onlyB.length) out.push({ table: t, kind: 'content', onlyA: onlyA.slice(0, 40), onlyB: onlyB.slice(0, 40) });
    else if (ra.some((r, i) => r !== rb[i])) out.push({ table: t, kind: 'order', onlyA: ra.slice(0, 2), onlyB: rb.slice(0, 2) });
  }
  return out;
}

/** The fields on which the closest pair of live/rebuilt rows differ: what actually changed, not the whole row. */
function fieldDiff(a: string, others: string[]): string {
  const ra = JSON.parse(a) as Row;
  let best: { row: Row; same: number } | null = null;
  for (const o of others) {
    const rb = JSON.parse(o) as Row;
    const same = Object.keys(ra).filter((k) => JSON.stringify(ra[k]) === JSON.stringify(rb[k])).length;
    if (!best || same > best.same) best = { row: rb, same };
  }
  if (!best) return `only live: ${a.slice(0, 200)}`;
  const keys = Object.keys({ ...ra, ...best.row }).filter((k) => JSON.stringify(ra[k]) !== JSON.stringify(best!.row[k]));
  const id = Object.entries(ra)
    .filter(([k]) => /(^|_)id$|^key$|^date$/.test(k))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join(' ');
  return `${id} :: ${keys.map((k) => `${k}: ${JSON.stringify(ra[k])?.slice(0, 70)} -> ${JSON.stringify(best!.row[k])?.slice(0, 70)}`).join('; ')}`;
}

export function describeDiffs(diffs: Diff[]): string {
  return diffs
    .map((d) => {
      if (d.kind === 'order') return `${d.table} (same rows, different order)`;
      const lines = d.onlyA.length ? d.onlyA.map((r) => fieldDiff(r, d.onlyB)) : d.onlyB.map((r) => `only rebuilt: ${r.slice(0, 200)}`);
      return `${d.table}: ${lines.join('\n      ')}`;
    })
    .join('\n   ');
}
