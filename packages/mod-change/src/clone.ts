/**
 * The service-owned clone of a project (G-04, threat model O-2 / T-2): a bare repository under AOC's data directory
 * that only aocd writes. Every privileged git step runs here — the provenance trace that gates a promotion, the
 * fast-forward checks, restore commits, pin tags, the promotion push — and rollback verification checks out from
 * here. Commits come in by id from the project repository (where agents work) through upload-pack alone, so nothing
 * an agent planted there — hooks, core.hooksPath, aliases, core.sshCommand, url.*.insteadOf, credential helpers,
 * includes — is read by these commands. Each runs through the kernel's runServiceGit: safety settings first, no
 * system or global config, nothing of aocd's environment.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { runServiceGit, type GitRunResult } from '@aoc/kernel';
import { RepoOpError, commitTreeArgs, output, type CommitSpec, type GitIdentity } from './repo';

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PLAIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** `<root>/<projectId>.git`, or a hash of the id when it is not a plain name. */
export function clonePathFor(root: string, projectId: string): string {
  const name = PLAIN_ID.test(projectId)
    ? projectId
    : `p-${createHash('sha256').update(projectId).digest('hex').slice(0, 32)}`;
  return join(resolve(root), `${name}.git`);
}

/** `path` with symlinks resolved as far as it exists. */
function physical(path: string): string {
  const rest: string[] = [];
  let p = resolve(path);
  while (!existsSync(p) && dirname(p) !== p) {
    rest.unshift(basename(p));
    p = dirname(p);
  }
  return join(realpathSync(p), ...rest);
}

/** True when `inner` is `outer` or below it (symlinks resolved). */
export function isWithin(inner: string, outer: string): boolean {
  const rel = relative(physical(outer), physical(inner));
  return rel === '' || (rel.split(sep)[0] !== '..' && !isAbsolute(rel));
}

/** Where the project repository keeps its files and its git directory: agents write both. */
export interface ProjectRepoLayout {
  top: string;
  gitDir: string;
  objectFormat: string;
}

export class ServiceClone {
  private constructor(
    readonly path: string,
    private readonly timeoutMs: number,
  ) {}

