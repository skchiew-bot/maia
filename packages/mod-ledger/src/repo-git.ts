/**
 * Every git call the ledger makes (§4 evidence rule, §8 phase pins), and none of them on aocd's thread.
 *
 * aocd is the sole writer of the event log and every managed session's PreToolUse hook has about 2.5 s and fails
 * closed, so a slow repository may cost only the one request that asked about it: each call is async and has its own
 * timeout. A call that times out is `timeout`, never an empty answer, so the worst a slow repository can do is leave
 * evidence unverified (with its reason), never silently verified.
 *
 * Two kinds of call:
 * - Plain (`status`, `diff`, `ls-files`, `tag`): aocd's identity and git's own ownership check. On a working copy
 *   another OS user owns (session isolation, G-01) root's git refuses them, and the ledger sees "no fingerprint", as
 *   for a directory that is not a repository. They can start filters, textconv and fsmonitor, so they are never
 *   trusted past that check.
 * - Trusted reads (`HEAD`, "is this commit new?"): one plumbing command each, which may open a working copy another
 *   user owns by naming exactly that path in `-c safe.directory=<repo>` (never `*`), with hooks and fsmonitor off, no
 *   system or user config, no lazy fetch and no transport, so nothing the repository's own config says can start a
 *   process or reach the network.
 */
import { realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GitAsyncResult, GitService } from '@aoc/contracts';
import { workingTreeFingerprintOf, type Logger } from '@aoc/kernel';

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

/** No system or user config, no index refresh, no lazy fetch, no transport: see the file comment. */
const TRUSTED_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '',
};

/** The one place a repository is trusted: exactly its own path. */
function trustedFlags(repo: string): string[] {
  return ['-c', `safe.directory=${repo}`, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'];
}

/** A path git could read as a pattern or a second entry is not trusted. */
const TRUSTABLE_PATH = /^\/[^*\n\0]*$/;

export class RepoGit {
  constructor(
    private readonly git: GitService,
    private readonly timeoutMs: number,
    private readonly log: Logger,
  ) {}

  /**
   * The working copy that contains `dir`, found on the file system rather than by asking git, which refuses a
   * repository another user owns. Its real path, because that is what `safe.directory` is matched against.
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

  /** The commit HEAD names; `ok(null)` for a repository without commits yet. Trusted read. */
  async head(repo: string): Promise<GitRead<string | null>> {
    const r = await this.trusted(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (r.timedOut) return TIMEOUT;
    if (r.code === 0) return ok(r.stdout.trim());
    // --quiet: exit 1 and no output when HEAD names no commit (yet); anything else is git refusing.
    return r.code === 1 ? ok(null) : this.failed('head', r);
  }

  /**
   * Is `sha` a commit in the repository that is not already reachable from `base` (the HEAD at plan declaration)?
   * One `rev-list` answers both questions: it prints the commit when it is new, nothing when it is old, and fails when
   * there is no such commit. Trusted read.
   */
  async commitIsNew(repo: string, ref: string, base: string | null): Promise<GitRead<boolean>> {
    const sha = ref.trim().toLowerCase();
    if (!SHA.test(sha)) return ok(false);
    if (base !== null && !SHA.test(base)) return this.failed('commit', null);
    const r = await this.trusted(repo, [
      'rev-list',
      '-n1',
      `${sha}^{commit}`,
      ...(base ? ['--not', base] : []),
    ]);
    if (r.timedOut) return TIMEOUT;
    if (r.code === 0) return ok(r.stdout.trim().length > 0);
    // No such commit (or an ambiguous prefix): the evidence is refuted, not unknown.
    if (NO_SUCH_COMMIT.test(r.stderr)) return ok(false);
    this.failed('commit', r);
    return ok(false);
  }

  /**
   * HEAD and the working-tree fingerprint, read together. The fingerprint is `ok(null)` when git will not or cannot
   * describe the tree (another user's repository, not a repository): the same as having no working copy. It is never
   * computed from a partial answer.
   */
  async snapshot(
    repo: string,
  ): Promise<{ head: GitRead<string | null>; fingerprint: GitRead<string | null> }> {
    const [head, status, diff] = await Promise.all([
      this.head(repo),
      this.plain(repo, ['status', '--porcelain=v1', '--untracked-files=all']),
      this.plain(repo, ['diff', 'HEAD', '--no-color']),
    ]);
    if (head.status === 'timeout' || status.timedOut || diff.timedOut) return { head, fingerprint: TIMEOUT };
    if (head.status !== 'ok' || status.code !== 0) return { head, fingerprint: ok(null) };
    // Without a commit there is nothing to diff against, as before.
    if (head.value !== null && diff.code !== 0) return { head, fingerprint: ok(null) };
    const fingerprint = workingTreeFingerprintOf({
      head: head.value,
      status: status.stdout,
      diff: head.value === null ? '' : diff.stdout,
    });
    return { head, fingerprint: ok(fingerprint) };
  }

  /** Paths git tracks or would not ignore, to find a test file named relative to a package. */
  async listFiles(repo: string): Promise<GitRead<string[]>> {
    const r = await this.plain(repo, ['ls-files', '--cached', '--others', '--exclude-standard']);
    if (r.timedOut) return TIMEOUT;
    return r.code === 0 ? ok(r.stdout.split('\n')) : FAILED;
  }

  /** The annotated tag that pins a completed phase (§8). */
  async pin(repo: string, name: string, sha: string, message: string): Promise<GitRead<true>> {
    const r = await this.plain(repo, ['tag', '-a', name, sha, '-m', message]);
    if (r.timedOut) return TIMEOUT;
    return r.code === 0 ? ok(true) : this.failed('pin', r);
  }

  private plain(repo: string, args: string[]): Promise<GitAsyncResult> {
    return this.git.runAsync(repo, args, { timeoutMs: this.timeoutMs });
  }

  private trusted(repo: string, args: string[]): Promise<GitAsyncResult> {
    if (!TRUSTABLE_PATH.test(repo)) {
      return Promise.resolve({
        code: 128,
        stdout: '',
        stderr: 'repository path is not trustable',
        timedOut: false,
      });
    }
    return this.git.runAsync(repo, [...trustedFlags(repo), ...args], {
      env: TRUSTED_ENV,
      timeoutMs: this.timeoutMs,
    });
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
