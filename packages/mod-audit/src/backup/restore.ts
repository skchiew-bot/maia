import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { blobRelativePath, EventStore, keyFingerprint, silentLogger, systemClock, type Clock } from '@aoc/kernel';
import type { ExternalAnchor } from '../anchor-record';
import { anchorGitEnv, GitAnchorProvider } from '../anchor/git';
import type { AnchorProvider, ExternalListing } from '../anchor/provider';
import { Rfc3161AnchorProvider } from '../anchor/rfc3161';
import { brief, exec } from '../exec';
import { DEFAULT_TSA_MAX_SKEW_MS } from '../options';
import { ArchiveReader, BackupFormatError, SealedReader, type BackupManifest, type BackupManifestFile } from './format';

export interface RestoreOptions {
  /** The `.aocbk` file. */
  file: string;
  /** The backup key, supplied from its own custody. */
  backupKey: Buffer;
  /** The KEK, supplied from escrow (P-03). It is checked against the backup and never written anywhere. */
  kek: Buffer;
  /** Must not exist or be empty: a restore never overwrites data. */
  dataDir: string;
  /**
   * Where the off-host anchors are read from (default: RFC 3161 tokens restored with the backup only); null skips
   * anchors entirely. Without any anchor the chain is checked in-file only, and the report says so.
   */
  anchors?: {
    /** Cloned fresh (read-only) and read instead of gitRepo — the trustworthy source (anchoring runbook §6). */
    gitRemote?: string | null;
    /** A local anchor repository. */
    gitRepo?: string | null;
    /** RFC 3161 tokens; default: the `anchors/` directory restored from the backup. */
    tsrDir?: string | null;
    gpgKeyId?: string;
    gnupgHome?: string;
    tsaCaFile?: string;
    tsaUntrustedFile?: string;
  } | null;
  /** Fail unless at least one off-host anchor covers the restored chain. */
  requireAnchor?: boolean;
  clock?: Clock;
  gitBin?: string;
  opensslBin?: string;
}

export interface RestoreAnchorSummary {
  /** Off-host anchors at or below the restored head, recomputed and compared. */
  checked: number;
  matched: number;
  /** Anchors newer than the backup: the events between the backup head and newestSeq are lost (recovery point). */
  newerThanBackup: number;
  newestSeq: number | null;
  newestAt: string | null;
  sources: string[];
}

export interface RestoreReport {
  ok: boolean;
  /** The target holds the restored data (only when ok). */
  restored: boolean;
  dataDir: string;
  backupId: string;
  createdAt: string;
  chainId: string;
  headSeq: number;
  headHash: string;
  files: number;
  bytes: number;
  chain: { ok: boolean; checked: number; firstBadSeq: number | null };
  kek: { kekId: string; keysUnwrapped: number };
  bodies: { checked: number; verified: number; erased: number; missing: number; tampered: number };
  blobs: { checked: number; decrypted: number; missing: number; skippedAtBackup: number };
  anchors: RestoreAnchorSummary;
  problems: string[];
  warnings: string[];
}

export class RestoreError extends Error {
  constructor(
    readonly code:
      | 'target_not_empty'
      | 'wrong_backup_key'
      | 'wrong_kek'
      | 'not_a_backup'
      | 'corrupt'
      | 'manifest_mismatch',
    message: string,
  ) {
    super(message);
  }
}

