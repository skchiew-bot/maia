import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  EvidenceBreakglassFile,
  EvidenceChanges,
  EvidenceControls,
  EvidenceCredits,
  EvidenceEventLine,
  EvidenceFx,
  EvidenceGates,
  EvidencePackDetailDTO,
  EvidencePackManifest,
  EvidencePackSummaryDTO,
  EvidenceRollbacks,
  EvidenceVerification,
} from '@aoc/contracts';
import { createTestRuntime, type BroadcastMessage, type TestRuntime, type TestUser } from '@aoc/kernel';
import {
  BUILTIN_MAPPING,
  PackExistsError,
  createEvidenceModule,
  recomputeLineHash,
  writeFrozen,
  type MappingFile,
} from '../src';
import {
  NOW,
  RANGE,
  RANGE_END_EXCL,
  RANGE_START,
  SECRET,
  anchorHead,
  seed,
  sha256,
  unzip,
  type Seeded,
} from './helpers';

const PACK_FILES = [
  'breakglass.json',
  'changes.json',
  'controls.json',
  'credits.json',
  'events.jsonl',
  'fx.json',
  'gates.json',
  'index.html',
  'manifest.json',
  'rollbacks.json',
  'verification.json',
];

interface Pack {
  detail: EvidencePackDetailDTO;
  bytes: Buffer;
  files: Record<string, string>;
  manifest: EvidencePackManifest;
  json: <T>(name: string) => T;
  lines: EvidenceEventLine[];
  path: string;
}

