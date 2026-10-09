import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnchorDTO, Notification, VerifyReportDTO } from '@aoc/contracts';
import { EventStore, silentLogger, type ModuleContext } from '@aoc/kernel';
import { anchorFileName, AuditService } from '../src';
import { GitAnchorProvider } from '../src/anchor/git';
import { auditRuntime, forgeChain, git, makeGpgKey, nudge, type AuditTest } from './helpers';

type AnchorRes = { ok: true; anchor: AnchorDTO; pushError: string | null };

let a: AuditTest | null = null;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await a?.t.close();
  a = null;
  for (const c of cleanups.splice(0)) c();
});

const anchor = (x: AuditTest, expect = 200) =>
  x.t.json<AnchorRes>('POST', '/api/audit/anchor', { headers: x.approver.headers, expect });
const verify = (x: AuditTest) =>
  x.t.json<VerifyReportDTO>('GET', '/api/audit/verify', { headers: x.builder.headers });
const anchorFiles = (repo: string) =>
  git(repo, ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'anchors/']).out.split('\n').filter(Boolean);

/** A ModuleContext over a FRESH EventStore opened on the same files — i.e. the daemon restarted after the forgery. */
function freshService(x: AuditTest, notes: Notification[]): { svc: AuditService; store: EventStore } {
  const store = new EventStore({
    dataDir: x.t.dataDir,
    clock: x.t.clock,
    log: silentLogger,
    masterKey: randomBytes(32),
  });
  const ctx: ModuleContext = {
    config: x.t.config,
    store,
    db: store.db,
    clock: x.t.clock,
    log: silentLogger,
    services: x.t.rt.services,
    dataDir: x.t.dataDir,
    notify: (n) => notes.push(n),
  };
  return { svc: new AuditService(ctx, {}), store };
}

