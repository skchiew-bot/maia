import { AocConfigSchema } from '@aoc/contracts';
import { FakeLlm } from '@aoc/kernel';
import { AnthropicSdkLlm, ClaudeCliLlm } from '@aoc/llm';
import { describe, expect, it } from 'vitest';
import { resolveLlm } from '../src/llm';

const config = (
  extractor: 'claude-cli' | 'anthropic-sdk' | 'fake',
  supervisor: Record<string, unknown> = {},
) => AocConfigSchema.parse({ fx: { extractor }, supervisor });

describe('resolveLlm', () => {
  it('runs the claude the supervisor runs, with its argument prefix (e.g. claude-sim under node)', () => {
    const llm = resolveLlm(
      config('claude-cli', { claudeBin: 'node', claudeArgsPrefix: ['/opt/sim/claude-sim.mjs'] }),
      {},
    );
    expect(llm).toBeInstanceOf(ClaudeCliLlm);
    const { args } = (llm as ClaudeCliLlm).invocation({
      model: 'haiku',
      purpose: 'fx.extract',
      prompt: 'Rate?',
      schema: { type: 'object' },
    });
    expect(args.slice(0, 2)).toEqual(['/opt/sim/claude-sim.mjs', '-p']);
  });

  it('uses the FakeLlm only when the extractor is "fake"', () => {
    expect(resolveLlm(config('fake'), {})).toBeInstanceOf(FakeLlm);
    expect(resolveLlm(config('claude-cli'), {})).not.toBeInstanceOf(FakeLlm);
  });

  it('builds the SDK adapter from ANTHROPIC_API_KEY and refuses to start without it', () => {
    expect(resolveLlm(config('anthropic-sdk'), { ANTHROPIC_API_KEY: 'sk-test' })).toBeInstanceOf(
      AnthropicSdkLlm,
    );
    expect(() => resolveLlm(config('anthropic-sdk'), {})).toThrow(/needs ANTHROPIC_API_KEY/);
  });
});
