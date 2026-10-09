import {
  INGEST_PATHS,
  newId,
  PUBLIC_TICKET_STATUS_LABEL,
  ReportDiagnosisInput,
  SEVERITIES,
  hasPermission,
  type InternalTicket,
  type McpErrorResult,
  type PublicTicket,
  type Severity,
} from '@aoc/contracts';
import { HttpError, readJson, requireIngest, requirePermission, requireUser, type AocModule, type ModuleContext } from '@aoc/kernel';
import { z } from 'zod';
import { INTAKE_ACTOR, IntakeFlow, type TicketRow } from './flow';
import { intakeProjector } from './projector';
import { declaredMatches, safeFileName, scannerFor, sha256, sniff, type Scanner } from './upload';

export { sniff, builtinScanner, clamavScanner, safeFileName, type Scanner } from './upload';
export { IntakeFlow } from './flow';

export interface IntakeModuleOptions {
  /** Override the configured scanner (tests / custom AV integration). */
  scanner?: Scanner;
}

const McpBody = z.object({ sessionId: z.string(), input: z.unknown() });

function publicView(ctx: ModuleContext, flow: IntakeFlow, t: TicketRow): PublicTicket {
  const canSign = flow.openDecisions(t.ticket_id).some((d) => d.kind === 'uat_signoff');
  return {
    ticketId: t.ticket_id,
    title: t.title,
    description: t.description,
    comment: t.comment,
    severity: t.severity as Severity,
    status: t.public_status,
    statusLabel: PUBLIC_TICKET_STATUS_LABEL[t.public_status],
    submittedAt: t.submitted_at,
    updatedAt: t.updated_at,
    attachments: flow.attachments(t.ticket_id).map((a) => ({ attachmentId: a.attachment_id, fileName: a.file_name, mime: a.mime, bytes: a.bytes })),
    canSignOffUat: canSign,
  };
}

function internalView(ctx: ModuleContext, flow: IntakeFlow, t: TicketRow): InternalTicket {
  const requester = ctx.services.maybe('identity')?.getUser(t.requester_id);
  return {
    ticketId: t.ticket_id,
    projectId: t.project_id,
    requesterId: t.requester_id,
    requesterName: requester?.name ?? null,
    title: t.title,
    description: t.description,
    comment: t.comment,
    severity: t.severity as Severity,
    stage: t.stage as InternalTicket['stage'],
    publicStatus: t.public_status,
    submittedAt: t.submitted_at,
    updatedAt: t.updated_at,
    attachments: flow.attachments(t.ticket_id).map((a) => ({ attachmentId: a.attachment_id, fileName: a.file_name, mime: a.mime, bytes: a.bytes, sha256: a.sha256, scan: a.scan })),
    diagnoses: flow.sessions(t.ticket_id, 'triage').map((s) => ({
      sessionId: s.session_id,
      status: s.status,
      confidence: s.confidence,
      rootCauseClass: s.root_cause_class,
      rootCause: s.root_cause,
      fixPlan: s.fix_plan,
      tokens: s.tokens,
      reportedAt: s.reported_at,
    })),
    buildSessionId: t.build_session_id,
    uatRef: t.uat_ref,
    openDecisionIds: flow.openDecisions(t.ticket_id).map((d) => d.decision_id),
    resolution: t.resolution,
  };
}

function projectExists(ctx: ModuleContext, projectId: string): boolean {
  return !!ctx.db.prepare("SELECT 1 FROM events WHERE type = 'project.created' AND project_id = ? LIMIT 1").get(projectId);
}
function defaultProject(ctx: ModuleContext): string | null {
  return (ctx.db.prepare("SELECT project_id FROM events WHERE type = 'project.created' ORDER BY seq LIMIT 1").get() as { project_id: string } | undefined)?.project_id ?? null;
}

