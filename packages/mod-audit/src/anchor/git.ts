import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { childEnv } from '@aoc/kernel';
import { parseAnchor, serializeAnchor, type AnchorRecord, type ExternalAnchor } from '../anchor-record';
import { brief, exec, type ExecResult } from '../exec';
import {
  AnchorError,
  emptyListing,
  type AnchorProvider,
  type ChainAnchor,
  type CreatedAnchor,
  type ExternalListing,
  type ProofResult,
} from './provider';

export interface GitAnchorConfig {
  repoPath: string;
  /** Off-host remote (URL or path) that every anchor commit is pushed to. */
  remote?: string;
  gpgKeyId?: string;
  gnupgHome?: string;
  gitBin?: string;
}

const README = `# AOC audit anchors

One commit per anchored head of the AOC event log (AOC-SPEC-003 §13, R2). Each \`anchors/<YYYY-MM-DD>-<seq>.json\`
records \`{chainId, seq, hash, anchoredAt, previousAnchor}\`; Verify recomputes the live chain and compares it with
these files. Push this repository off-host, protect the branch against force-push, and never edit it by hand.
`;

const REMOTE_REF = 'refs/aoc/anchor-remote';

/** What signing and pushing take from aocd's environment, on top of the kernel's child allowlist. */
const SIGN_AND_PUSH_ENV = [
  'GNUPGHOME',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'GIT_ASKPASS',
  'SSH_AUTH_SOCK',
] as const;

/**
 * The environment of every git the anchor code starts (G-46, O-13): the kernel's child allowlist plus the settings
 * that signing and pushing need — GNUPGHOME (`audit.gnupgHome`, else aocd's own) and the ssh / askpass variables the
 * deploy key is wired through — and nothing else of aocd's. AOC_* secrets, API keys, tokens, and variables that
 * would redirect git to another repository (GIT_DIR, GIT_WORK_TREE…) never get through.
 */
export function anchorGitEnv(
  gnupgHome?: string,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const k of SIGN_AND_PUSH_ENV) if (source[k]) forwarded[k] = source[k]!;
  if (gnupgHome) forwarded.GNUPGHOME = gnupgHome;
  return childEnv(source, { ...forwarded, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' });
}

const sameKey = (want: string, fpr: string, primary: string, signer: string) => {
  const id = want.replace(/^0x/i, '');
  if (/^[0-9a-f]{8,40}$/i.test(id))
    return [fpr, primary].some((f) => f.toUpperCase().endsWith(id.toUpperCase()));
  return signer.toLowerCase().includes(want.toLowerCase());
};

function parseBatch(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(0x0a, i);
    if (nl === -1) break;
    const [oid, type, size] = buf.subarray(i, nl).toString('utf8').split(' ');
    if (!oid || type === 'missing' || size === undefined) {
      i = nl + 1;
      continue;
    }
    const n = Number(size);
    out.set(oid, buf.subarray(nl + 1, nl + 1 + n));
    i = nl + 1 + n + 1;
  }
  return out;
}

/**
 * Anchors as commits in a SEPARATE git repository (init on first use), optionally GPG-signed and pushed off-host.
 * Commits use explicit identity/signing settings so the operator's global git config (hooks, ssh signing…) never
 * changes what an anchor is.
 */
export class GitAnchorProvider implements AnchorProvider {
  readonly name = 'git' as const;

  constructor(private readonly cfg: GitAnchorConfig) {}

  private run(args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    return exec(this.cfg.gitBin ?? 'git', ['-c', 'core.hooksPath=/dev/null', ...args], {
      cwd: this.cfg.repoPath,
      env: anchorGitEnv(this.cfg.gnupgHome),
      ...opts,
    });
  }

  private async out(args: string[]): Promise<string | null> {
    const r = await this.run(args);
    return r.code === 0 ? r.stdout.toString('utf8').trim() : null;
  }

  private async blobAt(ref: string, rel: string): Promise<string | null> {
    const r = await this.run(['cat-file', 'blob', `${ref}:${rel}`]);
    return r.code === 0 ? r.stdout.toString('utf8') : null;
  }

  /** The path is the top level of its own repository (not a folder inside some other repo). */
  private async isOwnRepo(): Promise<boolean> {
    if (!existsSync(this.cfg.repoPath)) return false;
    const top = await this.out(['rev-parse', '--show-toplevel']);
    if (!top) return false;
    try {
      return realpathSync(top) === realpathSync(this.cfg.repoPath);
    } catch {
      return false;
    }
  }

