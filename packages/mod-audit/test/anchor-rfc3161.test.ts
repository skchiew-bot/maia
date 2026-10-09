import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnchorDTO, VerifyReportDTO } from '@aoc/contracts';
import { sha256hex } from '@aoc/kernel';
import { parseTsReplyText } from '../src';
import { auditRuntime, makeLocalTsa, nudge, openssl, type AuditTest } from './helpers';

type AnchorRes = { ok: true; anchor: AnchorDTO };

let a: AuditTest | null = null;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await a?.t.close();
  a = null;
  for (const c of cleanups.splice(0)) c();
});

const anchor = (x: AuditTest) =>
  x.t.json<AnchorRes>('POST', '/api/audit/anchor', { headers: x.builder.headers });
const verify = (x: AuditTest) =>
  x.t.json<VerifyReportDTO>('GET', '/api/audit/verify', { headers: x.builder.headers });

async function rfcRuntime(o: { ca?: boolean; now?: number } = {}) {
  const tsa = makeLocalTsa();
  cleanups.push(tsa.cleanup);
  a = await auditRuntime({
    now: o.now ?? Date.now(),
    config: { audit: { anchorProvider: 'rfc3161', tsaUrl: 'https://tsa.example.test/tsr' } },
    opts: { tsaFetch: tsa.fetch, ...(o.ca === false ? {} : { tsaCaFile: tsa.caFile }) },
  });
  return { a, tsa, dir: join(a.t.dataDir, 'anchors') };
}

