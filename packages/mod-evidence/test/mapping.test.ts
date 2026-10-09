import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EVENT_CATALOG } from '@aoc/contracts';
import {
  BUILTIN_MAPPING,
  builtinMapping,
  loadMapping,
  mappingHash,
  parseMapping,
  type MappingFile,
  type MappingRow,
} from '../src';

const rows = builtinMapping().mapping.rows;
const row = (id: string): MappingRow => {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`no row ${id}`);
  return r;
};

describe('built-in default mapping (§13 corrections)', () => {
  it('carries the five corrected clauses', () => {
    expect(row('aoc.event-log').clause).toBe('A.6.2.8');
    expect(row('aoc.technical-documentation').clause).toBe('A.6.2.7');
    expect(row('aoc.roles').clause).toBe('A.3.2');
    expect(row('aoc.incident-communication').clause).toBe('A.8.4');
    expect(row('aoc.resources').clause).toMatch(/^A\.4\.\d+$/);
  });

  it('has none of the AOC-SPEC-002 mistakes', () => {
    // Event logging is never A.6.2.6; A.6.2.6 is monitoring and cites no log-integrity evidence.
    const logging = ['anchor.created', 'anchor.failed', 'chain.verified'];
    for (const r of rows.filter((x) => x.clause === 'A.6.2.6')) {
      expect(r.id).toBe('aoc.monitoring');
      expect(r.aocControl).not.toMatch(/log/i);
      expect(r.eventTypes.filter((t) => logging.includes(t))).toEqual([]);
    }
    expect(
      rows
        .filter((r) => /event log/i.test(r.aocControl) || r.eventTypes.includes('anchor.created'))
        .map((r) => r.clause),
    ).toEqual(['A.6.2.8']);
    expect(row('aoc.roles').clause).not.toMatch(/^A\.5/);
    expect(row('aoc.incident-communication').clause).not.toBe('A.8.3');
    expect(row('aoc.resources').clause).not.toMatch(/^A\.7/);
    expect(row('aoc.change-management').clause).not.toBe('A.6.2.7');
  });

  it('wires every required control to its catalog evidence', () => {
    expect(row('aoc.change-management')).toMatchObject({ clause: '6.3', relatedClauses: ['8.1'] });
    expect(row('aoc.impact-assessment').clause).toMatch(/^A\.5\./);
    expect(row('aoc.impact-assessment').relatedClauses).toContain('6.1.4');
    expect(row('aoc.impact-assessment').eventTypes).toContain('change.drafted');
    expect(row('aoc.monitoring')).toMatchObject({ clause: 'A.6.2.6' });
    expect(row('aoc.monitoring').eventTypes).toContain('session.liveness_changed');
    expect(row('aoc.verification-validation')).toMatchObject({ clause: 'A.6.2.4' });
    expect(row('aoc.verification-validation').eventTypes).toEqual(
      expect.arrayContaining(['task.done', 'rollback.verified', 'ticket.uat_result']),
    );
    const deployment = row('aoc.deployment');
    expect(deployment.clause).toBe('A.6.2.5');
    const promotionTypes = [...EVENT_CATALOG.keys()].filter((t) => t.startsWith('promotion.'));
    expect(deployment.eventTypes).toEqual(expect.arrayContaining([...promotionTypes, 'decision.resolved']));
    expect(deployment.metaFilters).toEqual({ 'decision.resolved': { kind: ['go_live'] } });
    expect(row('aoc.incident-communication').eventTypes).toEqual(
      [...EVENT_CATALOG.keys()].filter((t) => t.startsWith('breakglass.')),
    );
    expect(row('aoc.information-for-users')).toMatchObject({ clause: 'A.8.2' });
    expect(row('aoc.information-for-users').eventTypes).toContain('ticket.public_status_changed');
    expect(row('aoc.resources').eventTypes).toEqual(
      expect.arrayContaining(['usage.recorded', 'rollup.closed']),
    );
    expect(row('aoc.data').clause).toMatch(/^A\.7\./);
    expect(row('aoc.data').eventTypes).toContain('intake.attachment_stored');
    expect(row('aoc.suppliers').clause).toBe('A.10.3');
    const corrective = row('aoc.corrective-action');
    expect(corrective.clause).toBe('10.2');
    expect(corrective.eventTypes).toEqual(
      expect.arrayContaining([
        'offence.transitioned',
        ...[...EVENT_CATALOG.keys()].filter((t) => t.startsWith('lesson.')),
      ]),
    );
  });

  it('is provisional throughout, with unique ids and catalog-only event types', () => {
    expect(BUILTIN_MAPPING.status).toBe('provisional');
    expect(BUILTIN_MAPPING.rows.every((r) => r.status === 'provisional')).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const r of rows) for (const t of r.eventTypes) expect(EVENT_CATALOG.has(t), t).toBe(true);
    expect(builtinMapping().source).toBe('builtin');
    expect(builtinMapping().hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('mapping file loading', () => {
  const dirs: string[] = [];
  const file = (content: unknown): string => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-map-'));
    dirs.push(dir);
    const p = join(dir, 'iso42001-mapping.json');
    writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
    return p;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const valid = (): MappingFile => ({
    version: '2026.10.2',
    standard: 'ISO/IEC 42001:2023',
    status: 'provisional',
    stampedBy: null,
    stampedAt: null,
    notes: 'from the compliance lead',
    rows: [
      {
        id: 'R1',
        aocControl: 'Event logging',
        aocFeature: 'Hash-chained log',
        clause: 'A.6.2.8',
        clauseTitle: 'AI system recording of event logs',
        evidence: ['chain'],
        eventTypes: ['anchor.created', 'promotion.*'],
        status: 'provisional',
      },
      {
        id: 'R2',
        aocControl: 'Deployment',
        aocFeature: 'Go-live gate',
        clause: 'A.6.2.5',
        clauseTitle: 'AI system deployment',
        evidence: ['go-live'],
        eventTypes: ['decision.resolved'],
        metaFilters: { 'decision.resolved': { kind: 'go_live' } },
        status: 'provisional',
        correctionNote: 'confirmed',
      },
      {
        id: 'R3',
        aocControl: 'AI policy',
        aocFeature: 'Documentary only',
        clause: 'A.2.2',
        clauseTitle: 'AI policy',
        evidence: ['signed policy'],
        eventTypes: [],
        status: 'provisional',
      },
    ],
  });

  it('uses the built-in default (no warnings) when the file is absent', () => {
    const m = loadMapping(join(tmpdir(), 'definitely-missing-aoc-mapping.json'));
    expect(m.source).toBe('builtin');
    expect(m.file).toBeNull();
    expect(m.warnings).toEqual([]);
    expect(loadMapping(null).source).toBe('builtin');
  });

  it('loads a valid file, expanding prefix wildcards and normalising filters', () => {
    const p = file(valid());
    const m = loadMapping(p);
    expect(m.source).toBe('config');
    expect(m.file).toBe(p);
    expect(m.warnings).toEqual([]);
    expect(m.mapping.version).toBe('2026.10.2');
    expect(m.mapping.rows[0]!.eventTypes).toEqual([
      'anchor.created',
      ...[...EVENT_CATALOG.keys()].filter((t) => t.startsWith('promotion.')),
    ]);
    expect(m.mapping.rows[1]!.metaFilters).toEqual({ 'decision.resolved': { kind: ['go_live'] } });
    expect(m.mapping.rows[2]!.eventTypes).toEqual([]);
    expect(m.hash).not.toBe(builtinMapping().hash);
  });

  it.each([
    ['invalid JSON', '{ not json', /not readable JSON/],
    ['a wrong standard', { ...valid(), standard: 'ISO/IEC 42001' }, /standard/],
    [
      'an unknown event type',
      { ...valid(), rows: [{ ...valid().rows[0]!, eventTypes: ['change.rolled_back'] }] },
      /unknown event type 'change\.rolled_back'/,
    ],
    [
      'an empty wildcard',
      { ...valid(), rows: [{ ...valid().rows[0]!, eventTypes: ['nothing.*'] }] },
      /unknown event type 'nothing\.\*'/,
    ],
    [
      'duplicate row ids',
      { ...valid(), rows: [valid().rows[0]!, valid().rows[0]!] },
      /duplicate row id 'R1'/,
    ],
    [
      'a filter on an unknown meta field',
      { ...valid(), rows: [{ ...valid().rows[1]!, metaFilters: { 'decision.resolved': { flavour: 'x' } } }] },
      /no meta field 'flavour'/,
    ],
    [
      'a filter value outside the enum',
      {
        ...valid(),
        rows: [{ ...valid().rows[1]!, metaFilters: { 'decision.resolved': { kind: 'golive' } } }],
      },
      /"golive" is not a valid/,
    ],
    [
      'a filter for a type the row does not cite',
      { ...valid(), rows: [{ ...valid().rows[1]!, metaFilters: { 'task.done': { flag: null } } }] },
      /not in the row's eventTypes/,
    ],
    ['no rows', { ...valid(), rows: [] }, /rows/],
  ])('falls back to the built-in default with a warning for %s', (_label, content, problem) => {
    const p = file(content);
    const m = loadMapping(p);
    expect(m.source).toBe('builtin');
    expect(m.hash).toBe(builtinMapping().hash);
    expect(m.file).toBe(p);
    expect(m.warnings[0]).toMatch(/rejected; using the built-in default mapping/);
    expect(m.warnings.slice(1).join('\n')).toMatch(problem);
  });

  it('never lets a file stamp itself', () => {
    const m = loadMapping(
      file({ ...valid(), status: 'stamped', stampedBy: 'someone', stampedAt: '2026-10-01' }),
    );
    expect(m.source).toBe('config');
    expect(m.warnings.join(' ')).toMatch(/declares itself stamped/);
  });

  it('hashes the normalised content: stable, sensitive to rows, blind to self-declared status', () => {
    const a = parseMapping(valid());
    const b = parseMapping({ ...valid(), rows: valid().rows.map((r) => ({ ...r, status: 'stamped' })) });
    const c = parseMapping({
      ...valid(),
      rows: [{ ...valid().rows[0]!, clause: 'A.6.2.6' }, ...valid().rows.slice(1)],
    });
    if (!a.ok || !b.ok || !c.ok) throw new Error('expected valid mappings');
    expect(mappingHash(a.mapping)).toBe(mappingHash(b.mapping));
    expect(mappingHash(a.mapping)).not.toBe(mappingHash(c.mapping));
    expect(loadMapping(file(valid())).hash).toBe(mappingHash(a.mapping));
  });
});
