import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import {
  EvidencePackRequestSchema,
  MAPPING_PROVISIONAL_BANNER,
  MAPPING_PROVISIONAL_STATEMENT,
  MappingStampRequestSchema,
  hasPermission,
  mappingStampStatement,
  newId,
  validateEvent,
  type Actor,
  type ComplianceMappingDTO,
  type EvidencePackIntegrity,
  type EvidencePackManifest,
  type EvidencePackSummaryDTO,
  type MetaOf,
  type StoredEvent,
  type User,
} from '@aoc/contracts';
import {
  HttpError,
  localDate,
  readJson,
  requirePermission,
  requireUser,
  sha256hex,
  type AocModule,
  type EventStore,
  type ModuleContext,
} from '@aoc/kernel';
import { iterateEvents, metaOf } from './events';
import { loadMapping, type LoadedMapping } from './mapping';
import { buildEvidencePack, type MappingSnapshot } from './pack';
import { resolveRange } from './range';
import { PACK_ID_RE, discardUnrecorded, packPath, readStored, writeFrozen } from './storage';

export * from './mapping';
export { BUILTIN_MAPPING } from './default-mapping';
export {
  buildEvidencePack,
  PACK_PRIVACY_STATEMENT,
  type BuildPackInput,
  type BuiltPack,
  type MappingSnapshot,
} from './pack';
export { resolveRange, zonedStartOfDay, isCalendarDate, type ResolvedRange } from './range';
export { renderReport, esc } from './report';
export { recomputeLineHash } from './verification';
export { PACK_ID_RE, PackExistsError, packPath, writeFrozen } from './storage';

export const DEFAULT_MAPPING_FILE = 'config/iso42001-mapping.json';
const SYSTEM: Actor = { kind: 'system', id: 'evidence' };

export interface EvidenceModuleOptions {
  /** ISO 42001 mapping file; the built-in default is used when it is absent or invalid. null = built-in only. */
  mappingFile?: string | null;
  /** Where frozen packs are stored. Default `<dataDir>/evidence`. */
  packDir?: string;
  /** Longest range one pack may cover. Default 366 days. */
  maxRangeDays?: number;
  /** Local time of the daily re-hash of every stored pack. Default 03:00 (after the nightly anchor). */
  integritySweepAt?: string;
}

/** Publish the loaded mapping when its hash differs from the latest published one (restarts stay quiet). */
export function publishMappingIfChanged(store: EventStore, m: LoadedMapping): StoredEvent | null {
  const latest = store.list({ types: ['mapping.published'], order: 'desc', limit: 1 })[0];
  if (latest && metaOf(latest, 'mapping.published').hash === m.hash) return null;
  return store.append({
    type: 'mapping.published',
    actor: SYSTEM,
    meta: { version: m.mapping.version, hash: m.hash, rows: m.mapping.rows.length, source: m.source },
    source: 'system',
  });
}

/** Stamping needs the internal audit surface plus the compliance-lead flag (an Approver alone is not enough). */
export function stampEligibility(user: User): { ok: boolean; reason: string | null } {
  if (!hasPermission(user.role, 'audit.view', user.flags)) return { ok: false, reason: 'role' };
  if (user.flags.complianceLead !== true) return { ok: false, reason: 'compliance_lead_required' };
  if (!hasPermission(user.role, 'mapping.stamp', user.flags)) return { ok: false, reason: 'permission' };
  return { ok: true, reason: null };
}

interface IntegrityCheck {
  integrity: EvidencePackIntegrity;
  bytes: Buffer | null;
  actualHash: string | null;
}

