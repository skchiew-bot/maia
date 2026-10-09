import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackupRunDTO } from '@aoc/contracts';
import { createAuditModule } from '@aoc/mod-audit';
import { parseRestoreArgs, runRestoreCommand } from '../src/restore';
import { bootTestServer, removeTempDirs, tempDir } from './helpers';

afterEach(() => removeTempDirs());

function keyFile(dir: string, key: Buffer): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = join(dir, 'key');
  writeFileSync(f, `${key.toString('hex')}\n`, { mode: 0o400 });
  return f;
}

describe('aocd restore', () => {
  it('restores a backup into an empty dir with the escrowed KEK, refuses to overwrite, and says where the KEK must go', async () => {
    const root = tempDir();
    const kek = randomBytes(32);
    const kekFile = keyFile(join(root, 'escrow'), kek);
    const backupKeyFile = keyFile(join(root, 'custody'), randomBytes(32));
    const backupDir = join(root, 'backups');
    const srv = await bootTestServer({
      masterKey: kek,
      modules: [createAuditModule()],
      config: { audit: { anchorProvider: 'none', anchorRepoPath: join(root, 'anchor'), backupDir, backupKeyFile } },
    });
    const res = await srv.request('/api/audit/backup', { method: 'POST', headers: srv.user('approver').headers });
    expect(res.status).toBe(200);
    const run = (await res.json()) as BackupRunDTO;
    await srv.close();

    let out = '';
    let err = '';
    const io = { env: {}, cwd: root, stdout: (s: string) => void (out += s), stderr: (s: string) => void (err += s) };
    const target = join(root, 'restored');
    const args = ['--from', join('backups', run.backup.file), '--backup-key-file', backupKeyFile, '--kek-file', kekFile, '--data-dir', target, '--no-anchors'];
    expect(await runRestoreCommand(args, io)).toBe(0);
    expect(out).toContain(`Restored backup ${run.backup.backupId}`);
    expect(out).toMatch(/chain {4}OK/);
    expect(out).toContain('keys.masterKeyFile is not set');
    expect(readdirSync(target)).toEqual(expect.arrayContaining(['aoc.db', 'bodies.db']));
    expect(readdirSync(target)).not.toContain('master.key');

    expect(await runRestoreCommand(args, io)).toBe(1);
    expect(err).toMatch(/is not empty: restore never overwrites data/);

    // With the KEK where the config says, the report carries no KEK advice.
    const configFile = join(root, 'aoc.config.json');
    writeFileSync(configFile, JSON.stringify({ keys: { masterKeyFile: kekFile } }));
    out = '';
    const second = join(root, 'second');
    expect(
      await runRestoreCommand(['--config', configFile, ...args.slice(0, -3), '--data-dir', second, '--no-anchors', '--json'], io),
    ).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ ok: true, restored: true, headSeq: run.backup.headSeq, kekAdvice: null });

    err = '';
    expect(await runRestoreCommand([...args.slice(0, 4), '--kek-file', backupKeyFile, '--data-dir', join(root, 'third')], io)).toBe(1);
    expect(err).toMatch(/bodies need KEK [0-9a-f]{16}; the supplied KEK is/);
    expect(existsSync(join(root, 'third'))).toBe(false);
  });

  it('requires the backup, the backup key and the KEK as explicit files (exit 2 otherwise)', async () => {
    let err = '';
    const io = { env: {}, cwd: tempDir(), stdout: () => {}, stderr: (s: string) => void (err += s) };
    expect(await runRestoreCommand(['--from', 'b.aocbk', '--backup-key-file', 'k'], io)).toBe(2);
    expect(err).toContain('--kek-file is required');
    expect(() => parseRestoreArgs(['--from', 'b', '--backup-key-file', 'k', '--kek-file', 'x', '--no-anchors', '--anchor-repo', 'r'])).toThrow(
      /choose one of/,
    );
    expect(parseRestoreArgs(['--help'])).toBe('help');
    expect(parseRestoreArgs(['--from=b', '--backup-key-file=k', '--kek-file=x', '--require-anchor'])).toMatchObject({
      from: 'b',
      requireAnchor: true,
      noAnchors: false,
      dataDir: null,
    });
  });
});
