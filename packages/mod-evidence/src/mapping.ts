import { existsSync, readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import {
  EVENT_CATALOG,
  ISO42001_STANDARD,
  MAPPING_STATUSES,
  type MappingSource,
  type MetaFilters,
  type MetaFilterValue,
} from '@aoc/contracts';
import { canonicalJson, sha256hex } from '@aoc/kernel';
import { BUILTIN_MAPPING } from './default-mapping';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const text = (max: number) => z.string().trim().min(1).max(max);
const scalar = z.union([z.string().max(80), z.number().finite(), z.boolean(), z.null()]);

export const MappingRowSchema = z.object({
  id: text(80),
  aocControl: text(300),
  aocFeature: text(2000),
  clause: text(60),
  clauseTitle: text(300),
  relatedClauses: z.array(text(60)).max(20).default([]),
  evidence: z.array(text(2000)).max(50).default([]),
  /** Catalog event types; `prefix.*` expands to every catalog type under that prefix. */
  eventTypes: z.array(text(120)).max(100).default([]),
  metaFilters: z
    .record(z.string(), z.record(z.string(), z.union([scalar, z.array(scalar).min(1)])))
    .default({}),
  status: z.enum(MAPPING_STATUSES).default('provisional'),
  correctionNote: z.string().trim().max(2000).nullable().optional(),
});

/** The mapping file format (config/iso42001-mapping.json). Unknown keys are ignored. */
export const MappingFileSchema = z
  .object({
    version: z
      .union([z.string(), z.number()])
      .transform((v) => String(v).trim())
      .pipe(z.string().min(1).max(40)),
    standard: z.literal(ISO42001_STANDARD),
    status: z.enum(MAPPING_STATUSES).default('provisional'),
    stampedBy: z.string().max(200).nullable().optional(),
    stampedAt: z.string().max(60).nullable().optional(),
    notes: z
      .union([z.string(), z.array(z.string())])
      .nullable()
      .optional(),
    rows: z.array(MappingRowSchema).min(1).max(300),
  })
  .superRefine((m, ctx) => {
    const seen = new Set<string>();
    m.rows.forEach((row, i) => {
      if (seen.has(row.id))
        ctx.addIssue({ code: 'custom', path: ['rows', i, 'id'], message: `duplicate row id '${row.id}'` });
      seen.add(row.id);
      const { types, unknown } = expandEventTypes(row.eventTypes);
      for (const u of unknown) {
        ctx.addIssue({
          code: 'custom',
          path: ['rows', i, 'eventTypes'],
          message: `unknown event type '${u}'`,
        });
      }
      for (const [type, fields] of Object.entries(row.metaFilters)) {
        const path = ['rows', i, 'metaFilters', type];
        if (!types.includes(type)) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: `filter for '${type}', which is not in the row's eventTypes`,
          });
          continue;
        }
        const shape = metaShapeOf(type);
        for (const [field, allowed] of Object.entries(fields)) {
          const fieldSchema = shape?.[field];
          if (!fieldSchema) {
            ctx.addIssue({
              code: 'custom',
              path: [...path, field],
              message: `'${type}' has no meta field '${field}'`,
            });
            continue;
          }
          for (const v of toArray(allowed)) {
            if (!fieldSchema.safeParse(v).success) {
              ctx.addIssue({
                code: 'custom',
                path: [...path, field],
                message: `${JSON.stringify(v)} is not a valid '${type}' ${field}`,
              });
            }
          }
        }
      }
    });
  });
export type MappingFile = z.input<typeof MappingFileSchema>;

/** Normalised mapping row: event types expanded, filters as arrays, no self-declared status. */
export interface MappingRow {
  id: string;
  aocControl: string;
  aocFeature: string;
  clause: string;
  clauseTitle: string;
  relatedClauses: string[];
  evidence: string[];
  eventTypes: string[];
  metaFilters: MetaFilters;
  correctionNote: string | null;
}

export interface ComplianceMapping {
  standard: string;
  version: string;
  notes: string;
  rows: MappingRow[];
}

export interface LoadedMapping {
  mapping: ComplianceMapping;
  /** sha256 of the canonical normalised mapping: what a stamp is bound to. */
  hash: string;
  source: MappingSource;
  /** The mapping file consulted (null when none exists). */
  file: string | null;
  warnings: string[];
}

function toArray(v: MetaFilterValue | MetaFilterValue[]): MetaFilterValue[] {
  return Array.isArray(v) ? v : [v];
}

function metaShapeOf(type: string): Record<string, z.ZodTypeAny> | null {
  const schema = EVENT_CATALOG.get(type)?.meta;
  return schema instanceof z.ZodObject ? (schema.shape as Record<string, z.ZodTypeAny>) : null;
}

