import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aoc, loggedInHome, tempDir, TOKEN } from './helpers/cli';
import { startFakeDaemon, type FakeDaemon } from './helpers/fake-daemon';

let d: FakeDaemon;
let home: string;
beforeEach(async () => {
  d = await startFakeDaemon();
  home = loggedInHome(d.url);
});
afterEach(() => d.stop());

describe('aoc verify', () => {
  const good = {
    ok: true,
    headSeq: 120,
    checked: 120,
    anchorsChecked: 3,
    anchorsMatched: 3,
    firstBadSeq: null,
    problems: [],
  };

  it('passes when the chain recomputes and every anchor matches', async () => {
    d.on('GET', '/api/audit/verify', { json: good });
    const r = await aoc(['verify'], { homeDir: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Chain OK — 120 events recomputed, head seq 120');
    expect(r.stdout).toContain('Anchors: 3/3 external anchors match');
  });

  it('fails (exit 1) on a broken chain or an anchor mismatch', async () => {
    d.on('GET', '/api/audit/verify', {
      json: { ...good, ok: false, firstBadSeq: 57, problems: ['hash mismatch at seq 57'] },
    });
    const broken = await aoc(['verify'], { homeDir: home });
    expect(broken.code).toBe(1);
    expect(broken.stdout).toContain('Chain BROKEN at seq 57');
    expect(broken.stdout).toContain('  - hash mismatch at seq 57');

    d.on('GET', '/api/audit/verify', { json: { ...good, anchorsMatched: 2 } });
    const rewritten = await aoc(['verify'], { homeDir: home });
    expect(rewritten.code).toBe(1);
    expect(rewritten.stdout).toContain('MISMATCH');
  });

  it('warns that an unanchored chain is defeatable (R2)', async () => {
    d.on('GET', '/api/audit/verify', { json: { ...good, anchorsChecked: 0, anchorsMatched: 0 } });
    const r = await aoc(['verify'], { homeDir: home });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('none yet — the in-file chain alone is defeatable (R2)');
  });

  it('--json keeps the failure exit code', async () => {
    d.on('GET', '/api/audit/verify', { json: { ...good, ok: false } });
    const r = await aoc(['verify', '--json'], { homeDir: home });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false });
  });
});

