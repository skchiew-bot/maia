import { z } from 'zod';
import {
  hasPermission,
  zId,
  type AnchorListDTO,
  type AuditBodyState,
  type AuditEventDetailDTO,
  type AuditEventHeaderDTO,
  type AuditEventPageDTO,
  type BackupListDTO,
  type BackupRunDTO,
  type EraseResultDTO,
  type StoredEvent,
} from '@aoc/contracts';
import {
  HttpError,
  parseQuery,
  readJson,
  requirePermission,
  type App,
  type ModuleContext,
} from '@aoc/kernel';
import type { AuditService } from './service';
import { payloadAccess } from './visibility';

const EventsQuery = z.object({
  fromSeq: z.coerce.number().int().min(1).optional(),
  toSeq: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
  order: z.enum(['asc', 'desc']).default('asc'),
  /** Comma-separated exact event types. */
  type: z.string().max(2000).optional(),
  typePrefix: z
    .string()
    .max(80)
    .regex(/^[a-z0-9_.]+$/)
    .optional(),
  sessionId: zId.optional(),
  projectId: zId.optional(),
  ticketId: zId.optional(),
  actorId: z.string().max(128).optional(),
});

const EraseBody = z
  .object({
    scopeId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9_.:#@-]+$/),
    reason: z.enum(['pdpa_request', 'secret_leak', 'retention', 'other']),
    decisionId: zId.nullish(),
  })
  .strict();

export function headerDTO(e: StoredEvent): AuditEventHeaderDTO {
  return {
    seq: e.seq,
    id: e.id,
    ts: e.ts,
    type: e.type,
    actor: e.actor,
    scope: e.scope,
    meta: e.meta,
    source: e.source,
    hasBody: e.payloadHash !== null,
    payloadHashPrefix: e.payloadHash ? e.payloadHash.slice(0, 16) : null,
    hash: e.hash,
    prevHash: e.prevHash,
  };
}

