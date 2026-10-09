import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { EvidencePackDetailDTO, JsonObject } from '@aoc/contracts';
import { canonicalJson, localDate, sha256hex } from '@aoc/kernel';
import { createAuditModule } from '@aoc/mod-audit';
import { createEvidenceModule } from '@aoc/mod-evidence';
import { bootTestServer, removeTempDirs, tempDir, type TestServer } from './helpers';

afterEach(() => removeTempDirs());

/**
 * The R2 attack against the database file: drop the append-only triggers, rewrite one event and recompute every
 * later hash — the anchor.created rows included — so the log agrees with itself everywhere.
 */
function forgeEverything(dbFile: string, seq: number): void {
  const db = new DatabaseSync(dbFile);
  try {
    db.exec('DROP TRIGGER IF EXISTS events_append_only_u; DROP TRIGGER IF EXISTS events_append_only_d;');
    const chainId = (db.prepare("SELECT v FROM chain_info WHERE k = 'chain_id'").get() as { v: string }).v;
    const rows = db.prepare('SELECT * FROM events ORDER BY seq').all() as Record<string, string | number | null>[];
    const forged = new Map<number, string>();
    let prev = sha256hex(`aoc-genesis:${chainId}`);
    for (const r of rows) {
      let meta = JSON.parse(r.meta as string) as JsonObject;
      if (r.seq === seq) meta = { ...meta, sessionId: 'ses_forged' };
      if (r.type === 'anchor.created') meta = { ...meta, hash: forged.get(meta.seq as number) ?? (meta.hash as string) };
      const hash = sha256hex(
        canonicalJson({
          v: 1,
          chainId,
          seq: r.seq,
          id: r.id,
          ts: r.ts,
          type: r.type,
          actor: { kind: r.actor_kind, id: r.actor_id },
          scope: JSON.parse(r.scope_json as string) as JsonObject,
          meta,
          payloadHash: r.payload_hash,
          bodyScope: r.body_scope,
          source: r.source,
          sourceTs: r.source_ts,
          idempotencyKey: r.idempotency_key,
          causationId: r.causation_id,
          prevHash: prev,
        }),
      );
      forged.set(r.seq as number, hash);
      db.prepare('UPDATE events SET meta = ?, prev_hash = ?, hash = ? WHERE seq = ?').run(canonicalJson(meta), prev, hash, r.seq);
      prev = hash;
    }
  } finally {
    db.close();
  }
}

async function pack(srv: TestServer, headers: Record<string, string>): Promise<EvidencePackDetailDTO> {
  const day = localDate(Date.now(), srv.aoc.config.timezone);
  const res = await srv.request('/api/evidence/packs', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ from: day, to: day }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as EvidencePackDetailDTO;
}

describe('evidence packs verify anchors off-host (G-42)', () => {
  it('a pack built after the log and its anchor.created rows were rewritten reports the off-host mismatch', async () => {
    const root = tempDir();
    const remote = join(root, 'anchors.git');
    expect(spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote]).status).toBe(0);
    const srv = await bootTestServer({
      modules: [createAuditModule(), createEvidenceModule({ mappingFile: null })],
      config: { audit: { anchorProvider: 'git', anchorRepoPath: join(root, 'anchor-repo'), anchorRemote: remote } },
    });
    try {
      const approver = srv.user('approver').headers;
      const store = srv.aoc.runtime.store;
      const victim = store.append({
        type: 'session.restarted',
        actor: { kind: 'human', id: 'usr_ceo' },
        scope: { sessionId: 'ses_a' },
        meta: { sessionId: 'ses_a' },
        source: 'api',
      });
      const anchored = await srv.request('/api/audit/anchor', { method: 'POST', headers: approver });
      expect(anchored.status).toBe(200);

      const clean = await pack(srv, approver);
      expect(clean).toMatchObject({ verification: 'verified', chainOk: true, anchorsChecked: 1, anchorsMatched: 1 });
      expect(clean.manifest!.verification).toMatchObject({ ok: true, status: 'verified' });

      forgeEverything(join(srv.aoc.config.dataDir, 'aoc.db'), victim.seq);
      const forged = await pack(srv, approver);
      // In-file the forgery is perfect, and the anchor.created row agrees with it — but the off-host record does
      // not: the pack documents the rewrite instead of vouching for it.
      expect(forged).toMatchObject({ verification: 'failed', chainOk: true, anchorsChecked: 1, anchorsMatched: 0 });
      expect(forged.manifest!.verification).toMatchObject({ ok: false, status: 'failed', chainOk: true });
      const report = await srv.aoc.runtime.services.get('audit').verify();
      expect(report.anchors[0]).toMatchObject({ record: 'found', matched: false, proofOk: false });
      expect(report.anchors[0]!.chainHash).toBe(report.anchors[0]!.recomputedHash);
    } finally {
      await srv.close();
    }
  });
});
