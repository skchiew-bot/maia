import type { ModelTier } from '@aoc/contracts';
import type { AocModule } from '@aoc/kernel';
import { resolveRates, type TokenRate } from './costs';
import { RegistryEngine } from './engine';
import { createKnowledgeProjector } from './knowledge';
import { createPlaybooksProjector, createRunsProjector } from './projections';
import { loadRegistryFile } from './registry-file';
import { registerRoutes } from './routes';

export interface RegistryModuleOptions {
  /** Overrides `config.registryFile` (resolved against the process cwd). */
  registryFile?: string;
  /** USD per MTok by tier for the token-based cost estimate (used when no MeteringService is loaded). */
  rates?: Partial<Record<ModelTier, TokenRate>>;
  /** Weeks in the economics trend sparkline (default 8). */
  trendWeeks?: number;
}

/**
 * Process-type registry module: the fixed registry and model routing (§2.2, §10), the distillation
 * engine for playbooks (§11), registry economics for the Registry hero (§12) and the team knowledge
 * layer (§14). Provides the `registry` service.
 */
export function createRegistryModule(opts: RegistryModuleOptions = {}): AocModule {
  let engine: RegistryEngine | null = null;
  const ready = (): RegistryEngine => {
    if (!engine) throw new Error('registry module used before init');
    return engine;
  };
  return {
    name: 'registry',
    projectors: [createRunsProjector(), createPlaybooksProjector(), createKnowledgeProjector()],
    reactors: [
      {
        name: 'registry.playbook-decisions',
        handles: ['decision.resolved', 'decision.withdrawn', 'decision.expired'],
        react: (e) => ready().onDecision(e),
      },
    ],
    init(ctx) {
      // Throws on an unreadable or invalid registry: aocd must not start with an unknown fixed list.
      const loaded = loadRegistryFile(opts.registryFile ?? ctx.config.registryFile);
      engine = new RegistryEngine(ctx, loaded, {
        rates: resolveRates(opts.rates),
        trendWeeks: opts.trendWeeks ?? 8,
      });
      ctx.services.provide('registry', engine.service());
      engine.recordRegistryChange();
    },
    routes(app) {
      registerRoutes(app, ready());
    },
  };
}

export { DEFAULT_RATES, estimateCostUsd, type TokenRate } from './costs';
export { candidateSteps, digestRun, fileArea, type RunDigest } from './distill';
export { computeRegistryEntries, runKind, weekStarts } from './economics';
export { diffRegistries, loadRegistryFile, RegistryFileError, type LoadedRegistry } from './registry-file';