describe('RFC 3161 anchors', () => {
  it('sends a sha256 TimeStampReq (cert requested) to the TSA, stores the token and verifies it with openssl', async () => {
    const { a, tsa, dir } = await rfcRuntime();
    nudge(a.t, 'ses_a', 'x');
    const head = a.t.rt.store.head();
    const res = await anchor(a);
    expect(res.anchor).toMatchObject({ provider: 'rfc3161', seq: head.seq, hash: head.hash, signed: null });

    expect(tsa.calls).toHaveLength(1);
    const call = tsa.calls[0]!;
    expect(call.url).toBe('https://tsa.example.test/tsr');
    expect(call.headers).toMatchObject({
      'content-type': 'application/timestamp-query',
      accept: 'application/timestamp-reply',
    });
    const base = res.anchor.proofRef.replace(/^rfc3161:/, '');
    expect(base).toMatch(/^\d{4}-\d{2}-\d{2}-\d+$/);
    const record = readFileSync(join(dir, `${base}.json`), 'utf8');
    expect(JSON.parse(record)).toMatchObject({
      chainId: a.t.rt.store.chainId,
      seq: head.seq,
      hash: head.hash,
      previousAnchor: null,
    });
    const tmp = mkdtempSync(join(tmpdir(), 'aoc-tsq-'));
    cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
    writeFileSync(join(tmp, 'req.tsq'), call.body);
    const query = openssl(['ts', '-query', '-in', 'req.tsq', '-text'], tmp);
    expect(query).toMatch(/Hash Algorithm: sha256/);
    expect(query).toMatch(/Certificate required: yes/);
    expect(query).toMatch(/Nonce: 0x[0-9A-F]+/);
    expect(parseTsReplyText(query).imprint).toBe(sha256hex(record));
    expect(existsSync(join(dir, `${base}.tsr`))).toBe(true);

    const report = await verify(a);
    expect(report).toMatchObject({ ok: true, chainOk: true, problems: [] });
    expect(report.anchors).toEqual([
      expect.objectContaining({ provider: 'rfc3161', seq: head.seq, matched: true, proofOk: true }),
    ]);

    // The record no longer matches its token once edited (e.g. re-pointed at a forged head).
    writeFileSync(join(dir, `${base}.json`), record.replace(head.hash, 'e'.repeat(64)));
    const bad = await verify(a);
    expect(bad.ok).toBe(false);
    expect(bad.anchors[0]).toMatchObject({ matched: false, proofOk: false });
    expect(bad.problems.join('\n')).toMatch(/does not cover this anchor record/);
    expect(bad.problems.join('\n')).toMatch(/openssl ts -verify failed/);
  });

  it('detects a back-dated record: the TSA time is far from anchoredAt', async () => {
    const { a } = await rfcRuntime({ now: Date.now() - 3 * 3600_000 });
    nudge(a.t, 'ses_a', 'x');
    await anchor(a);
    const report = await verify(a);
    expect(report.ok).toBe(false);
    expect(report.problems.join('\n')).toMatch(/back-dated record/);
  });

  it('without a CA file checks imprint and time only, and says so', async () => {
    const { a, dir } = await rfcRuntime({ ca: false });
    nudge(a.t, 'ses_a', 'x');
    const res = await anchor(a);
    const report = await verify(a);
    expect(report.ok).toBe(true);
    expect(report.warnings.join('\n')).toMatch(/no TSA CA file configured/);
    const tsr = join(dir, `${res.anchor.proofRef.replace(/^rfc3161:/, '')}.tsr`);
    writeFileSync(tsr, Buffer.from('not a token'));
    const bad = await verify(a);
    expect(bad.ok).toBe(false);
    expect(bad.problems.join('\n')).toMatch(/status unreadable/);
  });

  it('records a TSA failure as anchor.failed + anchor.missed and leaves no partial files', async () => {
    const { a, tsa, dir } = await rfcRuntime();
    tsa.fail.status = 503;
    const res = await a.t.request('POST', '/api/audit/anchor', { headers: a.builder.headers });
    expect(res.status).toBe(502);
    expect(a.t.rt.store.list({ types: ['anchor.failed'] }).map((e) => e.meta)).toEqual([
      { provider: 'rfc3161', reason: 'tsa_http_503' },
    ]);
    expect(a.notes).toContainEqual(
      expect.objectContaining({
        kind: 'anchor.missed',
        severity: 'danger',
        refs: { provider: 'rfc3161', reason: 'tsa_http_503' },
      }),
    );
    expect(readdirSync(dir)).toEqual([]);
    expect(
      (await a.t.json<{ warnings: string[] }>('GET', '/api/audit/health', { headers: a.builder.headers }))
        .warnings,
    ).toEqual(expect.arrayContaining(['anchor_never', 'anchor_failed']));
  });

  it('needs an on-disk store (or opts.tsrDir)', async () => {
    const tsa = makeLocalTsa();
    cleanups.push(tsa.cleanup);
    a = await auditRuntime({
      onDisk: false,
      config: { audit: { anchorProvider: 'rfc3161' } },
      opts: { tsaFetch: tsa.fetch },
    });
    const res = await a.t.request('POST', '/api/audit/anchor', { headers: a.builder.headers });
    expect(res.status).toBe(502);
    expect(a.t.rt.store.list({ types: ['anchor.failed'] })[0]!.meta.reason).toBe('no_data_dir');
    expect(tsa.calls).toHaveLength(0);
  });
});

describe('parseTsReplyText', () => {
  it('reads status, digest, imprint and time from `openssl ts -reply -text`', () => {
    const text = [
      'Status info:',
      'Status: Granted.',
      'Status description: unspecified',
      '',
      'TST info:',
      'Version: 1',
      'Hash Algorithm: sha256',
      'Message data:',
      '    0000 - 11 ce 1b cd 76 00 4f 19-3c 6b 23 46 ad 29 38 4e   ....v.O.<k#F.)8N',
      '    0010 - 6f a2 6e a7 7b 3a ae 04-a7 bf c7 bc 0f 03 04 1a   o.n.{:..........',
      'Serial number: 0x02',
      'Time stamp: Oct  9 00:30:23 2026 GMT',
      'Accuracy: 0x01 seconds, unspecified millis, unspecified micros',
    ].join('\n');
    expect(parseTsReplyText(text)).toEqual({
      status: 'Granted',
      hashAlgorithm: 'sha256',
      imprint: '11ce1bcd76004f193c6b2346ad29384e6fa26ea77b3aae04a7bfc7bc0f03041a',
      genTime: '2026-10-09T00:30:23.000Z',
      serial: '0x02',
    });
  });
});