describe('git anchors', () => {
  it('commits each anchor to a separate repo, links anchors, and verifies the chain against them', async () => {
    a = await auditRuntime();
    const { t } = a;
    nudge(t, 'ses_a', 'one');
    nudge(t, 'ses_a', 'two');
    const head = t.rt.store.head();
    const first = await anchor(a);
    expect(first.anchor).toMatchObject({
      provider: 'git',
      seq: head.seq,
      hash: head.hash,
      signed: false,
      pushed: null,
    });

    const repo = t.config.audit.anchorRepoPath;
    expect(git(repo, ['rev-parse', '--show-toplevel']).out).toBe(realpathSync(repo));
    const [file] = anchorFiles(repo);
    expect(file).toBe(`anchors/2026-10-09-${head.seq}.json`);
    const rec = JSON.parse(readFileSync(join(repo, file!), 'utf8'));
    expect(rec).toEqual({
      chainId: t.rt.store.chainId,
      seq: head.seq,
      hash: head.hash,
      anchoredAt: '2026-10-09T02:00:00.000Z',
      previousAnchor: null,
    });
    expect(first.anchor.proofRef).toBe(`git:${git(repo, ['rev-parse', 'HEAD']).out}:${file}`);
    expect(git(repo, ['log', '-1', '--format=%an <%ae>']).out).toBe('AOC Anchor <aoc-anchor@localhost>');

    nudge(t, 'ses_a', 'three');
    t.clock.advance(24 * 3600_000);
    const second = await anchor(a);
    const rec2 = JSON.parse(readFileSync(join(repo, `anchors/2026-10-10-${second.anchor.seq}.json`), 'utf8'));
    expect(rec2.previousAnchor).toEqual({ file: basename(file!), seq: head.seq, hash: head.hash });

    const report = await verify(a);
    expect(report).toMatchObject({
      ok: true,
      chainOk: true,
      firstBadSeq: null,
      problems: [],
      lastAnchorSeq: second.anchor.seq,
      remoteChecked: null,
    });
    expect(report.anchors.map((x) => [x.seq, x.matched, x.proofOk, x.signed])).toEqual([
      [first.anchor.seq, true, true, false],
      [second.anchor.seq, true, true, false],
    ]);
    expect(report.unanchoredTail).toBe(report.headSeq - second.anchor.seq);
    expect(report.warnings).toContain('git anchors are not pushed off-host (audit.anchorRemote is not set)');
    const recorded = t.rt.store.list({ types: ['chain.verified'] }).at(-1)!;
    expect(recorded.meta).toMatchObject({
      ok: true,
      anchorsChecked: 2,
      anchorsMatched: 2,
      firstBadSeq: null,
    });
    expect(report.eventSeq).toBe(recorded.seq);
    expect(t.rt.store.list({ types: ['anchor.created'] })).toHaveLength(2);
  });

  it('R2: a perfect in-file forgery passes verifyChain but fails verify-against-anchor', async () => {
    a = await auditRuntime();
    const { t } = a;
    const victim = nudge(t, 'ses_a', 'approved by the CEO');
    for (let i = 0; i < 3; i++) nudge(t, 'ses_a', `step ${i}`);
    const first = await anchor(a);
    nudge(t, 'ses_b', 'later work');
    const second = await anchor(a);
    expect((await verify(a)).ok).toBe(true);

    forgeChain(t.dataDir, { seq: victim.seq, mutate: (m) => ({ ...m, sessionId: 'ses_forged' }) });
    // The attacker's view: triggers dropped, event rewritten, every later hash recomputed — the file agrees with itself.
    expect(t.rt.store.get(victim.seq)!.meta.sessionId).toBe('ses_forged');
    expect(t.rt.store.verifyChain().ok).toBe(true);
    const restarted = freshService(a, []);
    expect(restarted.store.verifyChain().ok).toBe(true);
    restarted.store.close();

    const report = await verify(a);
    expect(report.chainOk).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.anchors.map((x) => [x.seq, x.matched])).toEqual([
      [first.anchor.seq, false],
      [second.anchor.seq, false],
    ]);
    expect(report.firstBadSeq).toBeLessThanOrEqual(victim.seq);
    expect(report.problems.join('\n')).toMatch(
      /recomputed chain hash at seq \d+ differs from the off-host anchor/,
    );
    expect(t.rt.store.list({ types: ['chain.verified'] }).at(-1)!.meta).toMatchObject({
      ok: false,
      anchorsMatched: 0,
    });
    expect(a.notes.some((n) => n.severity === 'danger' && /verification FAILED/.test(n.title))).toBe(true);
  });

  it('R2: rewriting the anchor.created events as well is caught by the off-host record, and the forged head is never anchored', async () => {
    a = await auditRuntime();
    const { t } = a;
    const victim = nudge(t, 'ses_a', 'original');
    nudge(t, 'ses_a', 'more');
    await anchor(a);
    nudge(t, 'ses_a', 'tail');

    forgeChain(t.dataDir, {
      seq: victim.seq,
      mutate: (m) => ({ ...m, sessionId: 'ses_forged' }),
      rewriteAnchorMeta: true,
    });
    const notes: Notification[] = [];
    const { svc, store } = freshService(a, notes);
    try {
      expect(store.verifyChain().ok).toBe(true);
      const report = await svc.computeVerify();
      expect(report.ok).toBe(false);
      expect(report.anchors[0]).toMatchObject({ matched: false, proofOk: false });
      expect(report.anchors[0]!.problems.join('\n')).toMatch(/different hash than the off-host record/);

      // Anchoring now would launder the rewrite: refused, recorded and alerted.
      const r = await svc.anchorNow({ kind: 'human', id: 'usr_x' }, 'api');
      expect(r).toMatchObject({ ok: false, provider: 'git', reason: 'anchor_mismatch' });
      expect(store.list({ types: ['anchor.failed'] }).at(-1)!.meta).toEqual({
        provider: 'git',
        reason: 'anchor_mismatch',
      });
      expect(notes[0]).toMatchObject({ kind: 'anchor.missed', severity: 'danger' });
      expect(anchorFiles(t.config.audit.anchorRepoPath)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('detects a tampered anchor file: edited and committed, history rewritten, or the repo deleted', async () => {
    a = await auditRuntime();
    const { t } = a;
    nudge(t, 'ses_a', 'x');
    const res = await anchor(a);
    const repo = t.config.audit.anchorRepoPath;
    const [file] = anchorFiles(repo);
    const original = readFileSync(join(repo, file!), 'utf8');

    const rec = JSON.parse(original);
    writeFileSync(join(repo, file!), JSON.stringify({ ...rec, hash: 'f'.repeat(64) }, null, 2) + '\n');
    expect(git(repo, ['commit', '-qam', 'fix anchor']).code).toBe(0);
    let report = await verify(a);
    expect(report.ok).toBe(false);
    expect(report.anchors[0]).toMatchObject({ seq: res.anchor.seq, matched: false, proofOk: false });
    expect(report.anchors[0]!.problems.join('\n')).toMatch(/was changed after it was anchored/);

    // Rewrite history: drop both commits, re-commit a file with the right hash but another anchoredAt.
    expect(git(repo, ['reset', '-q', '--hard', 'HEAD~2']).code).toBe(0);
    mkdirSync(join(repo, 'anchors'), { recursive: true });
    writeFileSync(
      join(repo, file!),
      original.replace('2026-10-09T02:00:00.000Z', '2026-10-01T02:00:00.000Z'),
    );
    git(repo, ['add', '--', file!]);
    expect(git(repo, ['commit', '-qm', 'anchor']).code).toBe(0);
    report = await verify(a);
    expect(report.ok).toBe(false);
    expect(report.anchors[0]).toMatchObject({ matched: true, proofOk: false });
    expect(report.anchors[0]!.problems.join('\n')).toMatch(/not reachable from main/);

    rmSync(repo, { recursive: true, force: true });
    report = await verify(a);
    expect(report.ok).toBe(false);
    expect(report.anchors[0]!.problems).toContain('the git anchor store is unavailable');
  });

  it('re-records an anchor that reached the repo but whose anchor.created append was lost (crash window)', async () => {
    a = await auditRuntime();
    const { t } = a;
    nudge(t, 'ses_a', 'x');
    const head = t.rt.store.head();
    const svc = a.mod.service();
    const record = {
      chainId: t.rt.store.chainId,
      seq: head.seq,
      hash: head.hash,
      anchoredAt: t.clock.iso(),
      previousAnchor: null,
    };
    await svc.git.create(record, anchorFileName(record, t.config.timezone));
    const before = await svc.computeVerify();
    expect(before.ok).toBe(false);
    expect(before.problems.join('\n')).toMatch(
      /no anchor\.created event in the chain records this off-host anchor/,
    );

    const res = await anchor(a);
    expect(res.anchor).toMatchObject({ seq: head.seq, hash: head.hash });
    expect(anchorFiles(t.config.audit.anchorRepoPath)).toHaveLength(1);
    expect((await verify(a)).ok).toBe(true);
  });

  it('flags off-host anchors of a different chain id (the event log was replaced)', async () => {
    a = await auditRuntime();
    const { t } = a;
    await anchor(a);
    const repo = t.config.audit.anchorRepoPath;
    const foreign = {
      chainId: 'f'.repeat(32),
      seq: 1,
      hash: 'a'.repeat(64),
      anchoredAt: '2026-10-01T02:00:00.000Z',
      previousAnchor: null,
    };
    writeFileSync(join(repo, 'anchors', '2026-10-01-1.json'), JSON.stringify(foreign, null, 2) + '\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-qm', 'old chain']);
    const report = await verify(a);
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toMatch(/1 anchor\(s\) of a different chain id/);
  });

  it('pushes anchors off-host and detects a local anchor repo rewritten behind the remote', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'aoc-anchor-remote-'));
    cleanups.push(() => rmSync(remote, { recursive: true, force: true }));
    expect(git(remote, ['init', '-q', '--bare', '-b', 'main']).code).toBe(0);
    a = await auditRuntime({ config: { audit: { anchorRemote: remote } } });
    const { t } = a;
    nudge(t, 'ses_a', 'x');
    const res = await anchor(a);
    expect(res.anchor.pushed).toBe(true);
    const repo = t.config.audit.anchorRepoPath;
    expect(git(remote, ['rev-parse', 'main']).out).toBe(git(repo, ['rev-parse', 'HEAD']).out);

    let report = await verify(a);
    expect(report).toMatchObject({ ok: true, remoteChecked: true });
    expect(report.anchors[0]!.offHost).toBe(true);
    expect(report.warnings).toEqual([]);

    // Someone with push rights rewrites the remote: the chain says the anchor was pushed, so its absence fails.
    const readmeCommit = git(repo, ['rev-parse', 'HEAD~1']).out;
    expect(git(remote, ['update-ref', 'refs/heads/main', readmeCommit]).code).toBe(0);
    report = await verify(a);
    expect(report.ok).toBe(false);
    expect(report.anchors[0]).toMatchObject({ offHost: false, proofOk: false });
    expect(report.problems.join('\n')).toMatch(/pushed off-host but is no longer on the remote/);
    expect(git(remote, ['update-ref', 'refs/heads/main', res.anchor.proofRef.split(':')[1]!]).code).toBe(0);

    // Someone with host access rewrites the local anchor repo: the off-host copy still has the anchor.
    expect(git(repo, ['reset', '-q', '--hard', 'HEAD~1']).code).toBe(0);
    report = await verify(a);
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toMatch(
      /exists off-host but is missing from the local anchor repository/,
    );
  });

  it('records a failed push as anchor.failed + danger notification but keeps the local anchor', async () => {
    a = await auditRuntime({
      config: {
        audit: { anchorRemote: join(tmpdir(), 'aoc-no-such-remote', randomBytes(4).toString('hex')) },
      },
    });
    const { t } = a;
    const res = await anchor(a);
    expect(res.anchor.pushed).toBe(false);
    expect(res.pushError).toBeTruthy();
    expect(t.rt.store.list({ types: ['anchor.failed'] }).map((e) => e.meta)).toEqual([
      { provider: 'git', reason: 'push_failed' },
    ]);
    expect(a.notes).toContainEqual(
      expect.objectContaining({
        kind: 'anchor.missed',
        severity: 'danger',
        refs: { provider: 'git', reason: 'push_failed' },
      }),
    );
    const report = await verify(a);
    expect(report).toMatchObject({ ok: true, remoteChecked: false });
    expect(report.warnings.join('\n')).toMatch(/anchor remote unreachable/);
  });

  it('records an anchoring failure (anchor.failed + anchor.missed) and the route answers 502', async () => {
    const blocker = join(mkdtempSync(join(tmpdir(), 'aoc-blocker-')), 'file');
    writeFileSync(blocker, 'not a directory');
    cleanups.push(() => rmSync(join(blocker, '..'), { recursive: true, force: true }));
    a = await auditRuntime({ config: { audit: { anchorRepoPath: join(blocker, 'repo') } } });
    const { t } = a;
    const res = await t.request('POST', '/api/audit/anchor', { headers: a.approver.headers });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('anchor_failed');
    const failed = t.rt.store.list({ types: ['anchor.failed'] });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.meta.provider).toBe('git');
    expect(t.rt.store.readPayload(failed[0]!)).toMatchObject({ detail: expect.any(String) });
    expect(a.notes).toContainEqual(
      expect.objectContaining({
        kind: 'anchor.missed',
        severity: 'danger',
        audience: ['approver', 'builder'],
      }),
    );
  });

  it('runs the nightly job at anchorAtLocalTime (anchor, then verify) once per local day; retries record one failure', async () => {
    a = await auditRuntime({ now: '2026-10-09T17:00:00.000Z' }); // 01:00 in Kuala Lumpur
    const { t } = a;
    expect(await t.rt.tickJobs()).toEqual([]);
    t.clock.set('2026-10-09T18:05:00.000Z'); // 02:05 local
    expect(await t.rt.tickJobs()).toEqual(['audit.anchor']);
    const created = t.rt.store.list({ types: ['anchor.created'] });
    expect(created).toHaveLength(1);
    expect(created[0]!.actor).toEqual({ kind: 'system', id: 'scheduler:audit' });
    expect(created[0]!.source).toBe('scheduler');
    expect(t.rt.store.list({ types: ['chain.verified'] }).at(-1)!.meta.ok).toBe(true);
    expect(
      t.rt.store.db.prepare("SELECT last_status FROM job_runs WHERE name = 'audit.anchor'").get(),
    ).toEqual({ last_status: 'ok' });
    t.clock.advance(3600_000);
    expect(await t.rt.tickJobs()).toEqual([]);

    rmSync(t.config.audit.anchorRepoPath, { recursive: true, force: true });
    writeFileSync(t.config.audit.anchorRepoPath, 'blocked');
    await t.rt.runJob('audit.anchor');
    expect(t.rt.store.list({ types: ['anchor.failed'] })).toHaveLength(1);
  });
});

