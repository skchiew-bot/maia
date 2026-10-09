import type { LlmService } from '@aoc/contracts';
import { FakeLlm } from '@aoc/kernel';
import { AnthropicSdkLlm, type AnthropicSdkLlmOptions } from './anthropic-sdk';
import { ClaudeCliLlm, type ClaudeCliLlmOptions } from './claude-cli';

export type LlmKind = 'claude-cli' | 'anthropic-sdk' | 'fake';

/** Options for every kind (each adapter reads its own fields; timeoutMs and modelIds are shared). */
export type CreateLlmOptions = ClaudeCliLlmOptions & AnthropicSdkLlmOptions & { fake?: FakeLlm };

/** Pick the adapter named by config (e.g. `config.fx.extractor`). 'fake' is the kernel's scripted FakeLlm. */
export function createLlm(kind: LlmKind, opts: CreateLlmOptions = {}): LlmService {
  switch (kind) {
    case 'claude-cli':
      return new ClaudeCliLlm(opts);
    case 'anthropic-sdk':
      return new AnthropicSdkLlm(opts);
    case 'fake':
      return opts.fake ?? new FakeLlm();
  }
}

export { FakeLlm };