describe('aoc anchor', () => {
  it('POSTs /api/audit/anchor and prints the proof', async () => {
    d.on('POST', '/api/audit/anchor', {
      json: { anchorId: 'anc_1', seq: 120, hash: 'a'.repeat(64), provider: 'git', proofRef: 'commit 1a2b3c' },
    });
    const r = await aoc(['anchor'], { homeDir: home });
    expect(r.code).toBe(0);
    expect(d.calls('POST', '/api/audit/anchor')[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(r.stdout).toMatch(/Anchored\s+head seq 120 \(aaaaaaaaaaaaaaaa…\)/);
    expect(r.stdout).toMatch(/Proof\s+commit 1a2b3c/);
  });
});

describe('aoc evidence', () => {
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('fake zip body')]);
  const sha = createHash('sha256').update(zip).digest('hex');
  const meta = {
    packId: 'evp_1',
    from: '2026-10-01',
    to: '2026-10-08',
    packHash: sha,
    eventCount: 4321,
    mappingVersion: '2026.1',
    mappingStamped: false,
    rateCardVersion: 2,
    chainOk: true,
  };

  it('generates the pack, downloads it, writes it 0600 and checks the hash', async () => {
    d.on('POST', '/api/evidence/packs', { status: 201, json: meta });
    d.on('GET', '/api/evidence/packs/evp_1/download', { body: zip, contentType: 'application/zip' });
    const cwd = tempDir();
    const r = await aoc(['evidence', '--from', '2026-10-01', '--to', '2026-10-08'], { homeDir: home, cwd });
    expect(r.code).toBe(0);
    expect(d.calls('POST', '/api/evidence/packs')[0]!.body).toEqual({ from: '2026-10-01', to: '2026-10-08' });
    expect(d.calls('GET', '/api/evidence/packs/evp_1/download')[0]!.headers.authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    const out = join(cwd, 'aoc-evidence-2026-10-01_2026-10-08.zip');
    expect(readFileSync(out).equals(zip)).toBe(true);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(r.stdout).toContain(`${sha} (matches the pack hash)`);
    expect(r.stdout).toContain('PROVISIONAL (not yet stamped by the compliance lead)');
    expect(r.stdout).toMatch(/Events\s+4321/);
  });

  it('follows a daemon-provided download URL on its own origin and honours --out / --force', async () => {
    d.on('POST', '/api/evidence/packs', { json: { ...meta, downloadUrl: `${d.url}/files/evp_1.zip` } });
    d.on('GET', '/files/evp_1.zip', { body: zip, contentType: 'application/octet-stream' });
    const out = join(tempDir(), 'pack.zip');
    writeFileSync(out, 'old');
    const refused = await aoc(['evidence', '--from', '2026-10-01', '--to', '2026-10-08', '--out', out], {
      homeDir: home,
    });
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('already exists');
    expect(readFileSync(out, 'utf8')).toBe('old');
    const forced = await aoc(
      ['evidence', '--from', '2026-10-01', '--to', '2026-10-08', '--out', out, '--force'],
      { homeDir: home },
    );
    expect(forced.code).toBe(0);
    expect(readFileSync(out).equals(zip)).toBe(true);
  });

  it('never sends the token to a foreign download origin', async () => {
    d.on('POST', '/api/evidence/packs', { json: { ...meta, downloadUrl: 'https://evil.example/pack.zip' } });
    const cwd = tempDir();
    const r = await aoc(['evidence', '--from', '2026-10-01', '--to', '2026-10-08'], { homeDir: home, cwd });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('refusing to send credentials');
    expect(existsSync(join(cwd, 'aoc-evidence-2026-10-01_2026-10-08.zip'))).toBe(false);
  });

  it('accepts a zip returned directly by the POST', async () => {
    d.on('POST', '/api/evidence/packs', { body: zip, contentType: 'application/zip' });
    const cwd = tempDir();
    const r = await aoc(['evidence', '--from', '2026-10-01', '--to', '2026-10-01'], { homeDir: home, cwd });
    expect(r.code).toBe(0);
    expect(existsSync(join(cwd, 'aoc-evidence-2026-10-01_2026-10-01.zip'))).toBe(true);
  });

  // The daemon's EvidencePackJobDTO (packages/mod-evidence/src/index.ts, jobDto).
  const job = (status: string, extra: Record<string, unknown> = {}) => ({
    jobId: 'evj_1',
    status,
    from: '2026-10-01',
    to: '2026-10-08',
    requestedBy: 'usr_1',
    requestedAt: '2026-10-09T10:00:00.000Z',
    position: status === 'queued' ? 1 : 0,
    pack: null,
    error: null,
    statusUrl: '/api/evidence/jobs/evj_1',
    ...extra,
  });

  it('follows a queued pack job until it is built, then downloads the pack (G-56)', async () => {
    d.on('POST', '/api/evidence/packs', { status: 202, json: job('queued') });
    d.on(
      'GET',
      '/api/evidence/jobs/evj_1',
      { json: job('queued') },
      { json: job('running') },
      { json: job('done', { pack: meta }) },
    );
    d.on('GET', '/api/evidence/packs/evp_1/download', { body: zip, contentType: 'application/zip' });
    const cwd = tempDir();
    const r = await aoc(['evidence', '--from', '2026-10-01', '--to', '2026-10-08'], { homeDir: home, cwd });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('queued behind another evidence pack (position 1)');
    expect(d.calls('GET', '/api/evidence/jobs/evj_1')).toHaveLength(3);
    expect(d.calls('GET', '/api/evidence/jobs/evj_1')[0]!.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(readFileSync(join(cwd, 'aoc-evidence-2026-10-01_2026-10-08.zip')).equals(zip)).toBe(true);
    expect(r.stdout).toContain(`${sha} (matches the pack hash)`);
  });

  it('reports a queued pack job that fails and saves nothing', async () => {
    d.on('POST', '/api/evidence/packs', { status: 202, json: job('queued') });
    d.on('GET', '/api/evidence/jobs/evj_1', {
      json: job('failed', { error: 'Evidence pack generation failed (see the aocd log)' }),
    });
    const cwd = tempDir();
    const r = await aoc(['evidence', '--from', '2026-10-01', '--to', '2026-10-08'], { homeDir: home, cwd });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      'evidence pack generation failed: Evidence pack generation failed (see the aocd log)',
    );
    expect(existsSync(join(cwd, 'aoc-evidence-2026-10-01_2026-10-08.zip'))).toBe(false);
  });

  it('gives up on a job still queued after 10 minutes and says how to follow it', async () => {
    d.on('POST', '/api/evidence/packs', { status: 202, json: job('queued') });
    d.on('GET', '/api/evidence/jobs/evj_1', { json: job('running') });
    let t = 0;
    const r = await aoc(['evidence', '--from', '2026-10-01', '--to', '2026-10-08'], {
      homeDir: home,
      cwd: tempDir(),
      now: () => (t += 4 * 60_000),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('still running after 10 minutes');
    expect(r.stderr).toContain('GET /api/evidence/jobs/evj_1');
  });

  // Codes and messages as packages/mod-evidence/src/jobs.ts refuses them.
  it.each([
    [
      'pack_pending',
      'Your previous evidence pack is still being built',
      'wait for your pack being built to finish, then try again in 10 s',
    ],
    ['rate_limited', 'At most 12 evidence packs per user per hour', 'try again in 1800 s'],
    ['queue_full', 'Too many evidence packs are waiting to be built', 'try again in 30 s'],
  ])('names a 429 %s and when to retry', async (code, message, hint) => {
    const retryAfterMs = { pack_pending: 10_000, rate_limited: 1_800_000, queue_full: 30_000 }[code]!;
    d.on('POST', '/api/evidence/packs', {
      status: 429,
      json: { error: { code, message, details: { jobId: 'evj_0', retryAfterMs } } },
    });
    const r = await aoc(['evidence', '--from', '2026-10-01', '--to', '2026-10-08'], {
      homeDir: home,
      cwd: tempDir(),
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`${message} (${code})`);
    expect(r.stderr).toContain(hint);
  });

  it('validates the date range before calling the daemon (exit 2)', async () => {
    expect(
      (await aoc(['evidence', '--from', '2026-13-01', '--to', '2026-10-08'], { homeDir: home })).code,
    ).toBe(2);
    expect(
      (await aoc(['evidence', '--from', '2026-02-30', '--to', '2026-10-08'], { homeDir: home })).code,
    ).toBe(2);
    expect(
      (await aoc(['evidence', '--from', '2026-10-09', '--to', '2026-10-08'], { homeDir: home })).code,
    ).toBe(2);
    expect((await aoc(['evidence', '--from', '2026-10-01'], { homeDir: home })).code).toBe(2);
    expect(d.requests).toHaveLength(0);
  });
});
