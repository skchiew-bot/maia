/**
 * mod-ledger — the build ledger (AOC-SPEC-003 §1, §4, §5, §8, §9): projects, durable threads with a single
 * writer, plan manifests, evidence-backed tasks, phases pinned to immutable tags, drift, enhancements,
 * timelines and rollover briefs.
 */
import type { AocModule } from '@aoc/kernel';
import { LedgerCore, resolveOptions, type LedgerModuleOptions } from './core';
import { createDriftReactor, createOverrunJob } from './drift';
import { createNoManifestGuard } from './guards';
import { createWriterReleaseReactor } from './projects';
import { createLedgerProjector } from './projector';
import { mountLedgerRoutes } from './routes';
import { LedgerServiceImpl } from './service';

export type { LedgerModuleOptions } from './core';
export { NO_MANIFEST_REASON } from './guards';
export { LEDGER_TABLES } from './projector';
export { phaseTagName, isPlausibleTestId, DEFAULT_OVERRUN_BUDGET_MIN } from './rules';

export function createLedgerModule(opts: LedgerModuleOptions = {}): AocModule {
  const core = new LedgerCore(resolveOptions(opts));
  return {
    name: 'ledger',
    projectors: [createLedgerProjector()],
    guards: [createNoManifestGuard(core)],
    reactors: [createDriftReactor(core), createWriterReleaseReactor(core)],
    jobs: [createOverrunJob(core)],
    init(ctx) {
      core.attach(ctx);
      ctx.services.provide('ledger', new LedgerServiceImpl(core));
    },
    routes(app) {
      mountLedgerRoutes(app, core);
    },
  };
}