  private async commit(message: string, rel: string): Promise<void> {
    const identity = ['-c', 'user.name=AOC Anchor', '-c', 'user.email=aoc-anchor@localhost'];
    const signing = this.cfg.gpgKeyId
      ? [
          '-c',
          'gpg.format=openpgp',
          '-c',
          `user.signingkey=${this.cfg.gpgKeyId}`,
          '-c',
          'commit.gpgsign=true',
        ]
      : ['-c', 'commit.gpgsign=false'];
    const r = await this.run([
      ...identity,
      ...signing,
      'commit',
      '-q',
      ...(this.cfg.gpgKeyId ? ['-S'] : []),
      '-m',
      message,
      '--',
      rel,
    ]);
    if (r.code !== 0)
      throw new AnchorError(this.cfg.gpgKeyId ? 'git_sign_failed' : 'git_commit_failed', brief(r.stderr));
  }

  async ensureRepo(): Promise<void> {
    if (await this.isOwnRepo()) return;
    mkdirSync(this.cfg.repoPath, { recursive: true });
    const init = await this.run(['init', '-q', '-b', 'main', '.']);
    if (init.code !== 0) throw new AnchorError('git_init_failed', brief(init.stderr));
    writeFileSync(join(this.cfg.repoPath, 'README.md'), README);
    const add = await this.run(['add', '--', 'README.md']);
    if (add.code !== 0) throw new AnchorError('git_add_failed', brief(add.stderr));
    await this.commit('AOC anchor repository', 'README.md');
  }

