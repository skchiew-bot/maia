import type { LlmService } from '@aoc/contracts';
import type { AocModule } from '@aoc/kernel';
import { createLlm } from '@aoc/llm';
import { FX_SYSTEM_ACTOR, FxEngine } from './engine';
import { FxReadModel, fxProjector } from './read-model';
import { mountFxRoutes } from './routes';
import { createFxService } from './service';
import { createHttpFetcher, type FxFetcher } from './source';

export interface FxModuleOptions {
  /** HTTP GET used for the BNM page and the BNM Open API (default: global fetch). */
  fetcher?: FxFetcher;
  /** Extraction LLM (default: the registered `llm` service, else `createLlm(config.fx.extractor)`). */
  llm?: LlmService;
}

/** FX (§10): daily BNM USD/MYR via Haiku → Sonnet with validation, reconciliation, carry-forward and discrepancy tickets. */
export function createFxModule(opts: FxModuleOptions = {}): AocModule {
  let engine: FxEngine | undefined;
  let model: FxReadModel | undefined;
  const mod: AocModule = {
    name: 'fx',
    projectors: [fxProjector],
    reactors: [
      {
        name: 'fx.discrepancy_resolution',
        handles: ['decision.resolved'],
        react: (e) => engine?.onDecisionResolved(e),
      },
    ],
    init(ctx) {
      model = new FxReadModel(ctx.db);
      let fallback: LlmService | undefined;
      const llm = () =>
        opts.llm ??
        ctx.services.maybe('llm') ??
        (fallback ??= createLlm(ctx.config.fx.extractor, {
          claudeBin: ctx.config.supervisor.claudeBin,
          extraArgs: ctx.config.supervisor.claudeArgsPrefix,
        }));
      const e = new FxEngine(ctx, model, { fetcher: opts.fetcher ?? createHttpFetcher(), llm });
      engine = e;
      ctx.services.provide('fx', createFxService(model));
      const cfg = ctx.config.fx;
      mod.jobs = cfg.enabled
        ? [
            {
              name: 'fx.daily',
              schedule: { dailyAt: cfg.runAtLocalTime },
              run: async () => void (await e.run({ actor: FX_SYSTEM_ACTOR, source: 'scheduler' })),
            },
            ...cfg.retryAtLocalTimes.map((time) => ({
              name: `fx.retry@${time}`,
              schedule: { dailyAt: time },
              run: async () =>
                void (await e.run({ actor: FX_SYSTEM_ACTOR, source: 'scheduler', retry: true })),
            })),
          ]
        : [];
    },
    routes(app, ctx) {
      mountFxRoutes(app, ctx, engine!, model!);
    },
    async stop() {
      await engine?.idle();
    },
  };
  return mod;
}

export { FX_SYSTEM_ACTOR } from './engine';
export { FX_EXTRACT_PURPOSE, FX_EXTRACTION_SCHEMA } from './extract';
export {
  BNM_API_ACCEPT,
  BNM_PAGE_SESSION,
  bnmApiDateUrl,
  createHttpFetcher,
  htmlToText,
  parseBnmUsd,
  type BnmUsdQuote,
  type FxFetcher,
  type FxHttpRequest,
  type FxHttpResponse,
} from './source';