export function createEvidenceModule(opts: EvidenceModuleOptions = {}): AocModule {
  let ctx: ModuleContext;
  let loaded: LoadedMapping;
  let packDirPath: string | null = null;
  let ephemeralPackDir = false;
  const maxRangeDays = opts.maxRangeDays ?? 366;

  /** Resolved on first use; an in-memory store (tests) gets a temp dir that is removed on stop. */
  function packDir(): string {
    if (!packDirPath) {
      ephemeralPackDir = !opts.packDir && ctx.dataDir === ':memory:';
      packDirPath =
        opts.packDir ??
        (ephemeralPackDir ? mkdtempSync(join(tmpdir(), 'aoc-evidence-')) : join(ctx.dataDir, 'evidence'));
    }
    return packDirPath;
  }

  const latestOf = (type: 'mapping.stamped' | 'mapping.published', hash: string): StoredEvent | null =>
    ctx.store.list({ types: [type], order: 'desc', limit: 100_000 }).find((e) => e.meta.hash === hash) ??
    null;

  function snapshot(): MappingSnapshot & { stampEvent: StoredEvent | null } {
    const stamp = latestOf('mapping.stamped', loaded.hash);
    if (!stamp) {
      return {
        loaded,
        status: 'provisional',
        stampedBy: null,
        stampedAt: null,
        statement: MAPPING_PROVISIONAL_STATEMENT,
        stampEvent: null,
      };
    }
    return {
      loaded,
      status: 'stamped',
      stampedBy: metaOf(stamp, 'mapping.stamped').stampedBy,
      stampedAt: stamp.ts,
      statement: mappingStampStatement(localDate(Date.parse(stamp.ts), ctx.config.timezone)),
      stampEvent: stamp,
    };
  }

  function mappingDto(viewer: User): ComplianceMappingDTO {
    const s = snapshot();
    const m = loaded.mapping;
    const stamp = s.stampEvent;
    const note = stamp ? ((ctx.store.readPayload(stamp) as { note?: string } | null)?.note ?? null) : null;
    const eligibility = stampEligibility(viewer);
    return {
      standard: m.standard,
      version: m.version,
      hash: loaded.hash,
      notes: m.notes,
      source: loaded.source,
      file: loaded.file,
      warnings: loaded.warnings,
      status: s.status,
      stampedBy: s.stampedBy,
      stampedAt: s.stampedAt,
      stamp: stamp
        ? {
            by: s.stampedBy!,
            at: stamp.ts,
            localDate: localDate(Date.parse(stamp.ts), ctx.config.timezone),
            eventId: stamp.id,
            seq: stamp.seq,
            note,
          }
        : null,
      statement: s.statement,
      banner: s.status === 'stamped' ? null : MAPPING_PROVISIONAL_BANNER,
      publishedAt: latestOf('mapping.published', loaded.hash)?.ts ?? null,
      rows: m.rows.map((r) => ({ ...r, status: s.status })),
      viewer: { canStamp: eligibility.ok, reason: eligibility.reason },
    };
  }

  function findPack(id: string): StoredEvent {
    if (PACK_ID_RE.test(id)) {
      for (const e of iterateEvents(ctx.store, { types: ['evidence_pack.generated'] })) {
        if (e.meta.packId === id) return e;
      }
    }
    throw new HttpError(404, 'not_found', 'Evidence pack not found');
  }

  function checkIntegrity(e: StoredEvent): IntegrityCheck {
    const m = metaOf(e, 'evidence_pack.generated');
    const bytes = readStored(packPath(packDir(), m.packId));
    if (!bytes) return { integrity: 'missing', bytes: null, actualHash: null };
    const actualHash = sha256hex(bytes);
    return { integrity: actualHash === m.packHash ? 'ok' : 'tampered', bytes, actualHash };
  }

  /** Audit (once per distinct altered content) and raise a danger notification. */
  function reportIntegrityFailure(e: StoredEvent, check: IntegrityCheck): void {
    const m = metaOf(e, 'evidence_pack.generated');
    const reason = check.integrity === 'missing' ? 'missing' : 'hash_mismatch';
    ctx.store.append({
      type: 'evidence_pack.integrity_failed',
      actor: SYSTEM,
      meta: { packId: m.packId, expectedHash: m.packHash, actualHash: check.actualHash, reason },
      source: 'system',
      causationId: e.id,
      idempotencyKey: `evidence_pack.integrity_failed:${m.packId}:${check.actualHash ?? 'missing'}`,
    });
    ctx.notify({
      kind: 'info',
      severity: 'danger',
      title: `Evidence pack ${m.packId} failed its integrity check (${reason === 'missing' ? 'file missing' : 'contents altered'})`,
      audience: ['approver', 'builder'],
      link: `/audit/evidence/${m.packId}`,
      refs: { packId: m.packId },
    });
    ctx.log.error('evidence pack integrity failure', { packId: m.packId, reason });
  }

  function summaryOf(e: StoredEvent): EvidencePackSummaryDTO {
    const m: MetaOf<'evidence_pack.generated'> = metaOf(e, 'evidence_pack.generated');
    return {
      packId: m.packId,
      from: m.from,
      to: m.to,
      generatedAt: m.generatedAt,
      generatedBy: e.actor,
      packHash: m.packHash,
      bytes: m.bytes,
      eventCount: m.eventCount,
      headSeq: m.headSeq,
      mappingVersion: m.mappingVersion,
      mappingHash: m.mappingHash,
      mappingStamped: m.mappingStamped,
      rateCardVersion: m.rateCardVersion,
      chainOk: m.chainOk,
      anchorsChecked: m.anchorsChecked,
      anchorsMatched: m.anchorsMatched,
      downloadUrl: `/api/evidence/packs/${m.packId}/download`,
    };
  }

  function readManifest(bytes: Uint8Array): EvidencePackManifest | null {
    try {
      const file = unzipSync(bytes, { filter: (f) => f.name === 'manifest.json' })['manifest.json'];
      return file ? (JSON.parse(strFromU8(file)) as EvidencePackManifest) : null;
    } catch {
      return null;
    }
  }

  return {
    name: 'evidence',
    init(c) {
      ctx = c;
      loaded = loadMapping(opts.mappingFile === undefined ? (c.config.compliance?.mappingFile ?? DEFAULT_MAPPING_FILE) : opts.mappingFile);
      if (loaded.warnings.length)
        c.log.warn('compliance mapping warnings', { source: loaded.source, warnings: loaded.warnings });
    },
    start(c) {
      publishMappingIfChanged(c.store, loaded);
    },
    stop() {
      if (ephemeralPackDir && packDirPath) rmSync(packDirPath, { recursive: true, force: true });
    },
    jobs: [
      {
        name: 'evidence.integrity-sweep',
        schedule: { dailyAt: opts.integritySweepAt ?? '03:00' },
        run() {
          for (const e of iterateEvents(ctx.store, { types: ['evidence_pack.generated'] })) {
            const check = checkIntegrity(e);
            if (check.integrity !== 'ok') reportIntegrityFailure(e, check);
          }
        },
      },
    ],
    routes(app) {
      app.get('/api/compliance/mapping', (c) => {
        const auth = requirePermission(c, 'audit.view');
        return c.json(mappingDto(auth.user));
      });

      app.post('/api/compliance/mapping/stamp', async (c) => {
        const auth = requireUser(c);
        const eligibility = stampEligibility(auth.user);
        if (eligibility.reason === 'compliance_lead_required') {
          throw new HttpError(
            403,
            'compliance_lead_required',
            'Stamping the compliance mapping requires the compliance-lead flag',
          );
        }
        if (!eligibility.ok) {
          throw new HttpError(
            403,
            'forbidden',
            `Missing permission ${eligibility.reason === 'role' ? 'audit.view' : 'mapping.stamp'}`,
          );
        }
        const body = await readJson(c, MappingStampRequestSchema);
        const current = { version: loaded.mapping.version, hash: loaded.hash };
        if (body.version !== current.version) {
          throw new HttpError(
            409,
            'version_mismatch',
            `The active mapping is version ${current.version}`,
            current,
          );
        }
        if (body.hash && body.hash !== current.hash) {
          throw new HttpError(409, 'hash_mismatch', 'The mapping changed since it was reviewed', current);
        }
        ctx.store.append({
          type: 'mapping.stamped',
          actor: { kind: 'human', id: auth.user.id },
          meta: { version: current.version, hash: current.hash, stampedBy: auth.user.id },
          payload: body.note ? { note: body.note } : {},
          source: 'api',
        });
        return c.json(mappingDto(auth.user));
      });

      app.post('/api/evidence/packs', async (c) => {
        const auth = requirePermission(c, 'evidence.generate');
        const body = await readJson(c, EvidencePackRequestSchema);
        const resolved = resolveRange(body.from, body.to, ctx.config.timezone, ctx.clock.now(), maxRangeDays);
        if (!resolved.ok)
          throw new HttpError(422, 'invalid_range', resolved.problems.join('; '), resolved.problems);
        const packId = newId('evidencePack', ctx.clock.now());
        const generatedAt = ctx.clock.iso();
        const generatedBy: Actor = { kind: 'human', id: auth.user.id };
        const mapping = snapshot();
        const built = buildEvidencePack({
          store: ctx.store,
          packId,
          range: resolved.range,
          generatedAt,
          generatedBy,
          mapping,
        });
        const v = built.manifest.verification;
        const meta: MetaOf<'evidence_pack.generated'> = {
          packId,
          from: body.from,
          to: body.to,
          generatedAt,
          packHash: built.packHash,
          bytes: built.zip.length,
          eventCount: built.manifest.eventCount,
          headSeq: built.manifest.head.seq,
          mappingVersion: loaded.mapping.version,
          mappingHash: loaded.hash,
          mappingStamped: mapping.status === 'stamped',
          rateCardVersion: built.manifest.rateCard?.version ?? 0,
          chainOk: v.chainOk,
          anchorsChecked: v.anchorsChecked,
          anchorsMatched: v.anchorsMatched,
        };
        // Validate before writing so a rejected event never leaves an unrecorded file behind.
        const problems = validateEvent('evidence_pack.generated', meta, null);
        if (problems.length) throw new Error(`evidence_pack.generated invalid: ${problems.join('; ')}`);
        const path = packPath(packDir(), packId);
        writeFrozen(path, built.zip);
        let e: StoredEvent;
        try {
          e = ctx.store.append({ type: 'evidence_pack.generated', actor: generatedBy, meta, source: 'api' });
        } catch (err) {
          discardUnrecorded(path);
          throw err;
        }
        if (!v.ok) {
          ctx.notify({
            kind: 'info',
            severity: 'danger',
            title: `Evidence pack ${packId} records a failed chain or anchor verification`,
            audience: ['approver', 'builder'],
            link: `/audit/evidence/${packId}`,
            refs: { packId },
          });
        }
        ctx.log.info('evidence pack generated', {
          packId,
          from: body.from,
          to: body.to,
          events: meta.eventCount,
          chainOk: v.chainOk,
        });
        return c.json({ ...summaryOf(e), integrity: 'ok' as const, manifest: built.manifest }, 201);
      });

      app.get('/api/evidence/packs', (c) => {
        requirePermission(c, 'audit.view');
        const packs = ctx.store
          .list({ types: ['evidence_pack.generated'], order: 'desc', limit: 1000 })
          .map(summaryOf);
        return c.json({ packs });
      });

      app.get('/api/evidence/packs/:id', (c) => {
        requirePermission(c, 'audit.view');
        const e = findPack(c.req.param('id'));
        const check = checkIntegrity(e);
        if (check.integrity !== 'ok') reportIntegrityFailure(e, check);
        return c.json({
          ...summaryOf(e),
          integrity: check.integrity,
          manifest: check.bytes && check.integrity === 'ok' ? readManifest(check.bytes) : null,
        });
      });

      app.get('/api/evidence/packs/:id/download', (c) => {
        requirePermission(c, 'audit.view');
        const e = findPack(c.req.param('id'));
        const check = checkIntegrity(e);
        const m = metaOf(e, 'evidence_pack.generated');
        if (check.integrity !== 'ok' || !check.bytes) {
          reportIntegrityFailure(e, check);
          throw new HttpError(
            409,
            check.integrity === 'missing' ? 'pack_missing' : 'pack_tampered',
            'Stored evidence pack failed its integrity check; download refused',
            { packId: m.packId, expectedHash: m.packHash, actualHash: check.actualHash },
          );
        }
        return c.body(new Uint8Array(check.bytes), 200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="aoc-evidence-${m.from}_${m.to}-${m.packId}.zip"`,
          'x-aoc-pack-sha256': m.packHash,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
      });
    },
  };
}
