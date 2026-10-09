import { describe, expect, it } from 'vitest';
import {
  clauseFamily,
  compareClauses,
  defaultRange,
  familyCounts,
  formatBytes,
  packVerdict,
  rangeDays,
} from '../../src/pages/compliance/model';

describe('compliance model', () => {
  it('groups clauses into main clauses and Annex A control families', () => {
    expect(clauseFamily('6.1.4')).toEqual({ key: '6', annex: false, label: 'Clause 6', order: 6 });
    expect(clauseFamily('A.6.2.8')).toEqual({ key: 'A.6', annex: true, label: 'Annex A · A.6', order: 106 });
    expect(clauseFamily('A.10.3')).toMatchObject({ key: 'A.10', order: 110 });
    expect(clauseFamily('')).toMatchObject({ key: '—', label: 'Unnumbered', order: 999 });
  });

  it('sorts clauses in natural order, main clauses before Annex A', () => {
    const clauses = ['A.10.3', 'A.6.2.8', '7.5', 'A.3.2', '6.3', 'A.6.1.3', '10.2', '6.1.4', 'A.6.2.4'];
    expect([...clauses].sort(compareClauses)).toEqual([
      '6.1.4',
      '6.3',
      '7.5',
      '10.2',
      'A.3.2',
      'A.6.1.3',
      'A.6.2.4',
      'A.6.2.8',
      'A.10.3',
    ]);
  });

  it('counts mapped rows per family for the coverage strip', () => {
    const counts = familyCounts([
      { clause: 'A.6.2.8' },
      { clause: '6.3' },
      { clause: 'A.6.1.3' },
      { clause: '6.1.4' },
    ]);
    expect(counts.map((c) => [c.family.key, c.rows])).toEqual([
      ['6', 2],
      ['A.6', 2],
    ]);
  });

  it('calls a pack evidence only when the chain recomputed and every anchor matched', () => {
    expect(packVerdict({ chainOk: true, anchorsChecked: 2, anchorsMatched: 2 })).toEqual({
      ok: true,
      tone: 'ok',
      label: 'chain and 2 anchors verified',
    });
    expect(packVerdict({ chainOk: true, anchorsChecked: 1, anchorsMatched: 1 }).label).toBe(
      'chain and 1 anchor verified',
    );
    expect(packVerdict({ chainOk: true, anchorsChecked: 0, anchorsMatched: 0 })).toMatchObject({
      ok: false,
      tone: 'warn',
      label: 'no anchor checked',
    });
    expect(packVerdict({ chainOk: true, anchorsChecked: 3, anchorsMatched: 1 })).toMatchObject({
      ok: false,
      label: '2 anchors differ',
    });
    expect(packVerdict({ chainOk: false, anchorsChecked: 1, anchorsMatched: 1 })).toMatchObject({
      ok: false,
      tone: 'danger',
      label: 'chain broken',
    });
  });

  it('counts inclusive days and defaults to the last seven local days', () => {
    expect(rangeDays('2026-10-03', '2026-10-09')).toBe(7);
    expect(rangeDays('2026-10-09', '2026-10-09')).toBe(1);
    expect(rangeDays('2026-10-09', '2026-10-03')).toBe(0);
    expect(rangeDays('', '2026-10-03')).toBe(0);
    const r = defaultRange(new Date(2026, 9, 9, 15, 0).getTime());
    expect(r).toEqual({ from: '2026-10-03', to: '2026-10-09' });
  });

  it('formats pack sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(48_213)).toBe('47.1 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
