import { readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  BACKUP_FILE_RE,
  newId,
  type Actor,
  type BackupDTO,
  type EventSource,
  type MetaOf,
  type StoredEvent,
} from '@aoc/contracts';
import { blobRelativePath, parseKey, sha256hex, type ModuleContext } from '@aoc/kernel';
import { brief, exec } from '../exec';
import { ArchiveWriter, BACKUP_FORMAT, backupKeyId, isArchivePath, SealedWriter } from './format';
import { takeSnapshot, type SnapshotFacts } from './snapshot';

export type BackupStage = MetaOf<'backup.failed'>['stage'];

export type BackupOutcome =
  | { ok: true; backup: BackupDTO; copyError: string | null }
  | { ok: false; skipped: 'not_configured' | 'no_data_dir' | 'too_recent' }
  | { ok: false; stage: BackupStage; reason: string; detail: string; backupId: string | null };

/** Under the data dir (same trust zone as the live databases) — plaintext copies never touch the backup target. */
export const STAGING_DIR = 'backup-staging';
const COPY_TIMEOUT_MS = 30 * 60_000;
const DAY_MS = 24 * 3600_000;

export class BackupKeyError extends Error {
  constructor(
    readonly reason: 'backup_key_unreadable' | 'backup_key_exposed' | 'backup_key_misplaced' | 'backup_key_is_kek',
    message: string,
  ) {
    super(message);
  }
}

const realOrResolved = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};
const inside = (path: string, dir: string): boolean => {
  const rel = relative(realOrResolved(dir), path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Load the backup key and refuse custody mistakes (P-03): it must be a 32-byte key, not readable by other users,
 * not stored in the data dir, in the backup dir or next to the KEK file, and never the KEK itself.
 */
export function loadBackupKey(
  file: string,
  where: { dataDir: string; backupDir: string; kekFile?: string; isKek(key: Buffer): boolean },
): Buffer {
  let real: string;
  let mode: number;
  try {
    real = realpathSync(file);
    const st = statSync(real);
    if (!st.isFile()) throw new Error('not a regular file');
    mode = st.mode;
  } catch (err) {
    throw new BackupKeyError('backup_key_unreadable', `cannot read the backup key file ${file}: ${String(err)}`);
  }
  if (mode & 0o007)
    throw new BackupKeyError(
      'backup_key_exposed',
      `the backup key file ${file} is accessible to other users (mode ${(mode & 0o777).toString(8)}); use 0400`,
    );
  if (inside(real, where.dataDir))
    throw new BackupKeyError('backup_key_misplaced', `the backup key file ${file} is inside the data dir`);
  if (inside(real, where.backupDir))
    throw new BackupKeyError('backup_key_misplaced', `the backup key file ${file} is inside the backup dir`);
  if (where.kekFile && dirname(real) === dirname(realOrResolved(where.kekFile)))
    throw new BackupKeyError('backup_key_misplaced', `the backup key file ${file} sits next to the KEK file`);
  let key: Buffer;
  try {
    key = parseKey(readFileSync(real, 'utf8'));
  } catch (err) {
    throw new BackupKeyError('backup_key_unreadable', `the backup key file ${file}: ${String(err)}`);
  }
  if (where.isKek(key))
    throw new BackupKeyError('backup_key_is_kek', 'the backup key is the KEK; generate a separate backup key');
  return key;
}

/** `aoc-backup-20261009T023000Z-<last 8 id chars>.aocbk` (UTC). */
export function backupFileName(createdAt: string, backupId: string): string {
  const stamp = createdAt.replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
  return `aoc-backup-${stamp}-${backupId.slice(-8)}.aocbk`;
}

/** Creation time encoded in a backup file name (null for anything else). */
export function backupFileTime(name: string): number | null {
  if (!BACKUP_FILE_RE.test(name)) return null;
  const s = name.slice('aoc-backup-'.length);
  return Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
}

/** Delete backups past retention, never the one just written. Other files in the directory are left alone. */
export async function pruneBackups(
  dir: string,
  keep: string,
  retentionDays: number,
  now: number,
): Promise<{ pruned: number; retained: number }> {
  let pruned = 0;
  let retained = 0;
  for (const name of await readdir(dir)) {
    const t = backupFileTime(name);
    if (t === null) continue;
    if (name !== keep && now - t > retentionDays * DAY_MS) {
      await rm(join(dir, name), { force: true });
      pruned++;
    } else retained++;
  }
  return { pruned, retained };
}

/** Regular files under `<dataDir>/<top>` that may go into an archive (symlinks and anything else are skipped). */
async function packableFiles(dataDir: string, top: 'anchors' | 'evidence'): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(join(dataDir, rel), { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory() && child.split('/').length < 4) await walk(child);
      else if (e.isFile() && isArchivePath(child)) out.push(child);
    }
  };
  await walk(top);
  return out;
}

