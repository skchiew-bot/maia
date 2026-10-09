import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackupRunDTO } from '@aoc/contracts';
import { restoreBackup, RestoreError, type RestoreReport } from '../src';
import { boot, makeSite, nudge, sha256, SYSTEM, type Booted, type Site } from './backup-helpers';
import { forgeChain, git } from './helpers';

const sites: Site[] = [];
const runtimes: Booted[] = [];
afterEach(async () => {
  for (const b of runtimes.splice(0)) await b.close().catch(() => undefined);
  for (const s of sites.splice(0)) s.cleanup();
});
function site(...args: Parameters<typeof makeSite>): Site {
  const s = makeSite(...args);
  sites.push(s);
  return s;
}
async function up(s: Site, o: Parameters<typeof boot>[1] = {}): Promise<Booted> {
  const b = await boot(s, o);
  runtimes.push(b);
  return b;
}
async function down(b: Booted): Promise<void> {
  runtimes.splice(runtimes.indexOf(b), 1);
  await b.close();
}

/** What the host held before it was lost: bodies in two scopes (one erased), a blob, an anchor, an unanchored tail. */
async function seedAndBackup(s: Site) {
  const b = await up(s);
  const approver = b.user('approver');
  const keep = nudge(b, 'ses_keep', 'SECRET-keep-me');
  const gone = nudge(b, 'ses_gone', 'SECRET-erase-me');
  b.rt.store.bodies.putBlob('att_1', 'tkt_1', Buffer.from('SECRET-video-bytes'), b.clock.iso());
  b.rt.store.eraseScope('ses_gone', { actor: SYSTEM, reason: 'pdpa_request' });
  const anchored = await b.mod.service().anchorNow(SYSTEM, 'system');
  expect(anchored).toMatchObject({ ok: true, anchor: { pushed: true } });
  nudge(b, 'ses_keep', 'after the anchor');
  const run = await b.json<BackupRunDTO>('POST', '/api/audit/backup', approver.headers);
  return { b, keep, gone, run, file: join(s.backupDir, run.backup.file) };
}

const restore = (s: Site, file: string, over: Partial<Parameters<typeof restoreBackup>[0]> = {}) =>
  restoreBackup({
    file,
    backupKey: s.backupKey,
    kek: s.kek,
    dataDir: s.dataDir,
    anchors: { gitRemote: s.remote },
    requireAnchor: true,
    ...over,
  });