const tempDirs: string[] = [];
const opened: TestRuntime[] = [];
let t: TestRuntime;
afterEach(async () => {
  for (const rt of opened.splice(0)) await rt.close();
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(opts: { mappingFile?: string | null } = {}): Promise<TestRuntime> {
  t = await createTestRuntime({
    modules: [createEvidenceModule({ mappingFile: opts.mappingFile ?? null })],
    onDisk: true,
    now: '2026-10-01T00:00:00.000Z',
  });
  opened.push(t);
  return t;
}

async function generate(user: TestUser, range: { from: string; to: string } = RANGE): Promise<Pack> {
  const detail = await t.json<EvidencePackDetailDTO>('POST', '/api/evidence/packs', {
    headers: user.headers,
    body: range,
    expect: 201,
  });
  const path = join(t.dataDir, 'evidence', `${detail.packId}.zip`);
  const bytes = readFileSync(path);
  const files = unzip(bytes);
  const json = <T>(name: string) => JSON.parse(files[name]!) as T;
  const lines = files['events.jsonl']!.split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EvidenceEventLine);
  return { detail, bytes, files, manifest: json<EvidencePackManifest>('manifest.json'), json, lines, path };
}

describe('evidence pack generation', () => {
  it('freezes a hash-verified zip: manifest hashes match, stored write-once 0444, event recorded', async () => {
    await boot();
    const s = seed(t);
    const p = await generate(s.builder);

    expect(Object.keys(p.files).sort()).toEqual(PACK_FILES);
    expect(p.manifest.files.map((f) => f.path).sort()).toEqual(
      PACK_FILES.filter((f) => f !== 'manifest.json'),
    );
    for (const f of p.manifest.files) {
      const raw = Buffer.from(p.files[f.path]!, 'utf8');
      expect(sha256(raw), f.path).toBe(f.sha256);
      expect(raw.length, f.path).toBe(f.bytes);
    }

    expect(statSync(p.path).mode & 0o777).toBe(0o444);
    expect(sha256(p.bytes)).toBe(p.detail.packHash);
    const [e] = t.rt.store.list({ types: ['evidence_pack.generated'] });
    expect(e!.actor).toEqual({ kind: 'human', id: s.builder.user.id });
    expect(e!.meta).toMatchObject({
      packId: p.detail.packId,
      from: RANGE.from,
      to: RANGE.to,
      generatedAt: NOW,
      packHash: sha256(p.bytes),
      bytes: p.bytes.length,
      eventCount: p.lines.length,
      mappingVersion: BUILTIN_MAPPING.version,
      mappingStamped: false,
      rateCardVersion: 2,
      chainOk: true,
      anchorsChecked: 3,
      anchorsMatched: 3,
    });
    expect(() => writeFrozen(p.path, new Uint8Array([1, 2, 3]))).toThrow(PackExistsError);
    expect(sha256(readFileSync(p.path))).toBe(p.detail.packHash);

    expect(p.manifest).toMatchObject({
      format: 'aoc-evidence-pack/1',
      packId: p.detail.packId,
      range: {
        from: RANGE.from,
        to: RANGE.to,
        timezone: 'Asia/Kuala_Lumpur',
        days: 3,
        fromTs: RANGE_START,
        toTsExclusive: RANGE_END_EXCL,
        complete: true,
      },
      generatedAt: NOW,
      generatedBy: { kind: 'human', id: s.builder.user.id },
      chainId: t.rt.store.chainId,
      head: { seq: t.rt.store.head().seq - 1, hash: t.rt.store.get(t.rt.store.head().seq - 1)!.hash },
      mapping: {
        version: BUILTIN_MAPPING.version,
        source: 'builtin',
        status: 'provisional',
        statement: 'PROVISIONAL until stamped by the compliance lead',
      },
      rateCard: { version: 2, effectiveFrom: '2026-10-05' },
      rateCardVersionsUsed: [1],
      fx: { days: 3, live: 1, inherited: 1, missing: 1, minRate: 4.2, maxRate: 4.2, carryForwardAlerts: 1 },
      verification: {
        ok: true,
        chainOk: true,
        anchorsChecked: 3,
        anchorsMatched: 3,
        rangeCoveredByAnchor: true,
      },
    });
    expect(p.detail).toMatchObject({
      integrity: 'ok',
      manifest: p.manifest,
      downloadUrl: `/api/evidence/packs/${p.detail.packId}/download`,
    });
  });

  it('exports headers only: no payload text, names or personal data anywhere in the pack', async () => {
    await boot();
    const s = seed(t);
    const p = await generate(s.builder);
    expect(t.rt.store.list({ limit: 100_000 }).filter((e) => e.payloadHash).length).toBeGreaterThan(20);
    for (const [name, content] of Object.entries(p.files)) {
      expect(content, name).not.toContain(SECRET);
      expect(content, name).not.toContain('alice@example.com');
      expect(content, name).not.toContain('passport');
    }
    expect(p.bytes.toString('latin1')).not.toContain(SECRET);
    for (const line of p.lines) {
      expect(Object.keys(line).sort()).toEqual([
        'actor',
        'bodyScope',
        'causationId',
        'hash',
        'id',
        'idempotencyKey',
        'meta',
        'payloadHash',
        'prevHash',
        'scope',
        'seq',
        'source',
        'sourceTs',
        'ts',
        'type',
      ]);
    }
    expect(p.lines.find((l) => l.type === 'intake.submitted')!.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('filters by local-date range and maps in-range events to controls', async () => {
    await boot();
    const s: Seeded = seed(t);
    const p = await generate(s.builder);
    const expected = t.rt.store
      .list({ limit: 100_000 })
      .filter((e) => e.ts >= RANGE_START && e.ts < RANGE_END_EXCL)
      .map((e) => e.id);
    expect(p.lines.map((l) => l.id)).toEqual(expected);
    expect(p.detail.eventCount).toBe(expected.length);
    const ids = new Set(p.lines.map((l) => l.id));
    expect(ids.has(s.boundary.beforeStart)).toBe(false);
    expect(ids.has(s.boundary.atStart)).toBe(true);
    expect(ids.has(s.boundary.atEnd)).toBe(true);
    expect(ids.has(s.boundary.afterEnd)).toBe(false);
    expect(p.lines.every((l) => l.ts >= RANGE_START && l.ts < RANGE_END_EXCL)).toBe(true);

    const controls = p.json<EvidenceControls>('controls.json');
    const row = (id: string) => controls.rows.find((r) => r.id === id)!;
    expect(controls.rows).toHaveLength(BUILTIN_MAPPING.rows.length);
    // Deployment counts only the go-live resolution; the change-request resolution is a gate, not a deployment.
    expect(row('aoc.deployment').counts).toEqual({
      'promotion.requested': 0,
      'promotion.refused': 0,
      'promotion.completed': 1,
      'decision.resolved': 1,
    });
    expect(row('aoc.decision-gates').counts['decision.resolved']).toBe(2);
    expect(row('aoc.impact-assessment').counts).toEqual({ 'change.drafted': 0, 'change.field_affirmed': 1 });
    expect(row('aoc.monitoring').counts['session.liveness_changed']).toBe(1);
    expect(row('aoc.event-log')).toMatchObject({ clause: 'A.6.2.8', total: 1, status: 'provisional' });
    expect(row('aoc.event-log').samples).toEqual([
      expect.objectContaining({ id: s.anchors.during.id, type: 'anchor.created' }),
    ]);
    expect(row('aoc.incident-communication').total).toBe(2);
    expect(row('aoc.suppliers').noEventsInRange).toBe(false);
    expect(row('aoc.external-reporting').counts['intake.submitted']).toBe(1);
    expect(row('aoc.monitoring').counts['session.nudged']).toBe(2);
    // Pure inquiry is logged but is not build evidence (§1): it stays visible as unmapped.
    expect(controls.unmappedEventTypes).toEqual({ 'prompt.submitted': 1 });

    const gates = p.json<EvidenceGates>('gates.json');
    expect(gates).toMatchObject({
      count: 2,
      byKind: { change_request: 1, go_live: 1 },
      passkeyVerified: 1,
      flagged: 0,
    });
    expect(gates.gates.find((g) => g.kind === 'go_live')).toMatchObject({
      decisionId: 'dec_golive',
      test: null,
      requiredRole: 'approver',
      requiresPasskey: true,
      resolvedBy: s.approver.user.id,
      method: 'passkey',
      passkeyVerified: true,
      selfApproved: false,
      ageMs: 162_000_000,
      requestedSeq: s.goLiveRequest.seq,
      flags: [],
    });
    expect(gates.gates.find((g) => g.kind === 'change_request')).toMatchObject({
      test: 'main',
      requiredRole: 'approver',
      method: 'button',
    });

    const changes = p.json<EvidenceChanges>('changes.json');
    expect(changes.changes).toEqual([
      expect.objectContaining({
        changeId: 'chg_A',
        projectId: 'prj_1',
        scope: 'main',
        draftedBy: 'ai',
        draftedInRange: false,
        status: 'approved',
        decisionId: 'dec_chg',
        rollbackSha: 'abc1234',
        affirmations: { total: 2, edited: 1, affirmedWithoutEdit: 1 },
      }),
    ]);
    const rollbacks = p.json<EvidenceRollbacks>('rollbacks.json');
    expect(rollbacks).toMatchObject({ count: 1, executed: 1, flagged: 0 });
    expect(rollbacks.rollbacks[0]).toMatchObject({
      rollbackId: 'rbk_1',
      clean: true,
      passkeyVerified: true,
      mainShaAfter: 'def5678',
      status: 'executed',
    });
    const bg = p.json<EvidenceBreakglassFile>('breakglass.json');
    expect(bg.incidents[0]).toMatchObject({
      breakglassId: 'brk_1',
      invokedBy: s.builder.user.id,
      approverId: s.approver.user.id,
      passkeyVerified: true,
      postIncident: {
        changeId: 'chg_PI',
        completedAt: '2026-10-06T01:00:00.000Z',
        completedWithinDue: false,
      },
      flags: ['post_incident_overdue'],
    });
    expect(bg.flagged).toBe(1);
    expect(p.files['index.html']).toMatch(
      /<td>Break-glass<\/td><td>brk_1<\/td><td>post_incident_overdue<\/td>/,
    );
    const credits = p.json<EvidenceCredits>('credits.json');
    expect(credits.totals).toEqual({
      allocatedUsd: 0,
      autoGrantedUsd: 75,
      topupRequestedUsd: 100,
      topupGrantedUsd: 100,
    });
    expect(credits.topupsGranted[0]!.meta).toMatchObject({
      requestId: 'tpu_1',
      approverId: s.approver.user.id,
      balanceAfter: 100,
    });
    expect(credits.flags).toEqual([]);
    const fx = p.json<EvidenceFx>('fx.json');
    expect(fx.days.map((d) => [d.date, d.status, d.rate])).toEqual([
      ['2026-10-03', 'live', 4.2],
      ['2026-10-04', 'inherited', 4.2],
      ['2026-10-05', 'missing', null],
    ]);
    expect(fx.days[1]!.sourceDate).toBe('2026-10-03');
  });

  it('verifies the whole chain against every anchor, and the lines recompute offline', async () => {
    await boot();
    const s = seed(t);
    const p = await generate(s.builder);
    const v = p.json<EvidenceVerification>('verification.json');
    expect(v).toMatchObject({ ok: true, anchorsChecked: 3, anchorsMatched: 3, rangeCoveredByAnchor: true });
    expect(v.chain).toMatchObject({
      ok: true,
      checked: p.manifest.head.seq,
      headSeq: p.manifest.head.seq,
      firstBadSeq: null,
    });
    expect(v.anchorBeforeRange).toMatchObject({ anchorId: 'anc_before', matched: true });
    expect(v.anchorAfterRange).toMatchObject({ anchorId: 'anc_after', matched: true });
    const afterSeq = (s.anchors.after.meta as { seq: number }).seq;
    expect(v.unanchoredTail).toEqual({
      lastAnchoredSeq: afterSeq,
      fromSeq: afterSeq + 1,
      toSeq: p.manifest.head.seq,
      events: p.manifest.head.seq - afterSeq,
      rangeEvents: 0,
    });
    expect(v.range).toMatchObject({
      eventCount: p.lines.length,
      hashesRecomputed: p.lines.length,
      hashesMatched: p.lines.length,
    });

    // Offline: every line recomputes to its hash and consecutive lines link.
    for (const [i, line] of p.lines.entries()) {
      expect(recomputeLineHash(p.manifest.chainId, line)).toBe(line.hash);
      if (i > 0 && line.seq === p.lines[i - 1]!.seq + 1) expect(line.prevHash).toBe(p.lines[i - 1]!.hash);
    }
    expect(v.range.firstPrevHash).toBe(t.rt.store.get(p.lines[0]!.seq - 1)!.hash);
  });

  it('records failed anchors and a tampered chain instead of hiding them', async () => {
    await boot();
    const s = seed(t);
    const notes: BroadcastMessage[] = [];
    t.rt.broadcaster.subscribe({ role: 'approver', send: (m) => notes.push(m) });
    anchorHead(t, NOW, 'anc_forged', 'f'.repeat(64));
    const first = await generate(s.builder);
    expect(first.manifest.verification).toMatchObject({
      ok: false,
      chainOk: true,
      anchorsChecked: 4,
      anchorsMatched: 3,
    });
    expect(
      first.json<EvidenceVerification>('verification.json').anchors.find((a) => a.anchorId === 'anc_forged'),
    ).toMatchObject({ matched: false });
    expect(first.files['index.html']).toContain('Integrity check failed');
    expect(notes.some((m) => m.event === 'notification' && m.data.severity === 'danger')).toBe(true);

    t.rt.store.db.exec('DROP TRIGGER events_append_only_u');
    t.rt.store.db
      .prepare(`UPDATE events SET meta = '{"sessionId":"ses_forged"}' WHERE id = ?`)
      .run(s.boundary.atStart);
    const second = await generate(s.builder);
    const v = second.json<EvidenceVerification>('verification.json');
    expect(v.chain.ok).toBe(false);
    expect(v.chain.firstBadSeq).toBe(t.rt.store.get(s.boundary.atStart)!.seq);
    expect(v.range.hashesMatched).toBe(v.range.hashesRecomputed - 1);
    expect(second.detail.chainOk).toBe(false);
  });

  it('validates the range and the caller', async () => {
    await boot();
    const s = seed(t);
    const post = (body: unknown, headers = s.builder.headers) =>
      t.request('POST', '/api/evidence/packs', { headers, body });
    expect((await post(RANGE, {})).status).toBe(401);
    expect((await post(RANGE, s.requester.headers)).status).toBe(403);
    for (const body of [
      { from: '2026-10-05', to: '2026-10-03' },
      { from: '2026-10-03', to: '2026-10-10' },
      { from: '2026-02-30', to: '2026-03-01' },
      { from: '2026/10/03', to: '2026-10-05' },
      { from: '2025-01-01', to: '2026-10-05' },
      { from: '2026-10-03' },
    ]) {
      expect((await post(body)).status, JSON.stringify(body)).toBe(422);
    }
    expect(t.rt.store.list({ types: ['evidence_pack.generated'] })).toEqual([]);
    const today = await generate(s.builder, { from: '2026-10-09', to: '2026-10-09' });
    expect(today.manifest.range.complete).toBe(false);
    expect(today.manifest.eventCount).toBe(0);
  });
});

describe('stored packs', () => {
  it('works on an in-memory store, keeping packs in a temp dir that is removed on stop', async () => {
    const mem = await createTestRuntime({ modules: [createEvidenceModule({ mappingFile: null })], now: NOW });
    const u = mem.user('builder');
    const d = await mem.json<EvidencePackDetailDTO>('POST', '/api/evidence/packs', {
      headers: u.headers,
      body: { from: '2026-10-09', to: '2026-10-09' },
      expect: 201,
    });
    expect((await mem.request('GET', d.downloadUrl, { headers: u.headers })).status).toBe(200);
    const dir = readdirSync(tmpdir())
      .filter((n) => n.startsWith('aoc-evidence-'))
      .map((n) => join(tmpdir(), n))
      .find((p) => existsSync(join(p, `${d.packId}.zip`)));
    await mem.close();
    expect(dir).toBeDefined();
    expect(existsSync(dir!)).toBe(false);
  });

  it('lists packs and re-verifies the stored zip on detail and download', async () => {
    await boot();
    const s = seed(t);
    const a = await generate(s.builder);
    t.clock.advance(60_000);
    const b = await generate(s.approver, { from: '2026-10-01', to: '2026-10-08' });
    const { packs } = await t.json<{ packs: EvidencePackSummaryDTO[] }>('GET', '/api/evidence/packs', {
      headers: s.builder.headers,
    });
    expect(packs.map((x) => x.packId)).toEqual([b.detail.packId, a.detail.packId]);
    expect(packs[1]).toMatchObject({
      from: RANGE.from,
      to: RANGE.to,
      packHash: a.detail.packHash,
      generatedBy: { kind: 'human', id: s.builder.user.id },
    });
    expect((await t.request('GET', '/api/evidence/packs', { headers: s.requester.headers })).status).toBe(
      403,
    );

    const detail = await t.json<EvidencePackDetailDTO>('GET', `/api/evidence/packs/${a.detail.packId}`, {
      headers: s.approver.headers,
    });
    expect(detail).toMatchObject({ integrity: 'ok', packHash: a.detail.packHash, manifest: a.manifest });
    expect(
      (await t.request('GET', '/api/evidence/packs/evp_nope', { headers: s.builder.headers })).status,
    ).toBe(404);
    expect(
      (
        await t.request('GET', `/api/evidence/packs/${'evp_' + '0'.repeat(26)}/download`, {
          headers: s.builder.headers,
        })
      ).status,
    ).toBe(404);

    const res = await t.request('GET', `/api/evidence/packs/${a.detail.packId}/download`, {
      headers: s.builder.headers,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('x-aoc-pack-sha256')).toBe(a.detail.packHash);
    expect(res.headers.get('content-disposition')).toContain(
      `aoc-evidence-${RANGE.from}_${RANGE.to}-${a.detail.packId}.zip`,
    );
    expect(sha256(Buffer.from(await res.arrayBuffer()))).toBe(a.detail.packHash);
  });

  it('refuses a tampered or missing pack with 409, a danger notification and one audit event per alteration', async () => {
    await boot();
    const s = seed(t);
    const p = await generate(s.builder);
    const notes: BroadcastMessage[] = [];
    t.rt.broadcaster.subscribe({ role: 'approver', send: (m) => notes.push(m) });
    const download = () =>
      t.request('GET', `/api/evidence/packs/${p.detail.packId}/download`, { headers: s.approver.headers });

    chmodSync(p.path, 0o644);
    const altered = Buffer.from(p.bytes);
    altered[altered.length - 30] = altered[altered.length - 30]! ^ 0xff;
    writeFileSync(p.path, altered);
    for (let i = 0; i < 2; i++) {
      const res = await download();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: {
          code: 'pack_tampered',
          details: { packId: p.detail.packId, expectedHash: p.detail.packHash, actualHash: sha256(altered) },
        },
      });
    }
    const dangers = notes.filter((m) => m.event === 'notification' && m.data.severity === 'danger');
    expect(dangers).toHaveLength(2);
    expect(dangers[0]!.data).toMatchObject({
      refs: { packId: p.detail.packId },
      audience: ['approver', 'builder'],
    });
    const failures = () => t.rt.store.list({ types: ['evidence_pack.integrity_failed'] });
    expect(failures().map((e) => e.meta)).toEqual([
      {
        packId: p.detail.packId,
        expectedHash: p.detail.packHash,
        actualHash: sha256(altered),
        reason: 'hash_mismatch',
      },
    ]);
    expect(
      await t.json('GET', `/api/evidence/packs/${p.detail.packId}`, { headers: s.builder.headers }),
    ).toMatchObject({ integrity: 'tampered', manifest: null });

    unlinkSync(p.path);
    const gone = await download();
    expect(gone.status).toBe(409);
    expect(((await gone.json()) as { error: { code: string } }).error.code).toBe('pack_missing');
    expect(failures().map((e) => e.meta.reason)).toEqual(['hash_mismatch', 'missing']);

    // The nightly sweep finds it without anyone downloading.
    writeFileSync(p.path, altered.subarray(0, 100));
    await t.rt.runJob('evidence.integrity-sweep');
    expect(failures()).toHaveLength(3);
  });
});

describe('provisional banner and mapping stamp in packs', () => {
  it('shows "Provisional — do not cite" until the compliance lead stamps the mapping', async () => {
    await boot();
    const s = seed(t);
    const before = await generate(s.builder);
    expect(before.files['index.html']).toContain('Provisional — do not cite');
    expect(before.files['index.html']).toContain('PROVISIONAL until stamped by the compliance lead');
    expect(before.manifest.mapping).toMatchObject({
      status: 'provisional',
      stampedBy: null,
      statement: 'PROVISIONAL until stamped by the compliance lead',
    });
    expect(before.json<EvidenceControls>('controls.json').rows.every((r) => r.status === 'provisional')).toBe(
      true,
    );

    const lead = t.user('builder', 'lead', { complianceLead: true });
    await t.json('POST', '/api/compliance/mapping/stamp', {
      headers: lead.headers,
      body: { version: BUILTIN_MAPPING.version },
    });
    t.clock.advance(1000);
    const after = await generate(s.builder);
    expect(after.files['index.html']).not.toContain('Provisional — do not cite');
    expect(after.files['index.html']).toContain('Mapping reviewed by compliance lead on 2026-10-09');
    expect(after.manifest.mapping).toMatchObject({
      status: 'stamped',
      stampedBy: lead.user.id,
      stampedAt: NOW,
      statement: 'Mapping reviewed by compliance lead on 2026-10-09',
    });
    expect(after.json<EvidenceControls>('controls.json').rows.every((r) => r.status === 'stamped')).toBe(
      true,
    );
    expect(after.detail.mappingStamped).toBe(true);
    // The earlier pack is frozen: still provisional, still verifiable.
    expect(unzip(readFileSync(before.path))['index.html']).toContain('Provisional — do not cite');
    expect(sha256(readFileSync(before.path))).toBe(before.detail.packHash);
  });

  it('escapes mapping text in the HTML report', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-evd-map-'));
    tempDirs.push(dir);
    const mappingFile = join(dir, 'iso42001-mapping.json');
    const hostile: MappingFile = {
      ...BUILTIN_MAPPING,
      version: '2026.10.9',
      rows: [
        {
          ...BUILTIN_MAPPING.rows[0]!,
          aocControl: '<script>alert("x")</script>',
          clauseTitle: 'Logs & <b>"records"</b>',
        },
      ],
    };
    writeFileSync(mappingFile, JSON.stringify(hostile));
    await boot({ mappingFile });
    const s = seed(t);
    const p = await generate(s.builder);
    const html = p.files['index.html']!;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('Logs &amp; &lt;b&gt;&quot;records&quot;&lt;/b&gt;');
    expect(p.manifest.mapping).toMatchObject({ version: '2026.10.9', source: 'config', rows: 1 });
  });
});
