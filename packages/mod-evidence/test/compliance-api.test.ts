import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AocConfigSchema, MAPPING_PROVISIONAL_BANNER, type ComplianceMappingDTO } from '@aoc/contracts';
import {
  AocRuntime,
  DevIdentityService,
  FakeClock,
  createTestRuntime,
  silentLogger,
  type AocModule,
  type TestRuntime,
} from '@aoc/kernel';
import { BUILTIN_MAPPING, builtinMapping, createEvidenceModule, type MappingFile } from '../src';

const missingFile = join(tmpdir(), 'no-such-dir-aoc', 'iso42001-mapping.json');

describe('compliance mapping API', () => {
  let t: TestRuntime;
  afterEach(async () => {
    await t?.close();
  });

  it('serves the provisional mapping with its banner to audit viewers only', async () => {
    t = await createTestRuntime({ modules: [createEvidenceModule({ mappingFile: missingFile })] });
    const builder = t.user('builder');
    const requester = t.user('requester');
    expect((await t.request('GET', '/api/compliance/mapping')).status).toBe(401);
    expect((await t.request('GET', '/api/compliance/mapping', { headers: requester.headers })).status).toBe(
      403,
    );
    const dto = await t.json<ComplianceMappingDTO>('GET', '/api/compliance/mapping', {
      headers: builder.headers,
    });
    expect(dto).toMatchObject({
      standard: 'ISO/IEC 42001:2023',
      version: BUILTIN_MAPPING.version,
      hash: builtinMapping().hash,
      source: 'builtin',
      status: 'provisional',
      stampedBy: null,
      stampedAt: null,
      stamp: null,
      banner: MAPPING_PROVISIONAL_BANNER,
      statement: 'PROVISIONAL until stamped by the compliance lead',
      viewer: { canStamp: false, reason: 'compliance_lead_required' },
    });
    expect(dto.publishedAt).toBe('2026-10-09T02:00:00.000Z');
    expect(dto.rows.length).toBe(builtinMapping().mapping.rows.length);
    expect(dto.rows.every((r) => r.status === 'provisional')).toBe(true);
    expect(dto.rows.find((r) => r.id === 'aoc.event-log')?.clause).toBe('A.6.2.8');
  });

  it('stamping requires the compliance-lead flag and binds the stamp to the mapping hash', async () => {
    t = await createTestRuntime({ modules: [createEvidenceModule({ mappingFile: missingFile })] });
    const builder = t.user('builder');
    const approver = t.user('approver');
    const requesterLead = t.user('requester', 'r', { complianceLead: true });
    const lead = t.user('builder', 'lead', { complianceLead: true });
    const body = { version: BUILTIN_MAPPING.version, note: 'Checked every row against the 2023 text' };

    const noFlag = await t.request('POST', '/api/compliance/mapping/stamp', {
      headers: builder.headers,
      body,
    });
    expect(noFlag.status).toBe(403);
    expect(((await noFlag.json()) as { error: { code: string } }).error.code).toBe(
      'compliance_lead_required',
    );
    // The Approver role alone is not enough; requesters never reach the audit surface even when flagged.
    expect(
      (await t.request('POST', '/api/compliance/mapping/stamp', { headers: approver.headers, body })).status,
    ).toBe(403);
    expect(
      (await t.request('POST', '/api/compliance/mapping/stamp', { headers: requesterLead.headers, body }))
        .status,
    ).toBe(403);
    expect(t.rt.store.list({ types: ['mapping.stamped'] })).toEqual([]);

    expect(
      (
        await t.request('POST', '/api/compliance/mapping/stamp', {
          headers: lead.headers,
          body: { note: 'x' },
        })
      ).status,
    ).toBe(422);
    const stale = await t.request('POST', '/api/compliance/mapping/stamp', {
      headers: lead.headers,
      body: { version: 'old' },
    });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: { code: string } }).error.code).toBe('version_mismatch');
    const changed = await t.request('POST', '/api/compliance/mapping/stamp', {
      headers: lead.headers,
      body: { version: BUILTIN_MAPPING.version, hash: '0'.repeat(64) },
    });
    expect(changed.status).toBe(409);

    t.clock.set('2026-10-09T17:30:00.000Z'); // 01:30 on 10 Oct in Kuala Lumpur
    const dto = await t.json<ComplianceMappingDTO>('POST', '/api/compliance/mapping/stamp', {
      headers: lead.headers,
      body: { ...body, hash: builtinMapping().hash },
    });
    expect(dto).toMatchObject({
      status: 'stamped',
      stampedBy: lead.user.id,
      stampedAt: '2026-10-09T17:30:00.000Z',
      banner: null,
      statement: 'Mapping reviewed by compliance lead on 2026-10-10',
      stamp: { by: lead.user.id, localDate: '2026-10-10', note: body.note },
      viewer: { canStamp: true, reason: null },
    });
    expect(dto.rows.every((r) => r.status === 'stamped')).toBe(true);
    const [stamped] = t.rt.store.list({ types: ['mapping.stamped'] });
    expect(stamped!.meta).toEqual({
      version: BUILTIN_MAPPING.version,
      hash: builtinMapping().hash,
      stampedBy: lead.user.id,
    });
    expect(JSON.stringify(stamped!.meta)).not.toContain('Checked every row');
    const seen = await t.json<ComplianceMappingDTO>('GET', '/api/compliance/mapping', {
      headers: builder.headers,
    });
    expect(seen).toMatchObject({ status: 'stamped', viewer: { canStamp: false } });
  });
});

