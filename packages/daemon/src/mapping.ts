import { loadMapping } from '@aoc/mod-evidence';

/**
 * The startup line that says which ISO 42001 mapping this aocd runs with, from the loader the evidence module runs at
 * start on the same file. A missing or rejected file falls back to the built-in default, and the line says so: a
 * relocated aocd must never swap its governed mapping for the built-in one unnoticed.
 */
export function describeMapping(file: string): string {
  const m = loadMapping(file);
  if (m.source === 'config') return `${file} (version ${m.mapping.version})`;
  const builtIn = `built-in default (version ${m.mapping.version})`;
  return m.file === null
    ? `${builtIn}; no file at ${file}`
    : `${builtIn}; ${file} was rejected, see the startup warnings`;
}
