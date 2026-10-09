import type { Command } from 'commander';
import type { BackupDTO, BackupListDTO, BackupRunDTO } from '@aoc/contracts';
import { objectOf, type CommandContext } from '../context';
import { EXIT } from '../errors';
import { renderKv, renderTable } from '../format';
import { API_PATHS } from '../paths';

function size(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

const copiedLabel = (b: BackupDTO) => (b.copied === null ? 'no copy command' : b.copied ? 'copied off-host' : 'COPY FAILED');

/** Encrypted backups (G-21). Restoring is a host operation with aocd stopped: `aocd restore` (docs/runbooks/backup-restore.md). */
export function registerBackup(program: Command, ctx: CommandContext): void {
  const backup = program
    .command('backup')
    .description('encrypted backups of the event log, bodies and blobs (restore with `aocd restore` on the host)');

  backup
    .command('now')
    .description('take an encrypted backup now (after `aoc anchor`, so it is covered by an anchor)')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const r = objectOf<BackupRunDTO>(await ctx.api(cmd, 30 * 60_000).post(API_PATHS.auditBackup, {}), 'backup', 'result');
      if (r.copyError) ctx.exitCode = EXIT.ERROR;
      if (opts.json) return ctx.json(r);
      const b = r.backup;
      ctx.print(
        renderKv([
          ['Backup', `${b.file} (${size(b.bytes)})`],
          ['SHA-256', b.sha256],
          ['Chain head', `seq ${b.headSeq} (${b.headHash.slice(0, 16)}…)`],
          ['Backup key', b.keyId],
          ['Off-host', r.copyError ? `COPY FAILED — ${r.copyError}` : copiedLabel(b)],
        ]),
      );
    });

  backup
    .command('list')
    .description('list recent backups')
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }, cmd: Command) => {
      const r = objectOf<BackupListDTO>(await ctx.api(cmd).get(API_PATHS.auditBackups), 'backups', 'result');
      if (opts.json) return ctx.json(r);
      if (!r.configured) {
        ctx.print('Backups are off: set audit.backupKeyFile in the aocd config (docs/runbooks/backup-restore.md).');
        return;
      }
      ctx.print(
        `Daily at ${r.atLocalTime}, kept ${r.retentionDays} days, ${r.copyConfigured ? 'copied off-host by backupCopyCommand' : 'no off-host copy command'}`,
      );
      if (!r.backups.length) return ctx.print('No backups yet.');
      ctx.print(
        renderTable(
          [
            { header: 'TAKEN' },
            { header: 'FILE' },
            { header: 'SIZE', align: 'right' },
            { header: 'HEAD', align: 'right' },
            { header: 'OFF-HOST' },
          ],
          r.backups.map((b) => [b.at, b.file, size(b.bytes), b.headSeq, copiedLabel(b)]),
        ),
      );
    });
}
