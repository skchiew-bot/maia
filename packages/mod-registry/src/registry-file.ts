/** Fixed process-type registry file (§2.2): load, validate, hash and diff. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProcessRegistrySchema, type ProcessRegistry, type ProcessType } from '@aoc/contracts';
import { canonicalJson, sha256hex } from '@aoc/kernel';

export interface LoadedRegistry {
  path: string;
  registry: ProcessRegistry;
  /** sha256 of the canonical JSON of the file: formatting-insensitive, any content change counts. */
  hash: string;
  types: ReadonlyMap<string, ProcessType>;
}

export class RegistryFileError extends Error {
  override name = 'RegistryFileError';
}

/** Throws RegistryFileError with every problem listed: an invalid registry must stop aocd from starting. */
export function loadRegistryFile(file: string): LoadedRegistry {
  const path = resolve(file);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new RegistryFileError(
      `Process-type registry ${path} cannot be read (${(err as NodeJS.ErrnoException).code ?? String(err)}); set config.registryFile`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new RegistryFileError(`Process-type registry ${path} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = ProcessRegistrySchema.safeParse(raw);
  const problems = parsed.success
    ? []
    : parsed.error.issues.map((i) => `${formatPath(i.path)}: ${i.message}`);
  if (parsed.success) {
    const seen = new Set<string>();
    for (const t of parsed.data.types) {
      if (seen.has(t.id)) problems.push(`types: duplicate process type id "${t.id}"`);
      seen.add(t.id);
    }
  }
  if (!parsed.success || problems.length) {
    throw new RegistryFileError(
      `Invalid process-type registry ${path}:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }
  const registry = deepFreeze(parsed.data);
  return {
    path,
    registry,
    hash: sha256hex(canonicalJson(raw)),
    types: new Map(registry.types.map((t) => [t.id, t])),
  };
}

/** The list is fixed for the life of the process: consumers get read-only objects. */
function deepFreeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

function formatPath(path: (string | number)[]): string {
  if (!path.length) return '(root)';
  return path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? p : `.${p}`)).join('');
}

/** Free-text fields are summarised as "changed" rather than quoted. */
const TEXT_FIELDS = new Set(['name', 'description']);

/** Human-readable summary of what changed between two registry versions (stored in the encrypted payload). */
export function diffRegistries(
  prev: ProcessRegistry | null,
  next: ProcessRegistry,
  hadPrevious: boolean,
): string {
  const ids = next.types.map((t) => t.id).join(', ');
  if (!hadPrevious) return `initial registry ${next.version}: ${next.types.length} process types (${ids})`;
  if (!prev)
    return `previous registry snapshot unavailable; now ${next.version} with ${next.types.length} process types (${ids})`;
  const lines: string[] = [];
  if (prev.version !== next.version) lines.push(`version ${prev.version} → ${next.version}`);
  const before = new Map(prev.types.map((t) => [t.id, t]));
  const after = new Map(next.types.map((t) => [t.id, t]));
  const added = next.types.filter((t) => !before.has(t.id)).map((t) => t.id);
  const removed = prev.types.filter((t) => !after.has(t.id)).map((t) => t.id);
  if (added.length) lines.push(`added: ${added.join(', ')}`);
  if (removed.length) lines.push(`removed: ${removed.join(', ')}`);
  for (const t of next.types) {
    const old = before.get(t.id);
    if (!old) continue;
    const changes: string[] = [];
    const keys = [...new Set([...Object.keys(old), ...Object.keys(t)])].sort();
    for (const k of keys) {
      const a = (old as Record<string, unknown>)[k];
      const b = (t as Record<string, unknown>)[k];
      if (canonicalJson(a ?? null) === canonicalJson(b ?? null)) continue;
      const scalar = (v: unknown) => v === undefined || v === null || typeof v !== 'object';
      changes.push(
        TEXT_FIELDS.has(k) || !scalar(a) || !scalar(b) ? `${k} changed` : `${k} ${fmt(a)}→${fmt(b)}`,
      );
    }
    if (changes.length) lines.push(`${t.id}: ${changes.join(', ')}`);
  }
  return lines.length ? lines.join('; ') : 'no effective change (formatting or explicit defaults only)';
}

function fmt(v: unknown): string {
  return v === undefined || v === null ? 'none' : String(v);
}