export function createIntakeModule(opts: IntakeModuleOptions = {}): AocModule {
  let flow: IntakeFlow;
  return {
    name: 'intake',
    projectors: [intakeProjector],
    init(ctx) {
      flow = new IntakeFlow(ctx);
    },
    reactors: [
      {
        name: 'intake.triage-on-submit',
        handles: ['intake.submitted'],
        async react(e, _p, ctx) {
          const ticketId = (e.meta as { ticketId: string }).ticketId;
          if (ctx.store.findByCausation(e.id, 'ticket.triage_started').length) return;
          if (flow.sessions(ticketId, 'triage').length) return;
          await flow.startTriage(ticketId, e.id);
        },
      },
      {
        name: 'intake.reconcile',
        handles: ['ticket.diagnosis_reported', 'session.ended'],
        async react(e, _p, ctx) {
          const sessionId = (e.meta as { sessionId: string }).sessionId;
          const link = flow.sessionLink(sessionId);
          if (!link) return;
          if (link.role === 'triage') return flow.reconcile(link.ticket_id, e.id);
          if (e.type === 'session.ended' && link.role === 'build') {
            const t = flow.ticket(link.ticket_id);
            if (!t || t.build_session_id !== sessionId || t.stage !== 'building') return;
            if (ctx.store.findByCausation(e.id, 'ticket.uat_ready').length) return;
            const outcome = (e.meta as { outcome: string }).outcome;
            if (outcome === 'completed') flow.readyForUat(t, e.id);
            else ctx.notify({ kind: 'session.attention', title: `Build for ${t.ticket_id} ended (${outcome}) before UAT`, audience: ['approver', 'builder'], severity: 'warn', refs: { ticketId: t.ticket_id, sessionId } });
          }
        },
      },
      {
        name: 'intake.decisions',
        handles: ['decision.resolved'],
        react: (e) => flow.onDecision(e),
      },
      {
        name: 'intake.promotion',
        handles: ['promotion.completed', 'promotion.refused'],
        react(e, _p, ctx) {
          const promotionId = (e.meta as { promotionId: string }).promotionId;
          const row = ctx.db.prepare('SELECT ticket_id FROM itk_promotions WHERE promotion_id = ?').get(promotionId) as { ticket_id: string } | undefined;
          if (!row) return;
          if (e.type === 'promotion.completed') flow.close(row.ticket_id, 'fixed', INTAKE_ACTOR, 'Promoted to main', e.id);
        },
      },
    ],
    jobs: [
      {
        name: 'intake.diagnosis-budget',
        schedule: { everyMs: 60_000 },
        async run(ctx) {
          const { tokens, minutes } = ctx.config.intake.diagnosisBudget;
          const rows = ctx.db.prepare("SELECT * FROM itk_sessions WHERE role = 'triage' AND status = 'running'").all() as unknown as {
            session_id: string;
            ticket_id: string;
            tokens: number;
            started_at: string;
          }[];
          for (const r of rows) {
            const overTime = ctx.clock.now() - Date.parse(r.started_at) > minutes * 60_000;
            if (r.tokens > tokens || overTime) {
              await ctx.services.maybe('supervisor')?.stop(r.session_id, true, INTAKE_ACTOR, 'diagnosis budget exhausted');
              ctx.store.append({
                type: 'session.blocked',
                actor: INTAKE_ACTOR,
                scope: { sessionId: r.session_id, ticketId: r.ticket_id },
                meta: { sessionId: r.session_id, reason: 'diagnosis_budget' },
                source: 'intake',
              });
              ctx.store.append({
                type: 'session.ended',
                actor: INTAKE_ACTOR,
                scope: { sessionId: r.session_id, ticketId: r.ticket_id },
                meta: { sessionId: r.session_id, outcome: 'killed' },
                source: 'intake',
              });
            }
          }
        },
      },
    ],
    routes(app, ctx) {
      const scanner = opts.scanner ?? scannerFor(ctx.config.intake.scanner);
      const cfg = ctx.config.intake;

      // ── requester portal ────────────────────────────────────────────────────
      app.post('/portal/api/intakes', async (c) => {
        const auth = requirePermission(c, 'intake.submit');
        const form = await c.req.parseBody({ all: true });
        const field = (k: string) => (typeof form[k] === 'string' ? (form[k] as string).trim() : '');
        const title = field('title');
        const description = field('description');
        const comment = field('comment') || undefined;
        const severity = (field('severity') || 'medium') as Severity;
        if (title.length < 3 || title.length > 200) throw new HttpError(422, 'invalid', 'Title must be 3–200 characters');
        if (description.length < 10 || description.length > 20_000) throw new HttpError(422, 'invalid', 'Description must be 10–20000 characters');
        if (!SEVERITIES.includes(severity)) throw new HttpError(422, 'invalid', 'Unknown severity');
        const projectId = field('projectId') || defaultProject(ctx);
        if (!projectId || !projectExists(ctx, projectId)) throw new HttpError(422, 'invalid', 'Unknown product');
        const raw = form['files'] ?? form['files[]'];
        const files = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((f): f is File => typeof f !== 'string');
        if (files.length > cfg.maxAttachments) throw new HttpError(413, 'too_many_files', `At most ${cfg.maxAttachments} attachments`);

        const ticketId = newId('ticket', ctx.clock.now());
        const accepted: { attachmentId: string; sha: string; mime: string; bytes: number; name: string; scan: string; scanner: string; buf: Buffer }[] = [];
        for (const f of files) {
          // Type and size are decided from the magic bytes and the part's size before the file is copied out.
          const kind = sniff(Buffer.from(await f.slice(0, 16).arrayBuffer()));
          if (!kind) throw new HttpError(415, 'unsupported_media', `${safeFileName(f.name)}: only PNG, JPEG, GIF, WebP, MP4, MOV, WebM or PDF are accepted`);
          if (!declaredMatches(f.type, kind)) throw new HttpError(415, 'type_mismatch', `${safeFileName(f.name)}: file content does not match its declared type`);
          const cap = kind.kind === 'video' ? cfg.maxVideoBytes : cfg.maxImageBytes;
          if (f.size > cap) throw new HttpError(413, 'too_large', `${safeFileName(f.name)} exceeds ${Math.round(cap / 1048576)} MB`);
          const buf = Buffer.from(await f.arrayBuffer());
          const scan = scanner.scan(buf);
          if (scan.verdict === 'infected') {
            ctx.log.warn('intake: infected upload rejected', { requester: auth.user.id, scanner: scan.scanner });
            throw new HttpError(422, 'rejected', `${safeFileName(f.name)} was rejected by the malware scanner`);
          }
          if ((scan.verdict === 'unscanned' || scan.verdict === 'error') && cfg.requireScan) {
            throw new HttpError(503, 'scanner_unavailable', 'Attachments cannot be scanned right now; please try again later or submit without attachments');
          }
          accepted.push({ attachmentId: newId('attachment', ctx.clock.now()), sha: sha256(buf), mime: kind.mime, bytes: buf.length, name: safeFileName(f.name), scan: scan.verdict, scanner: scan.scanner, buf });
        }
        // Media bodies are encrypted under the ticket's key scope (PDPA erasure shreds them); the chain holds hashes only.
        for (const a of accepted) ctx.store.bodies.putBlob(a.attachmentId, ticketId, a.buf, ctx.clock.iso());
        const actor = { kind: 'human' as const, id: auth.user.id };
        ctx.store.appendMany([
          ...accepted.map((a) => ({
            type: 'intake.attachment_stored' as const,
            actor,
            scope: { ticketId, projectId },
            meta: { ticketId, attachmentId: a.attachmentId, sha256: a.sha, mime: a.mime, bytes: a.bytes, scan: a.scan as 'clean' | 'unscanned' | 'error', scanner: a.scanner },
            payload: { fileName: a.name },
            source: 'intake' as const,
            bodyScope: ticketId,
          })),
          {
            type: 'intake.submitted' as const,
            actor,
            scope: { ticketId, projectId },
            meta: { ticketId, requesterId: auth.user.id, severity, attachmentCount: accepted.length, attachmentHashes: accepted.map((a) => a.sha) },
            payload: { title, description, ...(comment ? { comment } : {}) },
            source: 'intake' as const,
            bodyScope: ticketId,
          },
        ]);
        const t = flow.ticket(ticketId)!;
        return c.json(publicView(ctx, flow, t), 201);
      });

      app.get('/portal/api/tickets', (c) => {
        const auth = requirePermission(c, 'intake.view_own');
        const rows = ctx.db.prepare('SELECT * FROM itk_tickets WHERE requester_id = ? ORDER BY submitted_at DESC').all(auth.user.id) as unknown as TicketRow[];
        return c.json(rows.map((t) => publicView(ctx, flow, t)));
      });

      const ownTicket = (userId: string, id: string): TicketRow => {
        const t = flow.ticket(id);
        if (!t || t.requester_id !== userId) throw new HttpError(404, 'not_found', 'Ticket not found');
        return t;
      };

      app.get('/portal/api/tickets/:id', (c) => {
        const auth = requirePermission(c, 'intake.view_own');
        return c.json(publicView(ctx, flow, ownTicket(auth.user.id, c.req.param('id'))));
      });

      app.post('/portal/api/tickets/:id/uat', async (c) => {
        const auth = requirePermission(c, 'uat.signoff_own');
        const t = ownTicket(auth.user.id, c.req.param('id'));
        const body = await readJson(c, z.object({ verdict: z.enum(['pass', 'fail']), comment: z.string().max(4000).optional() }));
        const open = flow.openDecisions(t.ticket_id).find((d) => d.kind === 'uat_signoff');
        if (!open) throw new HttpError(409, 'not_ready', 'This ticket is not waiting for your testing');
        await ctx.services.get('decisions').resolve(open.decision_id, { optionId: body.verdict, comment: body.comment ?? null }, auth.user);
        return c.json(publicView(ctx, flow, flow.ticket(t.ticket_id)!));
      });

      // ── agent ingest ────────────────────────────────────────────────────────
      app.post(INGEST_PATHS.mcp('report_diagnosis'), async (c) => {
        const body = await readJson(c, McpBody);
        requireIngest(c, { sessionId: body.sessionId, allowSystem: false });
        const input = ReportDiagnosisInput.safeParse(body.input);
        if (!input.success) return c.json<McpErrorResult>({ ok: false, error: 'invalid input', details: input.error.issues }, 422);
        const link = flow.sessionLink(body.sessionId);
        if (!link || link.role !== 'triage') return c.json<McpErrorResult>({ ok: false, error: 'report_diagnosis is only for triage sessions linked to a ticket' }, 403);
        if (link.status !== 'running') return c.json<McpErrorResult>({ ok: false, error: 'diagnosis already reported for this session' }, 409);
        ctx.store.append({
          type: 'ticket.diagnosis_reported',
          actor: { kind: 'agent', id: body.sessionId },
          scope: { ticketId: link.ticket_id, sessionId: body.sessionId },
          meta: { ticketId: link.ticket_id, sessionId: body.sessionId, confidence: input.data.confidence, rootCauseClass: input.data.root_cause_class ?? null },
          payload: { rootCause: input.data.root_cause, fixPlan: input.data.fix_plan, ...(input.data.affected_areas ? { affectedAreas: input.data.affected_areas } : {}) },
          source: 'mcp',
          bodyScope: link.ticket_id,
        });
        return c.json({ ok: true, next: 'end_turn', instruction: 'Diagnosis recorded. End your turn now.' });
      });

      // ── operator views ──────────────────────────────────────────────────────
      app.get('/api/tickets', (c) => {
        requirePermission(c, 'ticket.view_internal');
        const rows = ctx.db.prepare('SELECT * FROM itk_tickets ORDER BY submitted_at DESC LIMIT 500').all() as unknown as TicketRow[];
        return c.json(rows.map((t) => internalView(ctx, flow, t)));
      });

      app.get('/api/tickets/:id', (c) => {
        requirePermission(c, 'ticket.view_internal');
        const t = flow.ticket(c.req.param('id'));
        if (!t) throw new HttpError(404, 'not_found', 'Ticket not found');
        return c.json(internalView(ctx, flow, t));
      });

      app.get('/api/tickets/:id/attachments/:attachmentId', (c) => {
        const auth = requireUser(c);
        const t = flow.ticket(c.req.param('id'));
        const a = t ? flow.attachments(t.ticket_id).find((x) => x.attachment_id === c.req.param('attachmentId')) : undefined;
        if (!t || !a) throw new HttpError(404, 'not_found', 'Attachment not found');
        let basis: 'media_permission' | 'linked_session' | null = hasPermission(auth.user.role, 'ticket.media_view', auth.user.flags) ? 'media_permission' : null;
        if (!basis && hasPermission(auth.user.role, 'ticket.view_internal', auth.user.flags)) {
          // Developers see raw media only when one of their ACTIVE sessions works on this ticket (§6).
          const sessions = ctx.services.maybe('sessions');
          const linked = flow.sessions(t.ticket_id).some((s) => {
            const info = sessions?.get(s.session_id);
            return info?.ownerId === auth.user.id && !['ended', 'retired', 'failed'].includes(info.lifecycle);
          });
          if (linked) basis = 'linked_session';
        }
        if (!basis) throw new HttpError(403, 'forbidden', 'Raw intake media stays behind the role boundary');
        const bytes = ctx.store.bodies.getBlob(a.attachment_id);
        if (!bytes) throw new HttpError(410, 'erased', 'Attachment was erased');
        ctx.store.append({
          type: 'intake.media_accessed',
          actor: { kind: 'human', id: auth.user.id },
          scope: { ticketId: t.ticket_id },
          meta: { ticketId: t.ticket_id, attachmentId: a.attachment_id, userId: auth.user.id, basis },
          source: 'api',
        });
        return new Response(new Uint8Array(bytes), {
          headers: {
            'content-type': a.mime,
            'content-disposition': `attachment; filename="${a.file_name.replace(/"/g, '')}"`,
            'x-content-type-options': 'nosniff',
            'cache-control': 'no-store',
          },
        });
      });

      app.post('/api/tickets/:id/close', async (c) => {
        const auth = requirePermission(c, 'ticket.view_internal');
        const body = await readJson(c, z.object({ resolution: z.enum(['wont_fix', 'duplicate', 'cannot_reproduce', 'withdrawn']), note: z.string().max(2000).optional() }));
        const t = flow.ticket(c.req.param('id'));
        if (!t) throw new HttpError(404, 'not_found', 'Ticket not found');
        flow.close(t.ticket_id, body.resolution, { kind: 'human', id: auth.user.id }, body.note);
        return c.json(internalView(ctx, flow, flow.ticket(t.ticket_id)!));
      });
    },
  };
}
