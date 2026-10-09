import type { AocConfig, LlmService } from '@aoc/contracts';
import { createLlm } from '@aoc/llm';

/**
 * The `llm` service for `config.fx.extractor` (FX extraction, distillation). Only `fake` gets the kernel's FakeLlm
 * (it fails every unscripted call loudly); an extractor that cannot be built stops aocd at startup instead of
 * degrading to it.
 */
export function resolveLlm(
  config: AocConfig,
  env: Record<string, string | undefined> = process.env,
): LlmService {
  const extractor = config.fx.extractor;
  if (extractor === 'anthropic-sdk' && !env.ANTHROPIC_API_KEY) {
    throw new Error('fx.extractor "anthropic-sdk" needs ANTHROPIC_API_KEY in the environment');
  }
  return createLlm(extractor, {
    // The claude the supervisor runs for sessions (e.g. claude-sim as `node <sim>`), with no session flags.
    claudeBin: config.supervisor.claudeBin,
    extraArgs: config.supervisor.claudeArgsPrefix,
    apiKey: env.ANTHROPIC_API_KEY,
  });
}
