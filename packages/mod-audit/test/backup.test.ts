import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { idKindOf, type AuditHealthDTO, type BackupListDTO, type BackupRunDTO } from '@aoc/contracts';
import { backupFileName, isArchivePath, pruneBackups } from '../src';
import { boot, makeSite, nudge, sha256, SYSTEM, type Booted, type Site } from './backup-helpers';

const sites: Site[] = [];
const runtimes: Booted[] = [];
afterEach(async () => {
  for (const b of runtimes.splice(0)) await b.close().catch(() => undefined);
  for (const s of sites.splice(0)) s.cleanup();
});
async function setup(audit: Record<string, unknown> = {}, o: Parameters<typeof boot>[1] = {}, extra = {}) {
  const s = makeSite({ anchorProvider: 'none', anchorRemote: undefined, ...audit }, extra);
  sites.push(s);
  const b = await boot(s, o);
  runtimes.push(b);
  return { s, b, approver: b.user('approver'), builder: b.user('builder'), requester: b.user('requester') };
}
const backupFiles = (s: Site) => (existsSync(s.backupDir) ? readdirSync(s.backupDir).filter((n) => n.endsWith('.aocbk')) : []);

describe('backup key custody (P-03)', () => {
  const cases: { name: string; prepare(s: Site): Record<string, unknown> | void; reason: string }[] = [
    { name: 'a missing key file', prepare: (s) => ({ backupKeyFile: join(s.custody, 'nope.key') }), reason: 'backup_key_unreadable' },
    {
      name: 'a key readable by other users',
      prepare: (s) => chmodSync(s.backupKeyFile, 0o644),
      reason: 'backup_key_exposed',
    },
    {
      name: 'a key inside the data dir',
      prepare: (s) => {
        mkdirSync(s.dataDir, { recursive: true });
        const f = join(s.dataDir, 'backup.key');
        writeFileSync(f, s.backupKey.toString('hex'), { mode: 0o400 });
        return { backupKeyFile: f };
      },
      reason: 'backup_key_misplaced',
    },
    {
      name: 'a key inside the backup dir',
      prepare: (s) => {
        mkdirSync(s.backupDir, { recursive: true });
        const f = join(s.backupDir, 'backup.key');
        writeFileSync(f, s.backupKey.toString('hex'), { mode: 0o400 });
        return { backupKeyFile: f };
      },
      reason: 'backup_key_misplaced',
    },
    {
      name: 'the KEK itself',
      prepare: (s) => {
        const f = join(s.custody, 'kek-copy.key');
        writeFileSync(f, s.kek.toString('hex'), { mode: 0o400 });
        return { backupKeyFile: f };
      },
      reason: 'backup_key_is_kek',
    },
  ];

  it.each(cases)('refuses $name: backup.failed, a backup.missed alert, and no file written', async ({ prepare, reason }) => {
    const probe = makeSite();
    sites.push(probe);
    const audit = prepare(probe) ?? {};
    const config = {
      ...probe.config,
      audit: { ...probe.config.audit, anchorProvider: 'none' as const, anchorRemote: undefined, ...audit },
    };
    const b = await boot(probe, { config });
    runtimes.push(b);
    const res = await b.request('POST', '/api/audit/backup', b.user('approver').headers);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { details: unknown } }).error.details).toEqual({ stage: 'key', reason });
    const failed = b.rt.store.list({ types: ['backup.failed'] });
    expect(failed.map((e) => e.meta)).toEqual([{ backupId: expect.stringMatching(/^bkp_/), stage: 'key', reason }]);
    expect(b.notes).toContainEqual(
      expect.objectContaining({ kind: 'backup.missed', severity: 'danger', refs: { stage: 'key', reason } }),
    );
    expect(backupFiles(probe)).toEqual([]);
    expect(JSON.stringify(failed[0]!.meta)).not.toContain(probe.root);
  });

  it('refuses a key stored next to the KEK file', async () => {
    const probe = makeSite();
    sites.push(probe);
    const kekFile = join(probe.custody, 'kek');
    writeFileSync(kekFile, probe.kek.toString('hex'), { mode: 0o400 });
    const config = { ...probe.config, keys: { masterKeyFile: kekFile }, audit: { ...probe.config.audit, anchorProvider: 'none' as const, anchorRemote: undefined } };
    const b = await boot(probe, { config });
    runtimes.push(b);
    const r = await b.mod.service().backupNow(SYSTEM, 'system');
    expect(r).toMatchObject({ ok: false, stage: 'key', reason: 'backup_key_misplaced' });
  });
});

