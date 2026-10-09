import type { LessonScopeType } from '@aoc/contracts';

/** Scope values that would make a lesson global — a growing global rulebook poisons speed and tokens (R10). */
const TOO_BROAD = new Set(['', '.', '*', '**', '**/*', '~']);
const PATH_CHARS = /^[A-Za-z0-9._@+\-/]+$/;
const PROCESS_TYPE = /^[a-z0-9][a-z0-9._:-]{0,79}$/i;

function slashes(p: string): string {
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');
}

/**
 * Repo-relative code area safe for the clear-text chain: absolute paths are made relative to the session cwd
 * (or dropped — they can carry personal data such as a home directory), `..`, odd characters and over-broad
 * areas are rejected.
 */
export function toCodeArea(raw: string | null | undefined, cwd?: string | null): string | null {
  if (!raw) return null;
  let p = slashes(raw);
  if (p.startsWith('/') || /^[a-z]:\//i.test(p)) {
    const base = cwd ? slashes(cwd).replace(/\/+$/, '') : null;
    if (!base || !p.startsWith(`${base}/`)) return null;
    p = p.slice(base.length);
  }
  p = p
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (
    TOO_BROAD.has(p) ||
    p.length > 200 ||
    !PATH_CHARS.test(p) ||
    p.split('/').some((seg) => seg === '..' || seg === '')
  )
    return null;
  return p;
}

/** Directory of a file path as a code area (the area a failing tool call touched). */
export function codeAreaOfFile(filePath: string, cwd?: string | null): string | null {
  const rel = toCodeArea(filePath, cwd);
  if (!rel) return null;
  const i = rel.lastIndexOf('/');
  return i > 0 ? toCodeArea(rel.slice(0, i)) : null;
}

/** Validated, normalised lesson scope value, or null when invalid or effectively global. */
export function normalizeScopeValue(scopeType: LessonScopeType, raw: string): string | null {
  if (scopeType === 'process_type') {
    const v = raw.trim();
    return PROCESS_TYPE.test(v) ? v : null;
  }
  return toCodeArea(raw);
}

/** Is `path` (absolute or relative) inside the repo-relative `area`? Matches on whole path segments. */
export function pathUnder(path: string, area: string): boolean {
  const p = slashes(path).replace(/\/+$/, '');
  const a = slashes(area).replace(/^\/+|\/+$/g, '');
  if (!a) return false;
  return p === a || p.startsWith(`${a}/`) || p.endsWith(`/${a}`) || p.includes(`/${a}/`);
}

/** Two repo-relative areas overlap when one contains the other (a session working in packages/web gets packages/web/src lessons). */
export function areasOverlap(a: string, b: string): boolean {
  const x = slashes(a).replace(/^\/+|\/+$/g, '');
  const y = slashes(b).replace(/^\/+|\/+$/g, '');
  if (!x || !y) return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
}