/** The copy command sees aocd's environment minus AOC's own secrets. */
function copyEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(AOC_|ANTHROPIC_|CLAUDE_CODE_OAUTH)/.test(k)),
  );
}

export function toBackupDTO(e: StoredEvent): BackupDTO {
  const m = e.meta as MetaOf<'backup.completed'>;
  return {
    backupId: m.backupId,
    at: e.ts,
    file: m.file,
    bytes: m.bytes,
    sha256: m.sha256,
    keyId: m.keyId,
    headSeq: m.headSeq,
    headHash: m.headHash,
    copied: m.copied,
    eventSeq: e.seq,
  };
}

/**
 * One backup run (G-21, R6): consistent snapshots of both databases, then aoc.db, bodies.db, the blobs the
 * snapshot references, RFC 3161 tokens and evidence packs packed into one AES-256-GCM `.aocbk` file under a backup
 * key that is never the KEK. The KEK, the bootstrap token and everything else in the data dir are never packed.
 */
export class BackupRunner {
  constructor(private readonly ctx: ModuleContext) {}

  get configured(): boolean {
    return !!this.ctx.config.audit.backupKeyFile && this.ctx.dataDir !== ':memory:';
  }

  private recordFailure(
    actor: Actor,
    source: EventSource,
    backupId: string | null,
    stage: BackupStage,
    reason: string,
    detail: string,
  ): void {
    this.ctx.store.append({
      type: 'backup.failed',
      actor,
      meta: { backupId, stage, reason },
      payload: { detail: detail.slice(0, 2000) },
      bodyScope: 'audit',
      source,
    });
    this.ctx.notify({
      kind: 'backup.missed',
      title: stage === 'copy' ? 'Backup was not copied off-host' : 'Backup failed',
      audience: ['approver', 'builder'],
      severity: 'danger',
      link: '/audit',
      refs: { stage, reason },
    });
    this.ctx.log.error('audit: backup step failed', { stage, reason, backupId });
  }

