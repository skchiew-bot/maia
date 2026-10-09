import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  ancestor,
  GLOB,
  isWithin,
  pathVariants,
  physicalPath,
  prefixSegments,
  splitAbs,
  under,
} from './paths';

export type ProtectedAreaKind = 'core' | 'audit_store';

export interface ProtectedHit {
  area: ProtectedAreaKind;
  /** Absolute target that matched (lexical or physical spelling). */
  path: string;
  /** Repo-relative for core hits inside the repo, otherwise absolute. */
  display: string;
  /** AOC repo root (core) or the protected audit-store path. */
  root: string;
  pattern: string;
}

export interface BoundaryConfig {
  /** Repo roots that ARE the AOC platform. */
  aocRepoPaths: string[];
  /** Governance/audit/credit core, relative to each AOC repo root. */
  protectedPaths: string[];
  /** Absolute audit state (event DB, anchors, external audit log, keys) — protected for every managed session. */
  auditStorePaths: string[];
}

interface Area {
  kind: ProtectedAreaKind;
  segs: string[];
  root: string;
  pattern: string;
}

const uniq = (xs: string[]) => [...new Set(xs)];

/**
 * Decides whether a write target touches the protected core of an AOC repo or the audit store. Patterns are
 * matched segment-wise on absolute paths, so `..`, symlinks (both spellings are checked), globs in shell targets
 * and ancestors of protected trees (for recursive operations) are all covered.
 */
export class BoundaryMatcher {
  private readonly areas: Area[] = [];
  private readonly roots: { root: string; variants: string[] }[];

  constructor(cfg: BoundaryConfig, baseDir = process.cwd()) {
    this.roots = cfg.aocRepoPaths.map((r) => {
      const abs = resolve(baseDir, r);
      return { root: abs, variants: uniq([abs, physicalPath(abs, '/')]) };
    });
    for (const { root, variants } of this.roots) {
      for (const v of variants) {
        for (const p of cfg.protectedPaths)
          this.areas.push({ kind: 'core', segs: [...splitAbs(v), ...prefixSegments(p)], root, pattern: p });
      }
    }
    for (const s of cfg.auditStorePaths) {
      const abs = resolve(baseDir, s);
      for (const v of uniq([abs, physicalPath(abs, '/')]))
        this.areas.push({ kind: 'audit_store', segs: splitAbs(v), root: abs, pattern: abs });
    }
  }

  /**
   * The AOC repo root that contains `dir` (either spelling), or null. A nested repository inside the AOC tree
   * (e.g. a project workspace under `.aoc/workspaces`) is a different repo.
   */
  repoOf(dir: string): string | null {
    for (const variant of pathVariants(dir, '/')) {
      for (const r of this.roots) {
        const root = r.variants.find((v) => isWithin(variant, v));
        if (!root) continue;
        for (let cur = variant; cur.length > root.length; cur = dirname(cur))
          if (existsSync(join(cur, '.git'))) return null;
        return r.root;
      }
    }
    return null;
  }

  /** `subtree`: the operation affects everything below the target (rm -r, mv, chmod -R…), so ancestors count. */
  check(target: string, cwd: string, subtree: boolean): ProtectedHit | null {
    for (const abs of pathVariants(target, cwd)) {
      const hit = this.checkAbs(abs, subtree);
      if (hit) return hit;
    }
    return this.hardLinkHit(physicalPath(target, cwd));
  }

  /** A hard link elsewhere shares the protected file's inode: writing it modifies the core. Only files with nlink > 1 are searched. */
  private hardLinkHit(abs: string): ProtectedHit | null {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(abs);
    } catch {
      return null;
    }
    if (!st.isFile() || st.nlink < 2) return null;
    let budget = 50_000;
    const walk = (dir: string, a: Area): string | null => {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return null;
      }
      for (const name of entries) {
        if (--budget < 0) return null;
        const p = join(dir, name);
        let e: ReturnType<typeof lstatSync>;
        try {
          e = lstatSync(p);
        } catch {
          continue;
        }
        if (e.isDirectory()) {
          const found = walk(p, a);
          if (found) return found;
        } else if (e.isFile() && e.ino === st.ino && e.dev === st.dev && under(a.segs, splitAbs(p))) return p;
      }
      return null;
    };
    for (const a of this.areas) {
      const literal: string[] = [];
      for (const s of a.segs) {
        if (GLOB.test(s)) break;
        literal.push(s);
      }
      const start = `/${literal.join('/')}`;
      let found: string | null = null;
      try {
        const s0 = lstatSync(start);
        found = s0.isFile() ? (s0.ino === st.ino && s0.dev === st.dev ? start : null) : walk(start, a);
      } catch {
        found = null;
      }
      if (found) return { area: a.kind, path: abs, display: abs, root: a.root, pattern: a.pattern };
    }
    return null;
  }

  private checkAbs(abs: string, subtree: boolean): ProtectedHit | null {
    const t = splitAbs(abs);
    for (const a of this.areas) {
      if (!under(a.segs, t) && !(subtree && ancestor(a.segs, t))) continue;
      const root = a.kind === 'core' ? this.roots.find((r) => r.root === a.root) : undefined;
      const inside = root?.variants.find((v) => isWithin(abs, v));
      const display = inside ? abs.slice(inside.length).replace(/^\/+/, '') || '.' : abs;
      return { area: a.kind, path: abs, display, root: a.root, pattern: a.pattern };
    }
    return null;
  }
}
