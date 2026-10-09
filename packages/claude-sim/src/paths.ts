import fs from 'node:fs';
import path from 'node:path';

export type SimEnv = Readonly<Record<string, string | undefined>>;

/** ~/.claude/projects/<slug>/<sessionId>.jsonl — slug = cwd with every non-alphanumeric char replaced by '-'. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** $CLAUDE_CONFIG_DIR, else $HOME/.claude. */
export function claudeConfigDir(env: SimEnv, homeDir: string): string {
  return env.CLAUDE_CONFIG_DIR || `${env.HOME || homeDir}/.claude`;
}

export function projectDirFor(cwd: string, configDir: string): string {
  return `${configDir.replace(/\/+$/, '')}/projects/${projectSlug(cwd)}`;
}

export function transcriptPathFor(cwd: string, sessionId: string, configDir: string): string {
  return `${projectDirFor(cwd, configDir)}/${sessionId}.jsonl`;
}

/** Where the sim keeps its per-session scenario cursor. */
export function simStatePathFor(sessionId: string, configDir: string): string {
  return `${configDir.replace(/\/+$/, '')}/sim-state/${sessionId}.json`;
}

/** True when `target` is `root` or lies inside it (both absolute). */
export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve symlinks for the deepest existing ancestor of `target`, so a not-yet-created file below a symlinked
 * directory is judged by where it would really land.
 */
export function realpathLoose(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/** Current git branch of `cwd` ("" outside a repository), read from .git/HEAD without spawning git. */
export function gitBranchOf(cwd: string): string {
  let dir = cwd;
  for (;;) {
    const dotGit = path.join(dir, '.git');
    try {
      const stat = fs.statSync(dotGit);
      let gitDir = dotGit;
      if (stat.isFile()) {
        const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
        if (!pointer?.[1]) return '';
        gitDir = path.resolve(dir, pointer[1].trim());
      }
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      return ref?.[1] ?? 'HEAD';
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return '';
      dir = parent;
    }
  }
}