  async run(actor: Actor, source: EventSource, signal?: AbortSignal): Promise<BackupOutcome> {
    const { ctx } = this;
    const audit = ctx.config.audit;
    if (ctx.dataDir === ':memory:') return { ok: false, skipped: 'no_data_dir' };
    if (!audit.backupKeyFile) return { ok: false, skipped: 'not_configured' };
    const dataDir = resolve(ctx.dataDir);
    const backupDir = resolve(audit.backupDir);
    // Same time-sortable shape as every other id; contracts has no `backup` id kind yet.
    const backupId = `bkp_${newId('event', ctx.clock.now()).slice(4)}`;
    const createdAt = ctx.clock.iso();
    const fail = (stage: BackupStage, reason: string, detail: string): BackupOutcome => {
      this.recordFailure(actor, source, backupId, stage, reason, detail);
      return { ok: false, stage, reason, detail, backupId };
    };

    let key: Buffer;
    try {
      key = loadBackupKey(audit.backupKeyFile, {
        dataDir,
        backupDir,
        kekFile: ctx.config.keys.masterKeyFile,
        isKek: (k) => ctx.store.bodies.isKek(k),
      });
    } catch (err) {
      if (err instanceof BackupKeyError) return fail('key', err.reason, err.message);
      throw err;
    }

    const stagingRoot = join(dataDir, STAGING_DIR);
    const staging = join(stagingRoot, backupId);
    try {
      // A crash mid-run leaves plaintext copies behind: clear them before anything else.
      await rm(stagingRoot, { recursive: true, force: true });
      await mkdir(staging, { recursive: true, mode: 0o700 });
    } catch (err) {
      return fail('snapshot', 'staging_failed', String(err));
    }
    try {
      let facts: SnapshotFacts;
      try {
        facts = await takeSnapshot(
          {
            aocDb: join(dataDir, 'aoc.db'),
            bodiesDb: join(dataDir, 'bodies.db'),
            aocOut: join(staging, 'aoc.db'),
            bodiesOut: join(staging, 'bodies.db'),
          },
          signal,
        );
      } catch (err) {
        return fail('snapshot', signal?.aborted ? 'aborted' : 'snapshot_failed', String(err));
      }
      // The copy must be a prefix of the chain this daemon wrote.
      const headHash = facts.headHash ?? sha256hex(`aoc-genesis:${ctx.store.chainId}`);
      if (
        facts.chainId !== ctx.store.chainId ||
        (facts.headSeq > 0 && ctx.store.get(facts.headSeq)?.hash !== facts.headHash)
      ) {
        return fail('snapshot', 'snapshot_mismatch', `snapshot head ${facts.headSeq} is not part of the live chain`);
      }

      try {
        await mkdir(backupDir, { recursive: true, mode: 0o700 });
        for (const name of await readdir(backupDir))
          if (/^\.aoc-backup-.*\.partial$/.test(name)) await rm(join(backupDir, name), { force: true });
      } catch (err) {
        return fail('package', 'backup_dir_unavailable', String(err));
      }
      const file = backupFileName(createdAt, backupId);
      const partial = join(backupDir, `.${file}.partial`);
      let writer: ArchiveWriter | null = null;
      let sealed: { bytes: number; sha256: string };
      let files = 0;
      const skippedBlobs: string[] = [];
      let blobs = 0;
      let blobBytes = 0;
      try {
        writer = new ArchiveWriter(await SealedWriter.create(partial, key, { backupId, createdAt }));
        await writer.addFile('aoc.db', join(staging, 'aoc.db'), signal);
        await writer.addFile('bodies.db', join(staging, 'bodies.db'), signal);
        for (const b of facts.blobs) {
          const rel = `blobs/${blobRelativePath(b.scope, b.blobId)}`;
          const entry = await writer.addFile(rel, join(dataDir, rel), signal);
          if (!entry) skippedBlobs.push(rel);
          else {
            blobs++;
            blobBytes += entry.bytes;
          }
        }
        for (const top of ['anchors', 'evidence'] as const)
          for (const rel of await packableFiles(dataDir, top)) await writer.addFile(rel, join(dataDir, rel), signal);
        sealed = await writer.end({
          format: BACKUP_FORMAT,
          backupId,
          createdAt,
          chainId: ctx.store.chainId,
          headSeq: facts.headSeq,
          headHash,
          kekId: ctx.store.bodies.kekId(),
          bodies: facts.bodies,
          bodiesMissing: facts.bodiesMissing,
          blobs: facts.blobs.length,
          skippedBlobs,
        });
        files = writer.files.length;
        writer = null;
        await rename(partial, join(backupDir, file));
        await syncDir(backupDir);
      } catch (err) {
        await writer?.abort();
        await rm(partial, { force: true });
        return fail('package', signal?.aborted ? 'aborted' : 'write_failed', String(err));
      }

      let copied: boolean | null = null;
      let copyError: string | null = null;
      if (audit.backupCopyCommand.length) {
        const path = join(backupDir, file);
        const [cmd, ...rest] = audit.backupCopyCommand;
        const args = rest.some((a) => a.includes('{file}'))
          ? rest.map((a) => a.replaceAll('{file}', path))
          : [...rest, path];
        const r = await exec(cmd!, args, { env: copyEnv(), timeoutMs: COPY_TIMEOUT_MS });
        copied = r.code === 0;
        if (!copied) copyError = brief(r.stderr) || `exit ${r.code}`;
      }

      let pruned = 0;
      let retained = 0;
      let pruneError: string | null = null;
      try {
        ({ pruned, retained } = await pruneBackups(backupDir, file, audit.backupRetentionDays, ctx.clock.now()));
      } catch (err) {
        pruneError = String(err);
      }

      const e = ctx.store.append({
        type: 'backup.completed',
        actor,
        meta: {
          backupId,
          file,
          bytes: sealed.bytes,
          sha256: sealed.sha256,
          keyId: backupKeyId(key),
          kekId: ctx.store.bodies.kekId(),
          headSeq: facts.headSeq,
          headHash,
          files,
          aocDbBytes: facts.aocDbBytes,
          bodiesDbBytes: facts.bodiesDbBytes,
          blobs,
          blobBytes,
          skippedBlobs: skippedBlobs.length,
          bodiesMissing: facts.bodiesMissing,
          copied,
          pruned,
          retained,
        },
        source,
      });
      if (copyError !== null) this.recordFailure(actor, source, backupId, 'copy', 'copy_failed', copyError);
      if (pruneError !== null) this.recordFailure(actor, source, backupId, 'prune', 'prune_failed', pruneError);
      return { ok: true, backup: toBackupDTO(e), copyError };
    } finally {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
}

async function syncDir(dir: string): Promise<void> {
  try {
    const fh = await open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    // Directory fsync is not supported everywhere; the file itself was fsynced before the rename.
  }
}