  private branch(): Promise<string | null> {
    return this.out(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  }

  async create(record: AnchorRecord, file: string): Promise<CreatedAnchor> {
    await this.ensureRepo();
    const branch = await this.branch();
    if (!branch) throw new AnchorError('anchor_repo_detached', 'anchor repository HEAD is not on a branch');
    const rel = `anchors/${file}`;
    if ((await this.blobAt('HEAD', rel)) !== null)
      throw new AnchorError('anchor_file_conflict', `${rel} is already committed`);
    mkdirSync(join(this.cfg.repoPath, 'anchors'), { recursive: true });
    writeFileSync(join(this.cfg.repoPath, rel), serializeAnchor(record));
    try {
      const add = await this.run(['add', '--', rel]);
      if (add.code !== 0) throw new AnchorError('git_add_failed', brief(add.stderr));
      await this.commit(`aoc anchor ${record.chainId.slice(0, 12)} seq ${record.seq}`, rel);
    } catch (err) {
      await this.run(['reset', '-q', '--', rel]);
      rmSync(join(this.cfg.repoPath, rel), { force: true });
      throw err;
    }
    const sha = await this.out(['rev-parse', 'HEAD']);
    if (!sha) throw new AnchorError('git_commit_missing', rel);
    let pushed: boolean | undefined;
    let pushError: string | null = null;
    if (this.cfg.remote) {
      const r = await this.run(['push', '--quiet', this.cfg.remote, `HEAD:refs/heads/${branch}`], {
        timeoutMs: 120_000,
      });
      pushed = r.code === 0;
      if (!pushed) pushError = brief(r.stderr) || `exit ${r.code}`;
    }
    return { proofRef: `git:${sha}:${rel}`, signed: !!this.cfg.gpgKeyId, pushed, pushError };
  }

  private async readTree(
    ref: string,
    chainId: string,
  ): Promise<{ anchors: ExternalAnchor[]; foreign: number; problems: string[] }> {
    const res = { anchors: [] as ExternalAnchor[], foreign: 0, problems: [] as string[] };
    const ls = await this.run(['ls-tree', '-r', '-z', '--full-tree', ref, '--', 'anchors/']);
    if (ls.code !== 0) return res;
    const entries = ls.stdout
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        const [, type, oid] = line.slice(0, tab).split(' ');
        return { type, oid: oid ?? '', path: line.slice(tab + 1) };
      })
      .filter((e) => e.type === 'blob' && /^anchors\/[^/]+\.json$/.test(e.path));
    if (!entries.length) return res;
    const blobs = parseBatch(
      (await this.run(['cat-file', '--batch'], { input: `${entries.map((e) => e.oid).join('\n')}\n` }))
        .stdout,
    );
    for (const e of entries) {
      const raw = blobs.get(e.oid)?.toString('utf8') ?? '';
      const record = parseAnchor(raw);
      if (!record) res.problems.push(`git ${e.path}: not a valid anchor record`);
      else if (record.chainId !== chainId) res.foreign++;
      else res.anchors.push({ provider: 'git', file: basename(e.path), raw, record });
    }
    return res;
  }

  async list(chainId: string): Promise<ExternalListing> {
    if (!(await this.isOwnRepo())) return emptyListing();
    const branch = await this.branch();
    const problems: string[] = [];
    const warnings: string[] = [];
    if (!branch) problems.push('git anchor repository HEAD is detached');
    const local = await this.readTree(branch ? `refs/heads/${branch}` : 'HEAD', chainId);
    const anchors = [...local.anchors];
    let foreign = local.foreign;
    let remoteChecked: boolean | null = null;
    let remoteRef: string | null = null;
    if (this.cfg.remote && branch) {
      const ref = `${REMOTE_REF}/${branch}`;
      const fetched = await this.run(
        ['fetch', '--quiet', '--no-tags', this.cfg.remote, `+refs/heads/${branch}:${ref}`],
        { timeoutMs: 120_000 },
      );
      if (fetched.code === 0) {
        remoteChecked = true;
        remoteRef = ref;
        const remote = await this.readTree(ref, chainId);
        foreign = Math.max(foreign, remote.foreign);
        problems.push(...remote.problems.map((p) => `off-host ${p}`));
        for (const r of remote.anchors) {
          const i = anchors.findIndex((a) => a.file === r.file);
          if (i === -1) {
            problems.push(
              `git anchor ${r.file} exists off-host but is missing from the local anchor repository`,
            );
            anchors.push({ ...r, remoteOnly: true });
          } else if (anchors[i]!.raw !== r.raw) {
            problems.push(
              `git anchor ${r.file} differs between the local anchor repository and the off-host remote`,
            );
            anchors[i] = { ...r, remoteOnly: true };
          }
        }
      } else {
        remoteChecked = false;
        warnings.push(
          `anchor remote unreachable — off-host copy not compared (${brief(fetched.stderr, 160)})`,
        );
      }
    }
    return {
      available: true,
      anchors,
      foreign,
      problems: [...local.problems, ...problems],
      warnings,
      remoteChecked,
      branch,
      remoteRef,
    };
  }

  async locate(anchor: ExternalAnchor, listing: ExternalListing): Promise<string | null> {
    const ref = listing.branch ? `refs/heads/${listing.branch}` : 'HEAD';
    const rel = `anchors/${anchor.file}`;
    const sha = await this.out(['log', '-n1', '--diff-filter=A', '--format=%H', ref, '--', rel]);
    return sha ? `git:${sha}:${rel}` : null;
  }

  async proof(
    anchor: ExternalAnchor,
    chain: ChainAnchor | null,
    listing: ExternalListing,
  ): Promise<ProofResult> {
    const problems: string[] = [];
    const warnings: string[] = [];
    const rel = `anchors/${anchor.file}`;
    const branchRef = listing.branch ? `refs/heads/${listing.branch}` : 'HEAD';
    let sha: string | null = null;
    if (chain) {
      const m = /^git:([0-9a-f]{40,64}):(.+)$/.exec(chain.proofRef);
      if (!m) problems.push('anchor.created proofRef is not a git anchor reference');
      else {
        sha = m[1]!;
        if (m[2] !== rel) problems.push(`anchor.created points at ${m[2]}, not ${rel}`);
      }
    }
    sha ??= (await this.locate(anchor, listing))?.split(':')[1] ?? null;
    if (!sha || (await this.run(['cat-file', '-e', `${sha}^{commit}`])).code !== 0) {
      problems.push(
        `anchor commit ${sha ? sha.slice(0, 12) : '(unknown)'} is missing from the local anchor repository`,
      );
      return { ok: false, problems, warnings, signed: null, offHost: null };
    }
    const short = sha.slice(0, 12);
    if ((await this.run(['merge-base', '--is-ancestor', sha, branchRef])).code !== 0) {
      problems.push(
        `anchor commit ${short} is not reachable from ${listing.branch ?? 'HEAD'} (history rewritten?)`,
      );
    }
    const atCommit = await this.blobAt(sha, rel);
    if (atCommit === null) problems.push(`${rel} is not part of anchor commit ${short}`);
    else if (atCommit !== anchor.raw) problems.push(`${rel} was changed after it was anchored`);

    const [status = 'N', fpr = '', primary = '', signer = ''] = (
      (await this.out(['log', '-n1', '--format=%G?%x1f%GF%x1f%GP%x1f%GS', sha])) ?? 'N'
    ).split('\x1f');
    let signed: boolean | null;
    if (status === 'N') {
      signed = false;
      if (this.cfg.gpgKeyId) problems.push(`anchor commit ${short} is not signed`);
    } else if (status === 'G' || status === 'U') {
      signed = true;
      if (this.cfg.gpgKeyId && !sameKey(this.cfg.gpgKeyId, fpr, primary, signer))
        problems.push(`anchor commit ${short} is signed by an unexpected key`);
    } else {
      signed = false;
      const msg = `anchor commit ${short} signature status ${status} (bad, revoked, expired or unverifiable)`;
      if (status === 'B' || status === 'R' || this.cfg.gpgKeyId) problems.push(msg);
      else warnings.push(msg);
    }

    let offHost: boolean | null = null;
    if (listing.remoteRef) {
      offHost = (await this.run(['merge-base', '--is-ancestor', sha, listing.remoteRef])).code === 0;
      if (!offHost && !anchor.remoteOnly) warnings.push(`${rel} has not reached the off-host remote yet`);
    }
    return { ok: problems.length === 0, problems, warnings, signed, offHost };
  }
}
