import { lstatSync, readlinkSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
export const GLOB = /[*?[]/;

/**
 * Physical absolute path the way the kernel resolves it: components are walked left to right, symlinks
 * (including dangling ones — a Write through them creates the target) are followed, and `..` applies to the
 * resolved directory. Components that do not exist yet stay lexical.
 */
export function physicalPath(p: string, cwd: string): string {
  const queue = (isAbsolute(p) ? p : `${cwd}/${p}`).split('/');
  let cur = '/';
  let hops = 0;
  let exists = true;
  while (queue.length) {
    const c = queue.shift()!;
    if (c === '' || c === '.') continue;
    if (c === '..') {
      cur = dirname(cur);
      exists = true;
      continue;
    }
    const next = cur === '/' ? `/${c}` : `${cur}/${c}`;
    if (exists && !GLOB.test(c)) {
      let link: string | null = null;
      try {
        const st = lstatSync(next);
        if (st.isSymbolicLink()) link = readlinkSync(next);
      } catch {
        exists = false;
      }
      if (link !== null && hops++ < 40) {
        if (isAbsolute(link)) cur = '/';
        queue.unshift(...link.split('/'));
        continue;
      }
    } else {
      exists = false;
    }
    cur = next;
  }
  return cur;
}

/** Both spellings of a target: the lexical one (what the agent named) and the physical one (what gets written). */
export function pathVariants(p: string, cwd: string): string[] {
  const lexical = resolve(cwd, p);
  const physical = physicalPath(p, cwd);
  return lexical === physical ? [lexical] : [lexical, physical];
}

const reCache = new Map<string, RegExp>();
function segRe(glob: string): RegExp {
  let re = reCache.get(glob);
  if (!re) {
    let src = '';
    for (let i = 0; i < glob.length; i++) {
      const ch = glob[i]!;
      if (ch === '*') src += '[^/]*';
      else if (ch === '?') src += '[^/]';
      else if (ch === '[') {
        const end = glob.indexOf(']', i + 2);
        if (end === -1) src += '\\[';
        else {
          const body = glob
            .slice(i + 1, end)
            .replace(/^!/, '^')
            .replace(/\\/g, '\\\\');
          src += `[${body}]`;
          i = end;
        }
      } else src += ch.replace(/[.+^${}()|\\\]]/g, '\\$&');
    }
    re = new RegExp(`^${src}$`, CASE_INSENSITIVE_FS ? 'i' : '');
    reCache.set(glob, re);
  }
  return re;
}

function segIntersect(a: string, b: string): boolean {
  const ga = GLOB.test(a);
  const gb = GLOB.test(b);
  if (!ga && !gb) return CASE_INSENSITIVE_FS ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (ga && !gb) return segRe(a).test(b);
  if (!ga && gb) return segRe(b).test(a);
  return true; // two globs may always overlap — be conservative
}

/** Could a path matched by `t` lie at or below a path matched by the protected pattern `p`? */
export function under(p: readonly string[], t: readonly string[]): boolean {
  if (p.length === 0) return true;
  if (p[0] === '**') return under(p.slice(1), t) || (t.length > 0 && under(p, t.slice(1)));
  if (t.length === 0) return false;
  if (t[0] === '**') return true;
  return segIntersect(p[0]!, t[0]!) && under(p.slice(1), t.slice(1));
}

/** Could a path matched by `t` be a strict ancestor of something matched by `p` (rm -rf / mv of a parent)? */
export function ancestor(p: readonly string[], t: readonly string[]): boolean {
  if (t.length === 0) return p.length > 0;
  if (p.length === 0) return false;
  if (p[0] === '**' || t[0] === '**') return true;
  return segIntersect(p[0]!, t[0]!) && ancestor(p.slice(1), t.slice(1));
}

/**
 * Protected prefix → pattern segments. `dir/` protects that directory; a prefix without a trailing slash is a
 * string prefix (`packages/mod-cred` also covers `packages/mod-credits/…`). `*`, `?`, `[…]`, `**` are globs.
 */
export function prefixSegments(prefix: string): string[] {
  const clean = prefix.trim().replace(/^\.?\/+/, '');
  const segs = clean.split('/').filter((s) => s !== '' && s !== '.');
  if (!clean.endsWith('/') && segs.length) {
    const last = segs[segs.length - 1]!;
    if (!last.endsWith('*')) segs[segs.length - 1] = `${last}*`;
  }
  return segs;
}

export function splitAbs(p: string): string[] {
  return p.split('/').filter(Boolean);
}

/** a === b or a is inside directory b (string-wise on absolute, normalised paths). */
export function isWithin(a: string, b: string): boolean {
  const x = CASE_INSENSITIVE_FS ? a.toLowerCase() : a;
  const y = CASE_INSENSITIVE_FS ? b.toLowerCase() : b;
  return x === y || y === '/' || x.startsWith(`${y}/`);
}
