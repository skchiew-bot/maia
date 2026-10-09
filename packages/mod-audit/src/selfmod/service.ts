import { join, resolve } from 'node:path';
import type { SelfModificationService } from '@aoc/contracts';
import type { ModuleContext } from '@aoc/kernel';
import { appendExternalAuditLine } from './external-log';
import { BoundaryMatcher } from './matcher';

/**
 * The self-modification boundary for callers outside a tool call (the promotion gate, §13/R14): the same matcher as
 * the guard, restricted to the core of AOC repos, and the same external log.
 */
export function createSelfModificationService(ctx: ModuleContext): SelfModificationService {
  const cfg = ctx.config.selfModification;
  return {
    coreFiles(repoPath, files) {
      const matcher = new BoundaryMatcher({
        aocRepoPaths: cfg.aocRepoPaths,
        protectedPaths: cfg.protectedPaths,
        auditStorePaths: [],
      });
      const root = matcher.repoOf(resolve(repoPath));
      if (!root) return null;
      return files.filter((f) => matcher.check(join(root, f), root, false)?.area === 'core');
    },
    recordExternal(entry) {
      try {
        appendExternalAuditLine(resolve(cfg.externalAuditLog), {
          ...entry,
          v: 1,
          ts: ctx.clock.iso(),
          chainId: ctx.store.chainId,
        });
        return true;
      } catch (err) {
        ctx.log.error('self-modification: external audit log write failed', { err: String(err) });
        return false;
      }
    },
  };
}