describe('backup → wipe → restore (G-21)', () => {
  it('restores into an empty data dir; the chain verifies in-file and against the off-host anchor, bodies decrypt with the escrowed KEK', async () => {
    const s = site();
    const { b, keep, gone, run, file } = await seedAndBackup(s);
    const bytes = readFileSync(file);
    expect(sha256(bytes)).toBe(run.backup.sha256);
    expect(bytes.length).toBe(run.backup.bytes);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Nothing readable: no payload text, no SQLite page, never the KEK.
    for (const needle of ['SECRET-', 'SQLite format 3', s.kek.toString('hex')]) expect(bytes.includes(needle)).toBe(false);
    expect(bytes.includes(s.kek)).toBe(false);
    expect(existsSync(join(s.dataDir, 'backup-staging'))).toBe(false);
    const recorded = b.rt.store.list({ types: ['backup.completed'] });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.meta).toMatchObject({
      backupId: run.backup.backupId,
      file: run.backup.file,
      sha256: run.backup.sha256,
      headSeq: run.backup.headSeq,
      blobs: 1,
      skippedBlobs: 0,
      bodiesMissing: 0,
      copied: null,
      kekId: b.rt.store.bodies.kekId(),
    });
    await down(b);

    // The host is lost: the data dir (with its generated files) and the local anchor clone are gone.
    rmrf(s.dataDir);
    rmrf(s.config.audit.anchorRepoPath);

    const report = await restore(s, file);
    expect(report).toMatchObject<Partial<RestoreReport>>({
      ok: true,
      restored: true,
      headSeq: run.backup.headSeq,
      headHash: run.backup.headHash,
      problems: [],
    });
    expect(report.chain).toMatchObject({ ok: true, checked: run.backup.headSeq });
    expect(report.anchors).toMatchObject({ checked: 1, matched: 1, newerThanBackup: 0 });
    expect(report.bodies).toMatchObject({ tampered: 0, missing: 0, erased: 1 });
    expect(report.bodies.verified).toBeGreaterThan(1);
    expect(report.blobs).toEqual({ checked: 1, decrypted: 1, missing: 0, skippedAtBackup: 0 });
    expect(readdirSync(s.dataDir)).not.toContain('master.key');
    expect(statSync(s.dataDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(dirname(s.dataDir)).filter((n) => n.includes('.restore-'))).toEqual([]);

    // aocd on the restored data with the escrowed KEK (anchor repo re-cloned from the remote, as the runbook says).
    expect(git(s.root, ['clone', '-q', s.remote, s.config.audit.anchorRepoPath]).code).toBe(0);
    const back = await up(s);
    expect(back.rt.store.head()).toMatchObject({ seq: run.backup.headSeq, hash: run.backup.headHash });
    const verify = await back.rt.services.get('audit').verify();
    expect(verify).toMatchObject({ ok: true, chainOk: true, remoteChecked: true });
    expect(verify.anchors).toEqual([expect.objectContaining({ matched: true, proofOk: true, offHost: true })]);
    expect(back.rt.store.readPayload(keep)).toEqual({ text: 'SECRET-keep-me' });
    expect(back.rt.store.readPayload(gone)).toBeNull();
    expect(back.rt.store.bodies.getBlob('att_1')?.toString()).toBe('SECRET-video-bytes');
    // The restored log keeps growing from the backup head.
    expect(nudge(back, 'ses_keep', 'after the restore').seq).toBe(run.backup.headSeq + 1);
  }, 60_000);

  it('refuses to overwrite data and leaves the target untouched when a key is wrong or the file is damaged', async () => {
    const s = site();
    const { b, file } = await seedAndBackup(s);
    await down(b);

    // The live data dir is still there.
    await expect(restore(s, file)).rejects.toMatchObject({ code: 'target_not_empty' });
    expect(existsSync(join(s.dataDir, 'aoc.db'))).toBe(true);

    const target = join(s.root, 'restored');
    mkdirSync(target);
    const attempt = (over: Partial<Parameters<typeof restoreBackup>[0]>) => restore(s, file, { dataDir: target, ...over });
    await expect(attempt({ backupKey: randomBytes(32) })).rejects.toMatchObject({ code: 'wrong_backup_key' });
    await expect(attempt({ kek: randomBytes(32) })).rejects.toMatchObject({ code: 'wrong_kek' });

    const bytes = readFileSync(file);
    const flipped = Buffer.from(bytes);
    flipped[Math.floor(bytes.length / 2)]! ^= 0x01;
    writeFileSync(join(s.root, 'flipped.aocbk'), flipped);
    await expect(attempt({ file: join(s.root, 'flipped.aocbk') })).rejects.toMatchObject({ code: 'corrupt' });
    writeFileSync(join(s.root, 'short.aocbk'), bytes.subarray(0, bytes.length - 100));
    await expect(attempt({ file: join(s.root, 'short.aocbk') })).rejects.toMatchObject({ code: 'corrupt' });
    writeFileSync(join(s.root, 'other.aocbk'), 'SQLite format 3\0');
    await expect(attempt({ file: join(s.root, 'other.aocbk') })).rejects.toBeInstanceOf(RestoreError);

    expect(readdirSync(target)).toEqual([]);
    expect(readdirSync(s.root).filter((n) => n.includes('.restore-'))).toEqual([]);
    expect((await restore(s, file, { dataDir: target })).ok).toBe(true);
  }, 60_000);

  it('a backup taken while events and bodies are being written is consistent', async () => {
    const s = site({ anchorProvider: 'none', anchorRemote: undefined });
    const b = await up(s);
    b.rt.store.appendMany(
      Array.from({ length: 1000 }, (_, j) => ({
        type: 'session.nudged' as const,
        actor: SYSTEM,
        scope: { sessionId: `ses_${j % 9}` },
        meta: { sessionId: `ses_${j % 9}` },
        payload: { text: `bulk ${j} ${'x'.repeat(200)}` },
        source: 'api' as const,
      })),
    );
    const startHead = b.rt.store.head().seq;
    let writes = 0;
    let writing = true;
    const writer = (async () => {
      while (writing) {
        nudge(b, `ses_${writes % 5}`, `during ${writes}`);
        writes++;
        await new Promise((r) => setImmediate(r));
      }
    })();
    const run = await b.mod.service().backupNow(SYSTEM, 'system');
    writing = false;
    await writer;
    if (!run.ok) throw new Error(JSON.stringify(run));
    expect(writes).toBeGreaterThan(0);
    expect(run.backup.headSeq).toBeGreaterThanOrEqual(startHead);
    expect(run.backup.headSeq).toBeLessThan(b.rt.store.head().seq);
    await down(b);

    const target = join(s.root, 'restored');
    const report = await restore(s, join(s.backupDir, run.backup.file), {
      dataDir: target,
      anchors: {},
      requireAnchor: false,
    });
    expect(report).toMatchObject({ ok: true, headSeq: run.backup.headSeq, problems: [] });
    expect(report.bodies).toMatchObject({ missing: 0, tampered: 0, erased: 0 });
    expect(report.bodies.verified).toBe(report.bodies.checked);
    expect(report.warnings.join('\n')).toMatch(/checked in-file only/);
  }, 60_000);

  it('never installs a backup whose chain disagrees with the off-host anchors, and reports anchors newer than the backup', async () => {
    const s = site();
    const b = await up(s);
    const victim = nudge(b, 'ses_a', 'approved by the CEO');
    nudge(b, 'ses_a', 'more');
    await b.mod.service().anchorNow(SYSTEM, 'system');
    // Clean backup first, then a newer anchor: the restore reports the lost range.
    const clean = await b.mod.service().backupNow(SYSTEM, 'system');
    if (!clean.ok) throw new Error(JSON.stringify(clean));
    nudge(b, 'ses_a', 'after the backup');
    const later = await b.mod.service().anchorNow(SYSTEM, 'system');
    if (!later.ok) throw new Error(JSON.stringify(later));

    // Someone rewrites history in place (anchor.created rows too); a backup taken now carries the forgery.
    forgeChain(s.dataDir, { seq: victim.seq, mutate: (m) => ({ ...m, sessionId: 'ses_forged' }), rewriteAnchorMeta: true });
    b.clock.advance(3600_000);
    const forged = await b.mod.service().backupNow(SYSTEM, 'system');
    if (!forged.ok) throw new Error(JSON.stringify(forged));
    await down(b);

    const bad = await restore(s, join(s.backupDir, forged.backup.file), { dataDir: join(s.root, 'forged') });
    expect(bad.ok).toBe(false);
    expect(bad.restored).toBe(false);
    expect(bad.chain.ok).toBe(true); // the forgery is perfect in-file…
    expect(bad.problems.join('\n')).toMatch(/restored chain differs from the off-host anchor/); // …but not off-host
    expect(existsSync(join(s.root, 'forged'))).toBe(false);

    const good = await restore(s, join(s.backupDir, clean.backup.file), { dataDir: join(s.root, 'clean') });
    expect(good).toMatchObject({ ok: true, restored: true });
    expect(good.anchors).toMatchObject({ matched: 1, newerThanBackup: 1, newestSeq: later.anchor.seq });
    expect(good.warnings.join('\n')).toMatch(new RegExp(`recovery point: .*seq ${later.anchor.seq}`));
  }, 60_000);
});

const rmrf = (p: string) => rmSync(p, { recursive: true, force: true });
