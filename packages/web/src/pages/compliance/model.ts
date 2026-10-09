/**
 * ISO/IEC 42001 mapping and evidence packs (§13, §14) as the UI reads them. Clause numbers and titles are shown
 * only as the API returns them (the mapping is provisional until the compliance lead stamps its hash).
 */
import type { ComplianceMappingRowDTO, EvidencePackSummaryDTO } from '@aoc/contracts';
import type { Tone } from '../../components/tone';

export interface ClauseFamily {
  /** "A.6" for Annex A controls, "6" for main clauses. */
  key: string;
  annex: boolean;
  label: string;
  /** Sort order: main clauses first, then Annex A, each numerically. */
  order: number;
}

export function clauseFamily(clause: string): ClauseFamily {
  const c = clause.trim();
  const annex = /^A\.(\d+)/i.exec(c);
  if (annex) {
    const n = Number(annex[1]);
    return { key: `A.${n}`, annex: true, label: `Annex A · A.${n}`, order: 100 + n };
  }
  const main = /^(\d+)/.exec(c);
  if (main) {
    const n = Number(main[1]);
    return { key: String(n), annex: false, label: `Clause ${n}`, order: n };
  }
  return { key: c || '—', annex: false, label: c || 'Unnumbered', order: 999 };
}

/** Natural clause order: 6.1.4 < 6.3 < 7.5 < A.3.2 < A.6.1.3 < A.6.2.4 < A.10.3. */
export function compareClauses(a: string, b: string): number {
  const fa = clauseFamily(a);
  const fb = clauseFamily(b);
  if (fa.order !== fb.order) return fa.order - fb.order;
  const parts = (s: string) => s.replace(/^A\./i, '').split('.').map(Number);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? -1) - (pb[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

export interface FamilyCount {
  family: ClauseFamily;
  rows: number;
}

/** Mapped rows per clause family, in clause order (the coverage strip). */
export function familyCounts(rows: readonly Pick<ComplianceMappingRowDTO, 'clause'>[]): FamilyCount[] {
  const by = new Map<string, FamilyCount>();
  for (const r of rows) {
    const f = clauseFamily(r.clause);
    const cur = by.get(f.key);
    if (cur) cur.rows += 1;
    else by.set(f.key, { family: f, rows: 1 });
  }
  return [...by.values()].sort((a, b) => a.family.order - b.family.order);
}

export interface PackVerdict {
  ok: boolean;
  tone: Tone;
  label: string;
}

/** A pack is evidence only when its chain recomputed and every anchor it checked matched. */
export function packVerdict(
  p: Pick<EvidencePackSummaryDTO, 'chainOk' | 'anchorsChecked' | 'anchorsMatched'>,
): PackVerdict {
  if (!p.chainOk) return { ok: false, tone: 'danger', label: 'chain broken' };
  if (p.anchorsChecked === 0) return { ok: false, tone: 'warn', label: 'no anchor checked' };
  if (p.anchorsMatched < p.anchorsChecked)
    return { ok: false, tone: 'danger', label: `${p.anchorsChecked - p.anchorsMatched} anchors differ` };
  return {
    ok: true,
    tone: 'ok',
    label: `chain and ${p.anchorsMatched} ${p.anchorsMatched === 1 ? 'anchor' : 'anchors'} verified`,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date `YYYY-MM-DD`. */
export function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Default pack range: the last seven local days, today included. */
export function defaultRange(now: number): { from: string; to: string } {
  return { from: localDay(now - 6 * 86_400_000), to: localDay(now) };
}

/** Inclusive day count of a `YYYY-MM-DD` range (0 when invalid or reversed). */
export function rangeDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86_400_000) + 1;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