describe('mapping publication across restarts', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('publishes on start only when the hash is new, and a stamp follows the exact hash', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'aoc-evd-'));
    const confDir = mkdtempSync(join(tmpdir(), 'aoc-evd-conf-'));
    dirs.push(dataDir, confDir);
    const mappingFile = join(confDir, 'iso42001-mapping.json');
    const key = randomBytes(32);
    const clock = new FakeClock('2026-10-09T02:00:00.000Z');
    const config = AocConfigSchema.parse({ dataDir });
    /** One daemon lifetime: start, read (and optionally stamp) the mapping as a compliance lead, stop. */
    const boot = async (stamp = false) => {
      let identity!: DevIdentityService;
      const devIdentity: AocModule = {
        name: 'dev-identity',
        init(ctx) {
          identity = new DevIdentityService(ctx.store);
          ctx.services.provide('identity', identity);
        },
      };
      const rt = await AocRuntime.create({
        config,
        modules: [createEvidenceModule({ mappingFile }), devIdentity],
        clock,
        log: silentLogger,
        masterKey: key,
        dataDir,
      });
      const app = rt.mount();
      const { token } = identity.createUser({ role: 'builder', complianceLead: true });
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      let dto = (await (
        await app.request('/api/compliance/mapping', { headers })
      ).json()) as ComplianceMappingDTO;
      if (stamp) {
        const res = await app.request('/api/compliance/mapping/stamp', {
          method: 'POST',
          headers,
          body: JSON.stringify({ version: dto.version }),
        });
        dto = (await res.json()) as ComplianceMappingDTO;
      }
      const published = rt.store.list({ types: ['mapping.published'] }).map((e) => e.meta);
      await rt.stop();
      return { published, status: dto.status, hash: dto.hash };
    };
    const fileA: MappingFile = {
      ...BUILTIN_MAPPING,
      version: '2026.10.2',
      rows: BUILTIN_MAPPING.rows.slice(0, 3),
    };

    const first = await boot();
    expect(first.published).toEqual([
      {
        version: BUILTIN_MAPPING.version,
        hash: builtinMapping().hash,
        rows: BUILTIN_MAPPING.rows.length,
        source: 'builtin',
      },
    ]);
    expect((await boot()).published).toHaveLength(1);

    writeFileSync(mappingFile, JSON.stringify(fileA));
    const a = await boot();
    expect(a.published).toHaveLength(2);
    expect(a.published[1]).toMatchObject({ version: '2026.10.2', rows: 3, source: 'config' });
    expect((await boot()).published).toHaveLength(2);
    expect((await boot(true)).status).toBe('stamped');

    // Same version, different content: the stamp does not carry over.
    writeFileSync(mappingFile, JSON.stringify({ ...fileA, rows: BUILTIN_MAPPING.rows.slice(0, 4) }));
    const edited = await boot();
    expect(edited.published).toHaveLength(3);
    expect(edited.hash).not.toBe(a.hash);
    expect(edited.status).toBe('provisional');

    // Reverting re-publishes A (the log shows which mapping is active) and A's stamp still applies.
    writeFileSync(mappingFile, JSON.stringify(fileA));
    const reverted = await boot();
    expect(reverted.published).toHaveLength(4);
    expect(reverted.status).toBe('stamped');
  });
});
