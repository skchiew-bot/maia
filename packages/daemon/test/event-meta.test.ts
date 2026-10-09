/**
 * What the chain may hold in clear (CLAUDE.md event-sourcing rules, spec §13).
 *
 * `meta` is chained without encryption and survives a crypto-shred, so it may carry ids, enums, numbers, booleans,
 * hashes and short machine labels, never free text, file contents, prompts, personal data or secrets. The catalog
 * is the contract for that: every meta schema is walked, and a field that could hold text of any length (an
 * unbounded string, `any`, a record of strings) is a leak waiting for a writer who passes it a user's words.
 * Writers are also exercised with hostile values: what reaches the chain through an event's meta has to be one of
 * the schema's values, not the caller's text.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ALL_EVENTS, EVENT_CATALOG, validateEvent, zHash, zId, zIso, zLabel, zSha } from '@aoc/contracts';

/** The longest a string in meta may be: ids are 64, labels 80, an anchor's proof reference (vcs:<sha>:<path>) 300. */
const MAX_CLEAR_STRING = 300;

/** A pattern with no open-ended repetition outside a character class matches strings of bounded length. */
function patternIsBounded(source: string): boolean {
  const flat = source.replace(/\\./g, '_').replace(/\[[^\]]*\]/g, '_');
  return !/[*+]|\{\d+,\}/.test(flat);
}

interface Finding {
  event: string;
  path: string;
  why: string;
}

function walk(schema: z.ZodTypeAny, path: string, out: (path: string, why: string) => void): void {
  const def = schema._def as { typeName: string; [k: string]: unknown };
  switch (def.typeName) {
    case 'ZodString': {
      const checks = (def.checks as { kind: string; value?: number; regex?: RegExp }[]) ?? [];
      const max = Math.min(...checks.filter((c) => c.kind === 'max' || c.kind === 'length').map((c) => c.value!), Infinity);
      // Hashes, shas, file names of a fixed format and uuids are bounded by their pattern.
      const bounded = checks.some((c) => c.kind === 'uuid' || c.kind === 'datetime' || (c.kind === 'regex' && patternIsBounded(c.regex!.source)));
      if (max > MAX_CLEAR_STRING && !bounded)
        out(path, max === Infinity ? 'a string of any length' : `a string of up to ${max} characters`);
      return;
    }
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      for (const [k, v] of Object.entries(shape)) walk(v, path ? `${path}.${k}` : k, out);
      return;
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodReadonly':
      return walk(def.innerType as z.ZodTypeAny, path, out);
    case 'ZodDefault':
      return walk(def.innerType as z.ZodTypeAny, path, out);
    case 'ZodEffects':
      return walk(def.schema as z.ZodTypeAny, path, out);
    case 'ZodBranded':
      return walk(def.type as z.ZodTypeAny, path, out);
    case 'ZodArray':
      return walk(def.type as z.ZodTypeAny, `${path}[]`, out);
    case 'ZodRecord':
      out(path, 'a record with caller-chosen keys');
      return walk(def.valueType as z.ZodTypeAny, `${path}{}`, out);
    case 'ZodUnion':
    case 'ZodDiscriminatedUnion':
      for (const o of (def.options as z.ZodTypeAny[] | Map<unknown, z.ZodTypeAny>) instanceof Map
        ? [...(def.options as Map<unknown, z.ZodTypeAny>).values()]
        : (def.options as z.ZodTypeAny[]))
        walk(o, path, out);
      return;
    case 'ZodIntersection':
      walk(def.left as z.ZodTypeAny, path, out);
      return walk(def.right as z.ZodTypeAny, path, out);
    case 'ZodTuple':
      for (const [i, item] of (def.items as z.ZodTypeAny[]).entries()) walk(item, `${path}[${i}]`, out);
      return;
    case 'ZodAny':
    case 'ZodUnknown':
      out(path, 'any value');
      return;
    case 'ZodEnum':
    case 'ZodNativeEnum':
    case 'ZodLiteral':
    case 'ZodNumber':
    case 'ZodBoolean':
    case 'ZodBigInt':
    case 'ZodNull':
    case 'ZodUndefined':
    case 'ZodNaN':
      return;
    default:
      out(path, `a ${def.typeName} the lint does not know`);
  }
}