async function assertEmptyTarget(dir: string): Promise<boolean> {
  let st;
  try {
    st = await stat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  if (!st.isDirectory()) throw new RestoreError('target_not_empty', `${dir} exists and is not a directory`);
  if ((await readdir(dir)).length)
    throw new RestoreError('target_not_empty', `${dir} is not empty: restore never overwrites data`);
  return true;
}

const sameFiles = (a: BackupManifestFile[], b: BackupManifestFile[]) =>
  a.length === b.length &&
  a.every((f, i) => f.path === b[i]!.path && f.bytes === b[i]!.bytes && f.sha256 === b[i]!.sha256);

/** Decrypt into a sibling staging directory, checking every file against the manifest. */
async function extract(
  file: string,
  backupKey: Buffer,
  staging: string,
): Promise<{ manifest: BackupManifest; files: BackupManifestFile[] }> {
  let reader: ArchiveReader;
  try {
    reader = new ArchiveReader(await SealedReader.open(file, backupKey));
  } catch (err) {
    throw asRestoreError(err);
  }
  try {
    const files: BackupManifestFile[] = [];
    for (;;) {
      const r = await reader.next();
      if (r.t === 'end') {
        if (!(await reader.atEnd())) throw new RestoreError('corrupt', 'data follows the backup manifest');
        if (r.manifest.backupId !== reader.header.backupId || !sameFiles(files, r.manifest.files))
          throw new RestoreError('manifest_mismatch', 'the backup contents do not match its manifest');
        return { manifest: r.manifest, files };
      }
      const dest = join(staging, r.path);
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      const fh = await open(dest, 'wx', 0o600);
      let sha256: string;
      try {
        sha256 = await reader.copyTo(r.size, fh);
        await fh.sync();
      } finally {
        await fh.close();
      }
      files.push({ path: r.path, bytes: r.size, sha256 });
    }
  } catch (err) {
    throw asRestoreError(err);
  } finally {
    await reader.close();
  }
}

function asRestoreError(err: unknown): unknown {
  if (!(err instanceof BackupFormatError)) return err;
  const code = err.code === 'wrong_backup_key' || err.code === 'not_a_backup' ? err.code : 'corrupt';
  return new RestoreError(code, err.message);
}

interface AnchorSource {
  label: string;
  provider: AnchorProvider;
  listing: ExternalListing;
}

async function anchorSources(
  o: RestoreOptions,
  chainId: string,
  staging: string,
  scratch: string,
  warnings: string[],
): Promise<AnchorSource[]> {
  if (o.anchors === null) return [];
  const a = o.anchors ?? {};
  const sources: AnchorSource[] = [];
  let repoPath: string | null = null;
  let label = '';
  if (a.gitRemote) {
    repoPath = join(scratch, 'anchor-clone');
    const r = await exec(o.gitBin ?? 'git', ['clone', '--quiet', '--no-checkout', '--', a.gitRemote, repoPath], {
      env: anchorGitEnv(),
      timeoutMs: 120_000,
    });
    if (r.code !== 0) {
      warnings.push(`the anchor remote could not be cloned: ${brief(r.stderr, 200)}`);
      repoPath = null;
    } else label = 'git (fresh clone of the anchor remote)';
  } else if (a.gitRepo && existsSync(a.gitRepo)) {
    repoPath = resolve(a.gitRepo);
    label = 'git (local anchor repository)';
    warnings.push('git anchors were read from a local repository, not from a fresh clone of the remote');
  }
  if (repoPath) {
    const provider = new GitAnchorProvider({
      repoPath,
      gpgKeyId: a.gpgKeyId,
      gnupgHome: a.gnupgHome,
      gitBin: o.gitBin,
    });
    sources.push({ label, provider, listing: await provider.list(chainId) });
  }
  const tsrDir = a.tsrDir ?? join(staging, 'anchors');
  if (existsSync(tsrDir)) {
    const provider = new Rfc3161AnchorProvider({
      dir: tsrDir,
      tsaUrl: '',
      fetch: () => Promise.reject(new Error('restore never requests timestamps')),
      opensslBin: o.opensslBin,
      caFile: a.tsaCaFile,
      untrustedFile: a.tsaUntrustedFile,
      maxSkewMs: DEFAULT_TSA_MAX_SKEW_MS,
    });
    const listing = await provider.list(chainId);
    if (listing.anchors.length) sources.push({ label: 'rfc3161', provider, listing });
  }
  return sources;
}

/**
 * Restore a backup into an empty data dir (G-21, R6). Everything is decrypted into a sibling staging directory and
 * checked before the target is touched: the manifest, the KEK (it must unwrap every live data key), the whole hash
 * chain, every body against its chained hash, every blob, and the chain against the off-host anchors. Only a backup
 * that passes is moved into place; otherwise the target stays empty. The KEK is never written.
 */
export async function restoreBackup(o: RestoreOptions): Promise<RestoreReport> {
  const dataDir = resolve(o.dataDir);
  const targetExists = await assertEmptyTarget(dataDir);
  await mkdir(dirname(dataDir), { recursive: true });
  const staging = await mkdtemp(join(dirname(dataDir), `.${basename(dataDir)}.restore-`));
  const scratch = await mkdtemp(join(tmpdir(), 'aoc-restore-'));
  let store: EventStore | null = null;
  let moved = false;
  try {
    const { manifest, files } = await extract(o.file, o.backupKey, staging);
    const kekId = keyFingerprint(o.kek, 'kek');
    if (kekId !== manifest.kekId)
      throw new RestoreError(
        'wrong_kek',
        `the backup's bodies need KEK ${manifest.kekId}; the supplied KEK is ${kekId}`,
      );
    for (const f of ['aoc.db', 'bodies.db'])
      if (!files.some((x) => x.path === f)) throw new RestoreError('manifest_mismatch', `the backup holds no ${f}`);

    const problems: string[] = [];
    const warnings: string[] = [];
    store = new EventStore({ dataDir: staging, clock: o.clock ?? systemClock, log: silentLogger, masterKey: o.kek });
    if (store.chainId !== manifest.chainId)
      throw new RestoreError('manifest_mismatch', 'the restored chain id differs from the manifest');
    const keys = store.bodies.checkKeys();
    if (keys.failed.length)
      problems.push(`${keys.failed.length} data key(s) do not unwrap with the supplied KEK (damaged key rows)`);

    // Anchors first: their seqs are what the chain pass must report hashes for.
    const sources = await anchorSources(o, manifest.chainId, staging, scratch, warnings);
    const covered: { source: AnchorSource; anchor: ExternalAnchor }[] = [];
    const newer: ExternalAnchor[] = [];
    for (const s of sources) {
      warnings.push(...s.listing.warnings.map((w) => `${s.label}: ${w}`));
      if (s.listing.foreign)
        warnings.push(`${s.label}: ${s.listing.foreign} anchor(s) belong to a different chain id`);
      for (const x of s.listing.anchors) {
        if (x.record.seq <= manifest.headSeq) covered.push({ source: s, anchor: x });
        else newer.push(x);
      }
    }

    const chain = store.verifyChain({ atSeqs: covered.map((c) => c.anchor.record.seq) });
    if (!chain.ok) problems.push(...chain.problems.map((p) => `in-file chain: ${p}`));
    if (chain.headSeq !== manifest.headSeq || chain.headHash !== manifest.headHash)
      problems.push(`the restored chain head (seq ${chain.headSeq}) differs from the manifest (seq ${manifest.headSeq})`);

    let matched = 0;
    for (const { source, anchor } of covered) {
      const seq = anchor.record.seq;
      if (chain.hashesAt[seq] !== anchor.record.hash) {
        problems.push(`${source.label} anchor seq ${seq}: the restored chain differs from the off-host anchor`);
        continue;
      }
      const proof = await source.provider.proof(anchor, null, source.listing);
      if (!proof.ok) {
        problems.push(...proof.problems.map((p) => `${source.label} anchor seq ${seq}: ${p}`));
        continue;
      }
      warnings.push(...proof.warnings.map((w) => `${source.label} anchor seq ${seq}: ${w}`));
      matched++;
    }
    if (!sources.length)
      warnings.push('no off-host anchor store was available: the chain was checked in-file only (R2)');
    else if (!covered.length) warnings.push('no off-host anchor covers this backup (it predates the first anchor)');
    if (o.requireAnchor && matched === 0) problems.push('no off-host anchor confirms the restored chain');
    const newest = [...newer].sort((x, y) => x.record.seq - y.record.seq).at(-1) ?? null;
    if (newest)
      warnings.push(
        `recovery point: off-host anchors show events up to seq ${newest.record.seq} (${newest.record.anchoredAt}); this backup holds ${manifest.headSeq}`,
      );

    const bodies = { checked: 0, verified: 0, erased: 0, missing: 0, tampered: 0 };
    const rows = store.db.prepare(
      'SELECT seq, id, payload_hash, body_scope FROM events WHERE payload_hash IS NOT NULL AND seq > ? ORDER BY seq LIMIT 2000',
    );
    for (let from = 0; ; ) {
      const batch = rows.all(from) as { seq: number; id: string; payload_hash: string; body_scope: string | null }[];
      if (!batch.length) break;
      for (const r of batch) {
        bodies.checked++;
        let state: boolean | null;
        try {
          state = store.verifyBody({ id: r.id, payloadHash: r.payload_hash });
        } catch {
          state = false;
        }
        if (state === true) bodies.verified++;
        else if (state === false) bodies.tampered++;
        else if (r.body_scope && store.bodies.isErased(r.body_scope)) bodies.erased++;
        else bodies.missing++;
      }
      from = batch.at(-1)!.seq;
    }
    if (bodies.tampered) problems.push(`${bodies.tampered} body(ies) do not match their chained hash or do not decrypt`);
    if (bodies.missing > manifest.bodiesMissing)
      problems.push(`${bodies.missing} body(ies) are missing from the restored body store`);
    else if (bodies.missing) warnings.push(`${bodies.missing} body(ies) were already missing when the backup was taken`);

    const blobs = { checked: 0, decrypted: 0, missing: 0, skippedAtBackup: 0 };
    const skipped = new Set(manifest.skippedBlobs);
    for (const b of store.bodies.db.prepare('SELECT blob_id, scope FROM blobs ORDER BY scope, blob_id').all() as {
      blob_id: string;
      scope: string;
    }[]) {
      blobs.checked++;
      let data: Buffer | null;
      try {
        data = store.bodies.getBlob(b.blob_id);
      } catch {
        problems.push(`blob ${b.blob_id} does not decrypt`);
        continue;
      }
      if (data) blobs.decrypted++;
      else if (skipped.has(`blobs/${blobRelativePath(b.scope, b.blob_id)}`)) blobs.skippedAtBackup++;
      else blobs.missing++;
    }
    if (blobs.missing) problems.push(`${blobs.missing} blob file(s) are missing from the backup`);
    if (blobs.skippedAtBackup)
      warnings.push(`${blobs.skippedAtBackup} blob(s) were being erased when the backup was taken and are not in it`);

    const ok = problems.length === 0;
    store.close();
    store = null;
    if (ok) {
      if (targetExists) await rmdir(dataDir);
      await rename(staging, dataDir);
      await chmod(dataDir, 0o700);
      moved = true;
    }
    return {
      ok,
      restored: moved,
      dataDir,
      backupId: manifest.backupId,
      createdAt: manifest.createdAt,
      chainId: manifest.chainId,
      headSeq: manifest.headSeq,
      headHash: manifest.headHash,
      files: files.length,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
      chain: { ok: chain.ok, checked: chain.checked, firstBadSeq: chain.firstBadSeq },
      kek: { kekId, keysUnwrapped: keys.checked - keys.failed.length },
      bodies,
      blobs,
      anchors: {
        checked: covered.length,
        matched,
        newerThanBackup: newer.length,
        newestSeq: newest?.record.seq ?? null,
        newestAt: newest?.record.anchoredAt ?? null,
        sources: sources.map((s) => s.label),
      },
      problems,
      warnings,
    };
  } finally {
    store?.close();
    if (!moved) await rm(staging, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}
