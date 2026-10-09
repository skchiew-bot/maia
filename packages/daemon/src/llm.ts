import type { AocConfig, LlmService } from '@aoc/contracts';
import { FakeLlm } from '@aoc/kernel';
import { createLlm } from '@aoc/llm';

/**
 * The fake extractor's canned answers, for the background passes of the error-learning module that call a model on a
 * schedule: nothing could be classified or distilled. Without them every pass would log a failure per error it could
 * not classify, which is all a demo's log would show.
 */
function cannedFake(): FakeLlm {
  return new FakeLlm()
    .on('learning.classify', { classId: null, newClass: null, confidence: 0 })
    .on('learning.distill', { skip: true });
}

/**
 * The `llm` service for `config.fx.extractor` (FX extraction, distillation). Only `fake` gets the kernel's FakeLlm
 * (canned answers for the learning passes above, a loud failure for every other call); an extractor that cannot be
 * built stops aocd at startup instead of degrading to it.
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
    fake: extractor === 'fake' ? cannedFake() : undefined,
  });
}