function findings(): Finding[] {
  const out: Finding[] = [];
  for (const d of ALL_EVENTS) walk(d.meta as z.ZodTypeAny, '', (path, why) => out.push({ event: d.type, path, why }));
  return out;
}

/** Fields known to violate the lint and waiting for a contract change. The list may only shrink; it is empty now. */
const KNOWN: string[] = [];

describe('the clear-text chain holds machine values only (§13)', () => {
  it('every meta schema is strict, and no meta field can hold text of any length', () => {
    const lax = ALL_EVENTS.filter((d) => (d.meta as z.ZodObject<z.ZodRawShape>)._def.unknownKeys !== 'strict').map((d) => d.type);
    expect(lax, 'meta schemas that accept unknown keys').toEqual([]);
    const unbounded = findings().map((f) => `${f.event} meta.${f.path}`);
    expect(
      unbounded.filter((f) => !KNOWN.includes(f)),
      'meta fields that could carry free text: bound them, type them (zId, zLabel, zHash, an enum) or move them to the payload',
    ).toEqual([]);
    expect(KNOWN.filter((k) => !unbounded.includes(k)), 'fixed since: remove from KNOWN').toEqual([]);
  });

  it('a value outside a field\'s type is refused where it would be chained (new events included)', () => {
    // session.git_pushed names the refs a model pushed (agent-chosen text): they must stay in the encrypted body.
    const def = EVENT_CATALOG.get('session.git_pushed')!;
    const ok = { sessionId: 'ses_1', credentialProfile: 'deploy-main', refs: 2, forwarded: 1, refused: 1, failed: 0 };
    const payload = { results: [{ ref: 'refs/heads/Aminah-Yusof-900101', oldSha: 'a'.repeat(40), newSha: 'b'.repeat(40), result: 'forwarded', reason: null }] };
    expect(validateEvent('session.git_pushed', ok, payload)).toEqual([]);
    for (const hostile of [
      { ...ok, ref: 'refs/heads/Aminah-Yusof-900101' },
      { ...ok, credentialProfile: 'Aminah binti Yusof' },
      { ...ok, credentialProfile: 'x'.repeat(81) },
      { ...ok, refs: 0 },
      { ...ok, forwarded: -1 },
      { ...ok, results: payload.results },
    ])
      expect(validateEvent('session.git_pushed', hostile, payload), JSON.stringify(hostile)).not.toEqual([]);
    expect(Object.keys((def.meta as z.ZodObject<z.ZodRawShape>).shape).sort()).toEqual(['credentialProfile', 'failed', 'forwarded', 'refs', 'refused', 'sessionId']);
  });
});

describe('the lint itself', () => {
  const flagged = (schema: z.ZodTypeAny): string[] => {
    const out: string[] = [];
    walk(schema, '', (path) => out.push(path));
    return out;
  };
  it('flags what could carry text, and passes ids, labels, hashes, enums and numbers', () => {
    expect(flagged(z.object({ a: z.string() }))).toEqual(['a']);
    expect(flagged(z.object({ a: z.string().max(5000) }))).toEqual(['a']);
    expect(flagged(z.object({ a: z.array(z.string()).max(3) }))).toEqual(['a[]']);
    expect(flagged(z.object({ a: z.record(z.number()) }))).toEqual(['a']);
    expect(flagged(z.object({ a: z.any(), b: z.unknown() }))).toEqual(['a', 'b']);
    expect(flagged(z.object({ a: z.object({ b: z.string().nullable().optional() }) }))).toEqual(['a.b']);
    expect(
      flagged(
        z.object({
          id: zId,
          label: zLabel,
          hash: zHash,
          sha: zSha,
          kind: z.enum(['a', 'b']),
          n: z.number(),
          ok: z.boolean(),
          at: zIso,
          file: z.string().regex(/^backup-\d{8}\.bk$/),
          uuid: z.string().uuid(),
          ids: z.array(zId),
        }),
      ),
    ).toEqual([]);
  });
});
