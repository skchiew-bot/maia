import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackupDTO } from '@aoc/contracts';
import { aoc, loggedInHome, TOKEN } from './helpers/cli';
import { startFakeDaemon, type FakeDaemon } from './helpers/fake-daemon';

let d: FakeDaemon;
let home: string;
beforeEach(async () => {
  d = await startFakeDaemon();
  home = loggedInHome(d.url);
});
afterEach(() => d.stop());

const backup: BackupDTO = {
  backupId: 'bkp_01K0000000000000000ABCDEF1',
  at: '2026-10-09T18:30:05.000Z',
  file: 'aoc-backup-20261009T183005Z-0ABCDEF1.aocbk',
  bytes: 3 * 1024 * 1024,
  sha256: 'a'.repeat(64),
  keyId: '0123456789abcdef',
  headSeq: 4242,
  headHash: 'b'.repeat(64),
  copied: true,
  eventSeq: 4243,
};

describe('aoc backup', () => {
  it('now: POSTs /api/audit/backup and prints the file, its hash and the off-host copy', async () => {
    d.on('POST', '/api/audit/backup', { json: { ok: true, backup, copyError: null } });
    const r = await aoc(['backup', 'now'], { homeDir: home });
    expect(r.code).toBe(0);
    expect(d.calls('POST', '/api/audit/backup')[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(r.stdout).toMatch(/Backup\s+aoc-backup-20261009T183005Z-0ABCDEF1\.aocbk \(3\.0 MiB\)/);
    expect(r.stdout).toMatch(new RegExp(`SHA-256\\s+${'a'.repeat(64)}`));
    expect(r.stdout).toMatch(/Chain head\s+seq 4242/);
    expect(r.stdout).toMatch(/Off-host\s+copied off-host/);
  });

  it('now: a failed off-host copy exits 1; a refusal surfaces the daemon error', async () => {
    d.on('POST', '/api/audit/backup', {
      json: { ok: true, backup: { ...backup, copied: false }, copyError: 'rclone: 403' },
    });
    const failed = await aoc(['backup', 'now'], { homeDir: home });
    expect(failed.code).toBe(1);
    expect(failed.stdout).toMatch(/Off-host\s+COPY FAILED — rclone: 403/);

    d.on('POST', '/api/audit/backup', {
      status: 409,
      json: { error: { code: 'backup_not_configured', message: 'Backups are off until audit.backupKeyFile is configured' } },
    });
    const off = await aoc(['backup', 'now'], { homeDir: home });
    expect(off.code).toBe(1);
    expect(off.stderr).toContain('audit.backupKeyFile');
  });

  it('now: a Builder token is refused with a message that names the Approver token and audit.backup', async () => {
    d.on('POST', '/api/audit/backup', {
      status: 403,
      json: { error: { code: 'forbidden', message: 'Missing permission audit.backup' } },
    });
    const r = await aoc(['backup', 'now'], { homeDir: home });
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('forbidden: Missing permission audit.backup');
    expect(r.stderr).toMatch(/hint: .*Approver token.*audit\.backup/);
    expect(r.stderr).toContain('aoc login --token');
  });

  it('now: the help says the Approver token is required, and list stays open to Builders', async () => {
    const now = await aoc(['backup', 'now', '--help']);
    expect(now.code).toBe(0);
    expect(now.stdout).toMatch(/Approver token/);
    expect(now.stdout).toContain('audit.backup');
    const list = await aoc(['backup', 'list', '--help']);
    expect(list.stdout).not.toMatch(/Approver/);
  });

  it('list: shows the schedule and recent backups, or says backups are off', async () => {
    d.on(
      'GET',
      '/api/audit/backups',
      { json: { configured: false, atLocalTime: '02:30', retentionDays: 35, copyConfigured: false, backups: [] } },
      { json: { configured: true, atLocalTime: '02:30', retentionDays: 35, copyConfigured: true, backups: [backup] } },
    );
    const off = await aoc(['backup', 'list'], { homeDir: home });
    expect(off.code).toBe(0);
    expect(off.stdout).toContain('Backups are off');
    const on = await aoc(['backup', 'list'], { homeDir: home });
    expect(on.stdout).toContain('Daily at 02:30, kept 35 days, copied off-host by backupCopyCommand');
    expect(on.stdout).toMatch(/aoc-backup-20261009T183005Z-0ABCDEF1\.aocbk\s+3\.0 MiB\s+4242\s+copied off-host/);
  });
});