  /**
   * The project's clone, created on first use (an operator may create it beforehand to set its remote). Refused
   * when it would sit inside the project's working tree or git directory.
   */
  static open(root: string, projectId: string, project: ProjectRepoLayout, timeoutMs: number): ServiceClone {
    const path = clonePathFor(root, projectId);
    for (const forbidden of [project.top, project.gitDir])
      if (isWithin(path, forbidden) || isWithin(forbidden, path))
        throw new RepoOpError(
          'clone_inside_project',
          `the service clone ${path} and the project repository (${forbidden}) overlap; keep AOC's data directory outside every project`,
        );
    const clone = new ServiceClone(path, timeoutMs);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const init = runServiceGit(dirname(path), [
        'init',
        '--quiet',
        '--bare',
        '--template=',
        `--object-format=${project.objectFormat}`,
        '--initial-branch=aoc',
        path,
      ]);
      if (init.code !== 0) throw new RepoOpError('clone_unusable', `could not create ${path}: ${output(init)}`);
    }
    if (clone.run(['rev-parse', '--is-bare-repository']).stdout.trim() !== 'true')
      throw new RepoOpError('clone_unusable', `${path} is not a bare git repository`);
    return clone;
  }

  /** git in the clone; --git-dir is explicit, so nothing is discovered. */
  run(args: string[], env?: Record<string, string>): GitRunResult {
    return runServiceGit(this.path, [`--git-dir=${this.path}`, ...args], { env, timeoutMs: this.timeoutMs });
  }

  private must(args: string[], reason: string, env?: Record<string, string>): string {
    const r = this.run(args, env);
    if (r.code !== 0) throw new RepoOpError(reason, `${reason}: ${output(r) || `git exited with ${r.code}`}`);
    return r.stdout.trim();
  }

  hasCommit(sha: string): boolean {
    return FULL_SHA.test(sha) && this.run(['cat-file', '-e', `${sha}^{commit}`]).code === 0;
  }

  /**
   * Copies commit `sha` and what it needs from the project repository, by id: the project's upload-pack serves it,
   * objects are checked on the way in (transfer.fsckObjects), and only the local transport is open.
   */
  fetchCommit(projectRepo: string, sha: string): void {
    if (!FULL_SHA.test(sha)) throw new RepoOpError('commit_unavailable', `${sha} is not a full commit id`);
    if (this.hasCommit(sha)) return;
    const r = this.run([
      '-c',
      'protocol.file.allow=user',
      '-c',
      'transfer.fsckObjects=true',
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-recurse-submodules',
      '--no-write-fetch-head',
      '--',
      resolve(projectRepo),
      sha,
    ]);
    if (r.code !== 0 || !this.hasCommit(sha))
      throw new RepoOpError(
        'commit_unavailable',
        `${sha} could not be copied from ${projectRepo}: ${output(r) || `git exited with ${r.code}`}`,
      );
  }

  revParse(ref: string): string | null {
    const r = this.run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    return this.run(['merge-base', '--is-ancestor', ancestor, descendant]).code === 0;
  }

  treeOf(sha: string): string {
    return this.must(['rev-parse', '--verify', `${sha}^{tree}`], 'rev_parse_failed');
  }

  message(sha: string): string {
    return this.must(['log', '-1', '--format=%B', sha], 'log_failed');
  }

  firstParent(sha: string): string | null {
    const r = this.run(['rev-parse', '--verify', '--quiet', `${sha}^1`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  setRef(ref: string, sha: string): void {
    this.must(['update-ref', ref, sha], 'update_ref_failed');
  }

  deleteRef(ref: string): void {
    this.run(['update-ref', '-d', ref]);
  }

  commit(spec: CommitSpec): string {
    const { args, env } = commitTreeArgs(spec);
    return this.must(args, 'commit_failed', env);
  }

  /** An annotated tag, never signed; tagger is `identity` at `time` (seconds). */
  tag(name: string, sha: string, message: string, identity: GitIdentity, time: number): void {
    this.must(['tag', '--annotate', '--no-sign', '--message', message, '--', name, sha], 'pin_failed', {
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
      GIT_COMMITTER_DATE: `${Math.floor(time)} +0000`,
    });
  }

  /**
   * The protected remote an operator configured for this project, as the aocd user:
   * `git --git-dir=<clone> remote add origin <url>` (pushurl wins over url).
   */
  remoteUrl(): string | null {
    for (const key of ['remote.origin.pushurl', 'remote.origin.url']) {
      const r = this.run(['config', '--get', key]);
      if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
    }
    return null;
  }

  /**
   * A standalone checkout of `sha` in `dir` (new and empty): a repository of its own holding that commit alone
   * (shallow), with no link back to the clone, so whatever runs there cannot reach the clone through `.git`.
   */
  checkoutTo(dir: string, sha: string): void {
    const git = (args: string[], reason: string) => {
      const r = runServiceGit(dir, args, { timeoutMs: this.timeoutMs });
      if (r.code !== 0) throw new RepoOpError(reason, `${reason}: ${output(r) || `git exited with ${r.code}`}`);
    };
    git(['init', '--quiet', '--template=', `--object-format=${this.objectFormat()}`], 'checkout_failed');
    git(
      [
        '-c',
        'protocol.file.allow=user',
        '-c',
        'transfer.fsckObjects=true',
        'fetch',
        '--quiet',
        '--no-tags',
        '--no-recurse-submodules',
        '--depth=1',
        '--',
        this.path,
        sha,
      ],
      'checkout_failed',
    );
    git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', sha], 'checkout_failed');
  }

  private objectFormat(): string {
    return this.run(['rev-parse', '--show-object-format']).stdout.trim() || 'sha1';
  }
}