describe('anchor signing', () => {
  it('GPG-signs anchor commits and requires a valid signature from the configured key on verify', async (ctx) => {
    const key = makeGpgKey();
    if (!key) ctx.skip();
    cleanups.push(key!.cleanup);
    a = await auditRuntime({ opts: { gpgKeyId: key!.fpr, gnupgHome: key!.home } });
    const { t } = a;
    nudge(t, 'ses_a', 'x');
    const res = await anchor(a);
    expect(res.anchor.signed).toBe(true);
    const repo = t.config.audit.anchorRepoPath;
    const sha = res.anchor.proofRef.split(':')[1]!;
    expect(git(repo, ['cat-file', 'commit', sha]).out).toMatch(/^gpgsig -----BEGIN PGP SIGNATURE-----/m);
    const report = await verify(a);
    expect(report.ok).toBe(true);
    expect(report.anchors[0]).toMatchObject({ signed: true, proofOk: true });

    // An attacker re-committing the anchor without the key: verify (with signing configured) rejects it.
    expect(git(repo, ['commit', '--amend', '-q', '--no-edit', '--no-gpg-sign']).code).toBe(0);
    const provider = new GitAnchorProvider({ repoPath: repo, gpgKeyId: key!.fpr, gnupgHome: key!.home });
    const listing = await provider.list(t.rt.store.chainId);
    const proof = await provider.proof(listing.anchors[0]!, null, listing);
    expect(proof.ok).toBe(false);
    expect(proof.problems.join('\n')).toMatch(/is not signed/);
  });
});
