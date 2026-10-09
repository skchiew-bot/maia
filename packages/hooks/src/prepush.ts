/*
 * TypeScript twin of git/pre-push (test/prepush.test.ts keeps them in lockstep), plus helpers to install the git hooks
 * into a managed workspace. Like the script, this is a speed bump: `--no-verify` or another clone skips it. Branch
 * protection and credential isolation are the real wall (AOC-SPEC-003 §2.4, §3, R1).
 */
import { chmodSync, copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AOC_ENV } from '@aoc/contracts';

/** Env read by the git hooks (the commit trailers). No variable unlocks a push: AOC pushes from a service-owned clone. */
export const GIT_HOOK_ENV = {
  sessionId: 'AOC_SESSION_ID',
  changeId: 'AOC_CHANGE_ID',
  ticketId: 'AOC_TICKET_ID',
} as const satisfies Pick<typeof AOC_ENV, 'sessionId' | 'changeId' | 'ticketId'>;

export const PROTECTED_BRANCHES = ['main', 'master', 'production', 'release/*'] as const;

/** Full refs under refs/heads/ and bare branch names are checked; other refs (tags, notes) are not protected. */
export function isProtectedRef(ref: string): boolean {
  const branch = ref.startsWith('refs/heads/')
    ? ref.slice('refs/heads/'.length)
    : ref.startsWith('refs/')
      ? null
      : ref;
  if (!branch) return false;
  return PROTECTED_BRANCHES.some((p) =>
    p.endsWith('/*') ? branch.startsWith(p.slice(0, -1)) : branch === p,
  );
}

/** Evaluates pre-push stdin ("<local ref> <local sha> <remote ref> <remote sha>" per line), deletions included. */
export function evaluatePrePush(stdin: string): { allowed: boolean; protectedRefs: string[] } {
  const protectedRefs = [
    ...new Set(
      stdin
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[2])
        .filter((ref): ref is string => !!ref && isProtectedRef(ref)),
    ),
  ];
  return { allowed: protectedRefs.length === 0, protectedRefs };
}

export const GIT_HOOK_NAMES = ['pre-push', 'prepare-commit-msg'] as const;

/** The directory holding the POSIX sh git hooks (usable as core.hooksPath). A bundled binary must ship it alongside. */
export function gitHooksDir(): string {
  return fileURLToPath(new URL('../git/', import.meta.url));
}

/** Copies the git hooks into `hooksDir` (e.g. <workspace>/.git/hooks), executable; returns the installed paths. */
export function installGitHooks(hooksDir: string): string[] {
  mkdirSync(hooksDir, { recursive: true });
  return GIT_HOOK_NAMES.map((name) => {
    const dest = join(hooksDir, name);
    copyFileSync(join(gitHooksDir(), name), dest);
    chmodSync(dest, 0o755);
    return dest;
  });
}
