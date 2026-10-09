import type { AocModule, Job, ModuleContext } from '@aoc/kernel';
import type { AuditModuleOptions } from './options';
import { auditProjector } from './projector';
import { registerAuditRoutes } from './routes';
import { createSelfModificationGuard } from './selfmod/guard';
import { AuditService, tsrDirOf } from './service';

export type { AuditModuleOptions, TsaFetch } from './options';
export { AuditService, tsrDirOf, type AnchorOutcome } from './service';
export { anchorFileName, parseAnchor, serializeAnchor, type AnchorRecord } from './anchor-record';
export { parseTsReplyText } from './anchor/rfc3161';
export { BoundaryMatcher, type BoundaryConfig, type ProtectedHit } from './selfmod/matcher';
export { analyzeBash } from './selfmod/shell';
export { boundaryConfig, findViolation, SELF_MODIFICATION_GUARD } from './selfmod/guard';
export { verifyExternalAuditLog } from './selfmod/external-log';
export { governedSources, detectConfigChanges, ABSENT_HASH } from './config-watch';
export { payloadAccess, isTicketBody } from './visibility';

/**
 * Audit integrity (§13, R2, R6, R14): off-host anchors (git / RFC 3161) with a nightly job, verify-against-anchor,
 * crypto-shred erasure, the self-modification boundary guard, governed-config change detection and the audit
 * read APIs.
 */
export function createAuditModule(opts: AuditModuleOptions = {}): AocModule & { service(): AuditService } {
  let ctxRef: ModuleContext | null = null;
  let svc: AuditService | null = null;
  const jobs: Job[] = [];
  const service = (): AuditService => {
    if (!svc) throw new Error('audit module not initialised');
    return svc;
  };
  return {
    name: 'audit',
    projectors: [auditProjector],
    guards: [
      createSelfModificationGuard({
        ctx: () => ctxRef,
        tsrDir: () => (ctxRef ? (tsrDirOf(ctxRef.dataDir, opts) ?? undefined) : undefined),
      }),
    ],
    jobs,
    service,
    init(ctx) {
      ctxRef = ctx;
      svc = new AuditService(ctx, opts);
      ctx.services.provide('audit', svc);
      // Nightly: governed-config check, anchor the head off-host, verify against every anchor.
      jobs.push({
        name: 'audit.anchor',
        schedule: { dailyAt: ctx.config.audit.anchorAtLocalTime },
        run: () => service().nightly(),
      });
    },
    routes(app, ctx) {
      registerAuditRoutes(app, ctx, service);
    },
    start() {
      service().detectConfig('system');
    },
  };
}
