/**
 * Every git call the ledger makes (§4 evidence rule, §8 phase pins), and none of them on aocd's thread.
 *
 * aocd is the sole writer of the event log and every managed session's PreToolUse hook has about 2.5 s and fails
 * closed, so a slow repository may cost only the request that asked about it: each call is async and has its own
 * timeout. A call that times out is `timeout`, never an empty answer, so the worst a slow repository can do is leave
 * evidence unverified (with its reason), never silently verified.
 *
 * How git is started is the kernel's rule (G-04), not the ledger's: no hook, fsmonitor, signing program or transport
 * a repository configures can run, and when aocd is root and a session user owns the working copy (session isolation,
 * G-01) git runs as that owner. So root never parses a repository an agent can write, and git's ownership check
 * passes without `safe.directory`: the ledger never sets it. The two plumbing reads on the evidence path (HEAD, "is
 * this commit new?") additionally drop system and user config, lazy fetch and every transport by environment.
 */
import { realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GitAsyncResult, GitService } from '@aoc/contracts';
import type { Logger } from '@aoc/kernel';

/** `ok`: git answered. `timeout`: it did not, so the answer is unknown. `failed`: it refused or errored. */
export type GitRead<T> = { status: 'ok'; value: T } | { status: 'timeout' } | { status: 'failed' };

const ok = <T>(value: T): GitRead<T> => ({ status: 'ok', value });
const TIMEOUT: GitRead<never> = { status: 'timeout' };
const FAILED: GitRead<never> = { status: 'failed' };

export const valueOr = <T>(r: GitRead<T>, otherwise: T): T => (r.status === 'ok' ? r.value : otherwise);
export const timedOut = (...rs: (GitRead<unknown> | null)[]): boolean =>
  rs.some((r) => r?.status === 'timeout');

const SHA = /^[0-9a-f]{7,64}$/;
/** What git says about a commit that is not there; anything else from a failed read is worth a log line. */
const NO_SUCH_COMMIT =
  /bad object|bad revision|unknown revision|ambiguous argument|not a valid object name|needed a single revision/i;

/** Plumbing reads on the evidence path: no system or user config, no index refresh, no lazy fetch, no transport. */
const READ_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '',
};

export class RepoGit {
  constructor(
    private readonly git: GitService,
    private readonly timeoutMs: number,
    private readonly log: Logger,
  ) {}

  /**
   * The working copy that contains `dir`, found on the file system rather than by asking git (one spawn fewer on
   * every request). Its real path, as git reports it.
   */
  async find(dir: string): Promise<string | null> {
    let cur: string;
    try {
      cur = await realpath(dir);
    } catch {
      return null;
    }
    for (let depth = 0; depth < 64; depth++) {
      try {
        await stat(join(cur, '.git'));
        return cur;
      } catch {
        // not here: keep climbing
      }
      const up = dirname(cur);
      if (up === cur) return null;
      cur = up;
    }
    return null;
  }

  /** The commit HEAD names; `ok(null)` for a repository without commits yet. */
  async head(repo: string): Promise<GitRead<string | null>> {
    const r = await this.read(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (r.timedOut) return TIMEOUT;
    if (r.code === 0) return ok(r.stdout.trim());
    // --quiet: exit 1 and no output when HEAD names no commit (yet); anything else is git refusing.
    return r.code === 1 ? ok(null) : this.failed('head', r);
  }

  /**
   * Is `sha` a commit in the repository that is not already reachable from `base` (the HEAD at plan declaration)?
   * One `rev-list` answers both questions: it prints the commit when it is new, nothing when it is old, and fails when
   * there is no such commit.
   */
  async commitIsNew(repo: string, ref: string, base: string | null): Promise<GitRead<boolean>> {
    const sha = ref.trim().toLowerCase();
    if (!SHA.test(sha)) return ok(false);
    if (base !== null && !SHA.test(base)) return this.failed('commit', null);
    const r = await this.read(repo, ['rev-list', '-n1', `${sha}^{commit}`, ...(base ? ['--not', base] : [])]);
    if (r.timedOut) return TIMEOUT;
    if (r.code === 0) return ok(r.stdout.trim().length > 0);
    // No such commit (or an ambiguous prefix): the evidence is refuted, not unknown.
    if (!NO_SUCH_COMMIT.test(r.stderr)) this.failed('commit', r);
    return ok(false);
  }

  /**
   * HEAD and the working-tree fingerprint, read together. The fingerprint is `ok(null)` when git will not or cannot
   * describe the tree (not a repository, or one it will not read): the same as having no working copy.
   */
  async snapshot(
    repo: string,
  ): Promise<{ head: GitRead<string | null>; fingerprint: GitRead<string | null> }> {
    const [head, tree] = await Promise.all([
      this.head(repo),
      this.git.workingTreeFingerprintAsync(repo, { timeoutMs: this.timeoutMs }),
    ]);
    return { head, fingerprint: tree.timedOut ? TIMEOUT : ok(tree.fingerprint) };
  }

  /** Paths git tracks or would not ignore, to find a test file named relative to a package. */
  async listFiles(repo: string): Promise<GitRead<string[]>> {
    const r = await this.git.runAsync(repo, ['ls-files', '--cached', '--others', '--exclude-standard'], {
      timeoutMs: this.timeoutMs,
    });
    if (r.timedOut) return TIMEOUT;
    return r.code === 0 ? ok(r.stdout.split('\n')) : FAILED;
  }

  /** The annotated tag that pins a completed phase (§8). */
  async pin(repo: string, name: string, sha: string, message: string): Promise<GitRead<true>> {
    const r = await this.git.runAsync(repo, ['tag', '-a', name, sha, '-m', message], {
      timeoutMs: this.timeoutMs,
    });
    if (r.timedOut) return TIMEOUT;
    return r.code === 0 ? ok(true) : this.failed('pin', r);
  }

  private read(repo: string, args: string[]): Promise<GitAsyncResult> {
    return this.git.runAsync(repo, args, { env: READ_ENV, timeoutMs: this.timeoutMs });
  }

  private failed(op: string, r: GitAsyncResult | null): GitRead<never> {
    this.log.warn('git read failed', {
      op,
      code: r?.code ?? null,
      stderr: (r?.stderr ?? '').split('\n')[0]!.slice(0, 200),
    });
    return FAILED;
  }
}