describe('the daily backup job', () => {
  it('is not scheduled without audit.backupKeyFile; health says so and the route answers 409', async () => {
    const { b, approver } = await setup({ backupKeyFile: undefined });
    expect(b.rt.modules.flatMap((m) => m.jobs ?? []).map((j) => j.name)).toEqual(['audit.anchor']);
    const res = await b.request('POST', '/api/audit/backup', approver.headers);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('backup_not_configured');
    const health = await b.json<AuditHealthDTO>('GET', '/api/audit/health', approver.headers);
    expect(health.backup).toEqual({ configured: false, last: null, lastFailure: null, stale: false });
    expect(health.warnings).toContain('backup_not_configured');
    expect((await b.json<BackupListDTO>('GET', '/api/audit/backups', approver.headers)).configured).toBe(false);
  });

  it('runs at backupAtLocalTime once per local day, after the anchor job, and health tracks its age', async () => {
    const { s, b, builder } = await setup({}, { now: '2026-10-09T18:10:00.000Z' }); // 02:10 in Kuala Lumpur
    nudge(b, 'ses_a', 'x');
    let health = await b.json<AuditHealthDTO>('GET', '/api/audit/health', builder.headers);
    expect(health.warnings).toContain('backup_never');
    expect(await b.rt.tickJobs()).toEqual(['audit.anchor']);
    b.clock.set('2026-10-09T18:31:00.000Z'); // 02:31
    expect(await b.rt.tickJobs()).toEqual(['audit.backup']);
    expect(await b.rt.tickJobs()).toEqual([]);
    const done = b.rt.store.list({ types: ['backup.completed'] });
    expect(done).toHaveLength(1);
    expect(idKindOf(done[0]!.meta.backupId as string)).toBe('backup'); // the contract's bkp_ prefix
    expect(done[0]!.meta.backupId).toMatch(/^bkp_[0-9A-Z]{26}$/);
    expect(done[0]).toMatchObject({ actor: { kind: 'system', id: 'scheduler:audit' }, source: 'scheduler' });
    expect(backupFiles(s)).toEqual([done[0]!.meta.file]);

    health = await b.json<AuditHealthDTO>('GET', '/api/audit/health', builder.headers);
    expect(health.backup).toMatchObject({
      configured: true,
      stale: false,
      lastFailure: null,
      last: { file: done[0]!.meta.file, ageMs: 0, copied: null },
    });
    expect(health.warnings.filter((w) => w.startsWith('backup_'))).toEqual([]);
    b.clock.advance(27 * 3600_000);
    health = await b.json<AuditHealthDTO>('GET', '/api/audit/health', builder.headers);
    expect(health.backup.stale).toBe(true);
    expect(health.warnings).toContain('backup_stale');

    const list = await b.json<BackupListDTO>('GET', '/api/audit/backups', builder.headers);
    expect(list).toMatchObject({ configured: true, atLocalTime: '02:30', retentionDays: 35, copyConfigured: false });
    expect(list.backups.map((x) => x.backupId)).toEqual([done[0]!.meta.backupId]);
    expect(JSON.stringify(list)).not.toContain(s.root);
  });

  it('keeps backups within the retention period and leaves other files alone', async () => {
    const { s, b } = await setup({ backupRetentionDays: 7 });
    mkdirSync(s.backupDir, { recursive: true });
    const old = backupFileName('2026-09-20T02:30:00.000Z', 'bkp_00000000000000000000OLDAAA');
    const recent = backupFileName('2026-10-05T02:30:00.000Z', 'bkp_00000000000000000000NEWBBB');
    for (const f of [old, recent, 'notes.txt', 'aoc-backup-manual.tar']) writeFileSync(join(s.backupDir, f), 'x');
    const r = await b.mod.service().backupNow(SYSTEM, 'system');
    if (!r.ok) throw new Error(JSON.stringify(r));
    expect(readdirSync(s.backupDir).sort()).toEqual([r.backup.file, 'aoc-backup-manual.tar', 'notes.txt', recent].sort());
    expect(b.rt.store.get(r.backup.eventSeq)!.meta).toMatchObject({ pruned: 1, retained: 2 });
    expect(await pruneBackups(s.backupDir, r.backup.file, 7, Date.parse('2026-11-30T00:00:00Z'))).toEqual({
      pruned: 1,
      retained: 1,
    });
  });

  it('ships each backup with backupCopyCommand (no shell, no AOC secrets in its environment)', async () => {
    const probe = makeSite();
    sites.push(probe);
    const offsite = join(probe.root, 'offsite');
    mkdirSync(offsite);
    const script = join(probe.root, 'copy.cjs');
    writeFileSync(
      script,
      [
        "const fs = require('node:fs'); const path = require('node:path');",
        'const [file, dest] = process.argv.slice(2);',
        'fs.copyFileSync(file, path.join(dest, path.basename(file)));',
        "fs.writeFileSync(path.join(dest, 'env.json'), JSON.stringify(Object.keys(process.env)));",
      ].join('\n'),
    );
    process.env.AOC_TEST_SECRET = 'must-not-leak';
    try {
      const { s, b, approver } = await setup({ backupCopyCommand: [process.execPath, script, '{file}', offsite] });
      const run = await b.json<BackupRunDTO>('POST', '/api/audit/backup', approver.headers);
      expect(run).toMatchObject({ ok: true, copyError: null, backup: { copied: true } });
      expect(sha256(readFileSync(join(offsite, run.backup.file)))).toBe(run.backup.sha256);
      const env = JSON.parse(readFileSync(join(offsite, 'env.json'), 'utf8')) as string[];
      expect(env.filter((k) => k.startsWith('AOC_'))).toEqual([]);
      expect(backupFiles(s)).toEqual([run.backup.file]);
    } finally {
      delete process.env.AOC_TEST_SECRET;
    }
  });

  it('a failing copy keeps the local backup, records copied=false and raises backup.missed', async () => {
    const { b, approver } = await setup({ backupCopyCommand: [process.execPath, '-e', 'process.exit(3)'] });
    const run = await b.json<BackupRunDTO>('POST', '/api/audit/backup', approver.headers);
    expect(run).toMatchObject({ ok: true, backup: { copied: false } });
    expect(run.copyError).toBeTruthy();
    expect(b.rt.store.list({ types: ['backup.failed'] }).map((e) => e.meta)).toEqual([
      { backupId: run.backup.backupId, stage: 'copy', reason: 'copy_failed' },
    ]);
    expect(b.notes).toContainEqual(
      expect.objectContaining({ kind: 'backup.missed', title: 'Backup was not copied off-host' }),
    );
    const health = await b.json<AuditHealthDTO>('GET', '/api/audit/health', approver.headers);
    expect(health.warnings).toEqual(expect.arrayContaining(['backup_failed', 'backup_not_copied']));
  });

  it('on demand: only the Approver (audit.backup) may run one, Builders may list them, and back-to-back runs are refused', async () => {
    const { s, b, approver, builder, requester } = await setup();
    expect((await b.request('POST', '/api/audit/backup')).status).toBe(401);
    expect((await b.request('POST', '/api/audit/backup', requester.headers)).status).toBe(403);
    // A full copy of the audit state is the Approver's call: verify/anchor rights do not carry it.
    const refused = await b.request('POST', '/api/audit/backup', builder.headers);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: { code: 'forbidden', message: 'Missing permission audit.backup' },
    });
    expect(backupFiles(s)).toEqual([]);
    expect((await b.request('GET', '/api/audit/backups', requester.headers)).status).toBe(403);
    expect((await b.request('GET', '/api/audit/backups', builder.headers)).status).toBe(200);

    await b.json<BackupRunDTO>('POST', '/api/audit/backup', approver.headers);
    const again = await b.request('POST', '/api/audit/backup', approver.headers);
    expect(again.status).toBe(429);
    b.clock.advance(11 * 60_000);
    await b.json<BackupRunDTO>('POST', '/api/audit/backup', approver.headers);
  });
});

describe('archive paths', () => {
  it('admits only the databases, blobs, RFC 3161 tokens and evidence packs — never keys or traversal', () => {
    for (const ok of ['aoc.db', 'bodies.db', 'blobs/tkt_1/att_1', 'blobs/~ab12/x', 'anchors/2026-10-09-12.tsr', 'evidence/evp_1.zip'])
      expect(isArchivePath(ok)).toBe(true);
    for (const bad of [
      'master.key',
      'bootstrap-token',
      'aoc.db-wal',
      '../aoc.db',
      'blobs/../../etc/passwd',
      'blobs/a',
      'blobs/a/b/c',
      'anchors/.hidden',
      'evidence/..',
      '/etc/passwd',
      'sessions/ses_1/transcript.jsonl',
    ])
      expect(isArchivePath(bad)).toBe(false);
  });
});
