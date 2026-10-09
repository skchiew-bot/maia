import { afterEach, describe, expect, it } from 'vitest';
import { AocConfigSchema, type AnchorDTO, type VerifyReportDTO } from '@aoc/contracts';
import { boundaryConfig, BoundaryMatcher, findViolation, type TsaFetch } from '../src';
import { auditRuntime, git, makeGpgKey, makeLocalTsa, nudge, type AuditTest } from './helpers';

type AnchorRes = { ok: true; anchor: AnchorDTO };

let a: AuditTest | null = null;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await a?.t.close();
  a = null;
  for (const c of cleanups.splice(0)) c();
});

const anchor = (x: AuditTest) =>
  x.t.json<AnchorRes>('POST', '/api/audit/anchor', { headers: x.approver.headers });
const verify = (x: AuditTest) =>
  x.t.json<VerifyReportDTO>('GET', '/api/audit/verify', { headers: x.builder.headers });

function twoTsas() {
  const ours = makeLocalTsa();
  const theirs = makeLocalTsa();
  cleanups.push(ours.cleanup, theirs.cleanup);
  let current: TsaFetch = ours.fetch;
  return { ours, theirs, fetch: ((url, init) => current(url, init)) as TsaFetch, use: (f: TsaFetch) => (current = f) };
}

describe('anchor signing and TSA trust come from aocd config (audit.*)', () => {
  it('checks RFC 3161 token signatures against audit.tsaCaFile', async () => {
    const tsa = twoTsas();
    a = await auditRuntime({
      now: Date.now(),
      config: {
        audit: { anchorProvider: 'rfc3161', tsaUrl: 'https://tsa.example.test/tsr', tsaCaFile: tsa.ours.caFile },
      },
      opts: { tsaFetch: tsa.fetch },
    });
    nudge(a.t, 'ses_a', 'x');
    await anchor(a);
    const report = await verify(a);
    expect(report).toMatchObject({ ok: true, problems: [] });
    expect(report.warnings.join('\n')).not.toMatch(/no TSA CA file configured/);

    // A token from a TSA the configured CA does not vouch for is refused.
    tsa.use(tsa.theirs.fetch);
    nudge(a.t, 'ses_a', 'y');
    const refused = await a.t.request('POST', '/api/audit/anchor', { headers: a.approver.headers });
    expect(refused.status).toBe(502);
    expect(((await refused.json()) as { error: { details: { reason: string } } }).error.details.reason).toBe(
      'tsr_verify_failed',
    );
  });

  it('signs anchor commits with audit.gpgKeyId from audit.gnupgHome, and Verify then requires the signature', async (ctx) => {
    const key = makeGpgKey();
    if (!key) ctx.skip();
    cleanups.push(key!.cleanup);
    a = await auditRuntime({ config: { audit: { gpgKeyId: key!.fpr, gnupgHome: key!.home } } });
    nudge(a.t, 'ses_a', 'x');
    expect((await anchor(a)).anchor.signed).toBe(true);
    expect((await verify(a)).anchors[0]).toMatchObject({ signed: true, proofOk: true });

    // Re-committed without the key: the service's own provider (configured from audit.*) rejects it.
    expect(git(a.t.config.audit.anchorRepoPath, ['commit', '--amend', '-q', '--no-edit', '--no-gpg-sign']).code).toBe(0);
    const provider = a.mod.service().git;
    const listing = await provider.list(a.t.rt.store.chainId);
    const proof = await provider.proof(listing.anchors[0]!, null, listing);
    expect(proof.ok).toBe(false);
    expect(proof.problems.join('\n')).toMatch(/is not signed/);
    expect((await verify(a)).ok).toBe(false);
  });

  it('module options override the config (tests, embedding)', async () => {
    const tsa = twoTsas();
    a = await auditRuntime({
      now: Date.now(),
      config: {
        audit: { anchorProvider: 'rfc3161', tsaUrl: 'https://tsa.example.test/tsr', tsaCaFile: tsa.theirs.caFile },
      },
      opts: { tsaFetch: tsa.fetch, tsaCaFile: tsa.ours.caFile },
    });
    nudge(a.t, 'ses_a', 'x');
    expect((await anchor(a)).anchor.provider).toBe('rfc3161');
    expect((await verify(a)).ok).toBe(true);
  });
});

describe('the self-modification boundary covers the configured trust material', () => {
  it('denies agent writes to the anchor keyring and the TSA certificates', () => {
    const config = AocConfigSchema.parse({
      audit: {
        gnupgHome: '/var/lib/aoc/gnupg',
        tsaCaFile: '/etc/aoc/tsa-ca.pem',
        tsaUntrustedFile: '/etc/aoc/tsa-chain.pem',
      },
    });
    const m = new BoundaryMatcher(boundaryConfig(config, '/var/lib/aoc/data'));
    for (const target of ['/var/lib/aoc/gnupg/pubring.kbx', '/etc/aoc/tsa-ca.pem', '/etc/aoc/tsa-chain.pem']) {
      expect(findViolation('Write', { file_path: target }, '/work', m)).toMatchObject({ rule: 'audit_store.edit' });
    }
    expect(findViolation('Bash', { command: 'cp /tmp/evil.pem /etc/aoc/tsa-ca.pem' }, '/work', m)?.rule).toMatch(
      /^audit_store\./,
    );
    expect(findViolation('Write', { file_path: '/etc/aoc/other.pem' }, '/work', m)).toBeNull();
  });
});
