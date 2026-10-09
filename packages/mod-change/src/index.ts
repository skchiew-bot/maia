import type { JsonValue, StoredEvent } from '@aoc/contracts';
import type { AocModule, Reactor } from '@aoc/kernel';
import { ChangeEngine, type ChangeModuleOptions } from './engine';
import { createProtectedOpGuard } from './guard';
import { changeProjector } from './projection';
import { mountChangeRoutes } from './routes';

export type { ChangeModuleOptions, ProjectSettings } from './engine';
export { ChangeEngine } from './engine';
export { acceptanceCommandOf, parseTestCounts } from './acceptance';
export { assessAffirmation, editDistance, editRatio } from './governance';
export {
  DEFAULT_PROTECTED_BRANCHES,
  createProtectedOpGuard,
  matchProtectedOperation,
  splitShell,
  type ProtectedHit,
} from './guard';
export { classifyCommit, parseTrailers } from './provenance';

export interface ChangeModule extends AocModule {
  readonly engine: ChangeEngine;
  /** Resolves once background work (rollback verifications) has finished — for tests and orderly shutdown. */
  whenIdle(): Promise<void>;
}

const STOP_GRACE_MS = 10_000;

/**
 * Reactors yield once before touching the store: AocRuntime.drain() records its loop only after the first
 * reaction's synchronous part, so an append made there would start a second loop that drain() does not track.
 */
function reactor(
  name: string,
  handles: string[],
  run: (e: StoredEvent, payload: JsonValue | null) => unknown,
): Reactor {
  return {
    name,
    handles,
    async react(e, payload) {
      await Promise.resolve();
      await run(e, payload);
    },
  };
}

/**
 * Change control (§8, §14): change records, gated rollback, break-glass, the provenance-guaranteed promotion
 * path and the `protected-op` PreToolUse guard. Provides the `change` service.
 */
export function createChangeModule(opts: ChangeModuleOptions = {}): ChangeModule {
  const engine = new ChangeEngine(opts);
  return {
    name: 'change',
    engine,
    projectors: [changeProjector],
    guards: [
      createProtectedOpGuard({
        protectedBranches: opts.protectedBranches,
        currentBranch: (dir) => engine.currentBranch(dir),
      }),
    ],
    reactors: [
      reactor('change.decision-resolved', ['decision.resolved'], (e, payload) =>
        engine.onDecisionResolved(e, payload),
      ),
      reactor('change.rollback-verify', ['rollback.requested'], (e) =>
        engine.scheduleVerification(String(e.meta.rollbackId), e.id),
      ),
      reactor('change.rollback-execute', ['rollback.approved'], (e) =>
        engine.executeRollback(String(e.meta.rollbackId), e.id),
      ),
      // Order matters: the emergency promotion runs before the (LLM-drafted) post-incident record.
      reactor('change.breakglass-promote', ['breakglass.approved'], (e) =>
        engine.promoteBreakglass(String(e.meta.breakglassId), e.id),
      ),
      reactor('change.breakglass-post-incident', ['breakglass.approved'], (e) =>
        engine.draftPostIncident(String(e.meta.breakglassId), e.id),
      ),
    ],
    jobs: [
      {
        name: 'change.breakglass-overdue',
        schedule: { everyMs: 10 * 60_000 },
        run: () => engine.checkOverdue(),
      },
    ],
    init(ctx) {
      engine.bind(ctx);
      ctx.services.provide('change', engine);
    },
    routes(app) {
      mountChangeRoutes(app, engine);
    },
    start() {
      engine.resumePending();
    },
    async stop() {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        engine.whenIdle(),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, STOP_GRACE_MS))),
      ]);
      clearTimeout(timer);
      engine.dispose();
    },
    whenIdle: () => engine.whenIdle(),
  };
}