/** Expand `prefix.*` wildcards against the catalog; preserves order and drops duplicates. */
export function expandEventTypes(input: readonly string[]): { types: string[]; unknown: string[] } {
  const types: string[] = [];
  const unknown: string[] = [];
  const add = (t: string) => {
    if (!types.includes(t)) types.push(t);
  };
  for (const raw of input) {
    if (raw.endsWith('.*')) {
      const prefix = raw.slice(0, -1);
      const matches = [...EVENT_CATALOG.keys()].filter((t) => t.startsWith(prefix));
      if (matches.length) matches.forEach(add);
      else unknown.push(raw);
    } else if (EVENT_CATALOG.has(raw)) add(raw);
    else unknown.push(raw);
  }
  return { types, unknown };
}

function normalize(file: z.output<typeof MappingFileSchema>): ComplianceMapping {
  const notes = Array.isArray(file.notes) ? file.notes.join('\n') : (file.notes ?? '');
  return {
    standard: file.standard,
    version: file.version,
    notes: notes.trim(),
    rows: file.rows.map((r) => ({
      id: r.id,
      aocControl: r.aocControl,
      aocFeature: r.aocFeature,
      clause: r.clause,
      clauseTitle: r.clauseTitle,
      relatedClauses: r.relatedClauses,
      evidence: r.evidence,
      eventTypes: expandEventTypes(r.eventTypes).types,
      metaFilters: Object.fromEntries(
        Object.entries(r.metaFilters).map(([type, fields]) => [
          type,
          Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, toArray(v)])),
        ]),
      ),
      correctionNote: r.correctionNote || null,
    })),
  };
}

export function mappingHash(m: ComplianceMapping): string {
  return sha256hex(canonicalJson(m));
}

/** Validate + normalise a parsed mapping document. */
export function parseMapping(
  doc: unknown,
): { ok: true; mapping: ComplianceMapping; selfStamped: boolean } | { ok: false; problems: string[] } {
  const r = MappingFileSchema.safeParse(doc);
  if (!r.success) {
    return {
      ok: false,
      problems: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }
  const selfStamped = r.data.status === 'stamped' || r.data.rows.some((row) => row.status === 'stamped');
  return { ok: true, mapping: normalize(r.data), selfStamped };
}

let builtinCache: LoadedMapping | null = null;

/** The built-in default (AOC-SPEC-003 §13 corrected clauses), always provisional. */
export function builtinMapping(): LoadedMapping {
  if (!builtinCache) {
    const r = parseMapping(BUILTIN_MAPPING);
    if (!r.ok) throw new Error(`built-in compliance mapping is invalid: ${r.problems.join('; ')}`);
    builtinCache = {
      mapping: r.mapping,
      hash: mappingHash(r.mapping),
      source: 'builtin',
      file: null,
      warnings: [],
    };
  }
  return { ...builtinCache, warnings: [] };
}

/**
 * Load the mapping file when present; on any problem fall back to the built-in default with warnings.
 * A file can never stamp itself: stamps exist only as mapping.stamped events bound to the hash.
 */
export function loadMapping(file: string | null): LoadedMapping {
  if (!file || !existsSync(file)) return builtinMapping();
  const fallback = (problems: string[]): LoadedMapping => ({
    ...builtinMapping(),
    file,
    warnings: [`${file} rejected; using the built-in default mapping`, ...problems.slice(0, 20)],
  });
  let doc: unknown;
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return fallback([`file larger than ${MAX_FILE_BYTES} bytes`]);
    doc = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return fallback([`not readable JSON: ${(err as Error).message}`]);
  }
  const r = parseMapping(doc);
  if (!r.ok) return fallback(r.problems);
  const warnings = r.selfStamped
    ? [
        `${file} declares itself stamped; only a mapping.stamped event by the compliance lead stamps a mapping — treated as provisional`,
      ]
    : [];
  return { mapping: r.mapping, hash: mappingHash(r.mapping), source: 'config', file, warnings };
}

/** Row matchers indexed by event type (rows may filter on meta, e.g. decision.resolved kind=go_live). */
export function rowIndex(
  rows: readonly MappingRow[],
): Map<string, { row: number; filter: Record<string, MetaFilterValue[]> | null }[]> {
  const index = new Map<string, { row: number; filter: Record<string, MetaFilterValue[]> | null }[]>();
  rows.forEach((r, i) => {
    for (const t of r.eventTypes) {
      const list = index.get(t) ?? [];
      list.push({ row: i, filter: r.metaFilters[t] ?? null });
      index.set(t, list);
    }
  });
  return index;
}

export function matchesFilter(
  filter: Record<string, MetaFilterValue[]> | null,
  meta: Record<string, unknown>,
): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([k, allowed]) =>
    allowed.includes((meta[k] ?? null) as MetaFilterValue),
  );
}