/** Audit HTTP API (§13). Every route requires an authenticated user with the stated permission. */
export function registerAuditRoutes(app: App, ctx: ModuleContext, svc: () => AuditService): void {
  const { store, db } = ctx;

  app.get('/api/audit/events', (c) => {
    requirePermission(c, 'audit.view');
    const q = parseQuery(c, EventsQuery);
    const rows = store.list({
      fromSeq: q.fromSeq,
      toSeq: q.toSeq,
      types: q.type
        ?.split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      typePrefix: q.typePrefix,
      sessionId: q.sessionId,
      projectId: q.projectId,
      ticketId: q.ticketId,
      actorId: q.actorId,
      limit: q.limit,
      order: q.order,
    });
    const full = rows.length === q.limit;
    const last = rows[rows.length - 1];
    const page: AuditEventPageDTO = {
      // `_` is a LIKE wildcard in the store query: keep only exact prefix matches
      events: rows.filter((e) => !q.typePrefix || e.type.startsWith(q.typePrefix)).map(headerDTO),
      headSeq: store.head().seq,
      nextFromSeq: q.order === 'asc' && full && last ? last.seq + 1 : null,
      nextToSeq: q.order === 'desc' && full && last && last.seq > 1 ? last.seq - 1 : null,
    };
    return c.json(page);
  });

  app.get('/api/audit/events/:seq', (c) => {
    const auth = requirePermission(c, 'audit.view');
    const seq = Number(c.req.param('seq'));
    if (!Number.isInteger(seq) || seq < 1)
      throw new HttpError(422, 'invalid', 'seq must be a positive integer');
    const e = store.get(seq);
    if (!e) throw new HttpError(404, 'not_found', `No event at seq ${seq}`);
    let body: AuditBodyState = 'none';
    if (e.payloadHash) {
      if (store.bodies.get(e.id) !== null) body = 'present';
      else {
        const erased = e.bodyScope
          ? db
              .prepare('SELECT 1 FROM aud_erasures WHERE scope_id = ? AND event_seq > ? LIMIT 1')
              .get(e.bodyScope, e.seq)
          : undefined;
        body = erased ? 'erased' : 'missing';
      }
    }
    const user = auth.user;
    const access = payloadAccess(e, { role: user.role, can: (p) => hasPermission(user.role, p, user.flags) });
    const detail: AuditEventDetailDTO = {
      ...headerDTO(e),
      bodyScope: e.bodyScope,
      sourceTs: e.sourceTs,
      causationId: e.causationId,
      body,
      erased: body === 'erased',
      bodyVerified: body === 'present' ? store.verifyBody(e) : null,
      payloadVisible: access.visible && body === 'present',
      payloadWithheldReason: body === 'present' ? access.reason : null,
      payload: access.visible && body === 'present' ? store.readPayload(e) : null,
    };
    return c.json(detail);
  });

  app.get('/api/audit/anchors', (c) => {
    requirePermission(c, 'audit.view');
    const s = svc();
    const out: AnchorListDTO = {
      anchors: s.anchorList(),
      provider: s.providerName,
      offHost: s.offHost,
      headSeq: store.head().seq,
    };
    return c.json(out);
  });

  app.get('/api/audit/health', (c) => {
    requirePermission(c, 'audit.view');
    return c.json(svc().health());
  });

  app.get('/api/audit/verify', async (c) => {
    const auth = requirePermission(c, 'audit.verify');
    return c.json(await svc().verifyNow({ kind: 'human', id: auth.user.id }, 'api'));
  });

  app.post('/api/audit/anchor', async (c) => {
    const auth = requirePermission(c, 'audit.verify');
    const r = await svc().anchorNow({ kind: 'human', id: auth.user.id }, 'api');
    if (r.ok) return c.json({ ok: true, anchor: r.anchor, pushError: r.pushError });
    if ('skipped' in r) {
      throw r.skipped === 'disabled'
        ? new HttpError(409, 'anchoring_disabled', 'Anchoring is disabled (audit.anchorProvider = none)')
        : new HttpError(409, 'empty_chain', 'Nothing to anchor yet');
    }
    throw new HttpError(502, 'anchor_failed', `Anchoring failed: ${r.reason}`, {
      provider: r.provider,
      reason: r.reason,
    });
  });

  app.get('/api/audit/backups', (c) => {
    requirePermission(c, 'audit.view');
    const s = svc();
    const audit = ctx.config.audit;
    const out: BackupListDTO = {
      configured: s.backups.configured,
      atLocalTime: audit.backupAtLocalTime,
      retentionDays: audit.backupRetentionDays,
      copyConfigured: audit.backupCopyCommand.length > 0,
      backups: s.backupList(),
    };
    return c.json(out);
  });

  // Same audience as an on-demand anchor; the destination, key and copy command come from config only.
  app.post('/api/audit/backup', async (c) => {
    const auth = requirePermission(c, 'audit.verify');
    const r = await svc().backupNow({ kind: 'human', id: auth.user.id }, 'api', { manual: true });
    if (r.ok) {
      const out: BackupRunDTO = { ok: true, backup: r.backup, copyError: r.copyError };
      return c.json(out);
    }
    if ('skipped' in r) {
      if (r.skipped === 'too_recent')
        throw new HttpError(429, 'backup_too_recent', 'The last backup is only minutes old; try again later');
      throw new HttpError(
        409,
        'backup_not_configured',
        r.skipped === 'no_data_dir'
          ? 'Backups need an on-disk data dir'
          : 'Backups are off until audit.backupKeyFile is configured',
      );
    }
    throw new HttpError(502, 'backup_failed', `Backup failed: ${r.reason}`, { stage: r.stage, reason: r.reason });
  });

  app.post('/api/audit/erase', async (c) => {
    const auth = requirePermission(c, 'audit.erase');
    const body = await readJson(c, EraseBody);
    const decisionId = body.decisionId ?? null;
    if (decisionId) {
      const card = ctx.services.maybe('decisions')?.get(decisionId) ?? null;
      if (!card)
        throw new HttpError(422, 'unknown_decision', 'decisionId does not reference a known decision');
      if (card.status !== 'resolved')
        throw new HttpError(409, 'decision_not_resolved', 'The referenced decision is not resolved');
    }
    const eventsInScope = (
      db.prepare('SELECT COUNT(*) AS n FROM events WHERE body_scope = ?').get(body.scopeId) as { n: number }
    ).n;
    const e = store.eraseScope(body.scopeId, {
      actor: { kind: 'human', id: auth.user.id },
      reason: body.reason,
      decisionId,
    });
    const out: EraseResultDTO = {
      scopeId: body.scopeId,
      reason: body.reason,
      bodiesErased: Number(e.meta.bodyCount ?? 0),
      eventsInScope,
      eventSeq: e.seq,
      decisionId,
    };
    return c.json(out);
  });
}
