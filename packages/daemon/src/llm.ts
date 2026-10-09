import type { AocConfig, LlmService } from '@aoc/contracts';
import { FakeLlm, type Logger } from '@aoc/kernel';

type CreateLlm = (
  extractor: AocConfig['fx']['extractor'],
  opts: Record<string, unknown>,
) => LlmService | Promise<LlmService>;

/**
 * The `llm` service from @aoc/llm's `createLlm(config.fx.extractor, …)`. Imported dynamically so the
 * daemon builds before that package exports it; until then (or if it throws) the kernel FakeLlm is
 * used, which fails every call loudly, so LLM-backed jobs (FX extraction, distillation) report errors.
 */
export async function resolveLlm(config: AocConfig, log: Logger): Promise<LlmService> {
  const { createLlm } = (await import('@aoc/llm')) as unknown as { createLlm?: CreateLlm };
  if (typeof createLlm !== 'function') {
    log.warn('@aoc/llm does not export createLlm yet; using the FakeLlm (LLM-backed jobs will fail)');
    return new FakeLlm();
  }
  try {
    return await createLlm(config.fx.extractor, {
      claudeBin: config.supervisor.claudeBin,
      claudeArgsPrefix: config.supervisor.claudeArgsPrefix,
      log: log.child({ component: 'llm' }),
    });
  } catch (err) {
    log.error('createLlm failed; using the FakeLlm (LLM-backed jobs will fail)', {
      extractor: config.fx.extractor,
      err: String(err),
    });
    return new FakeLlm();
  }
}
