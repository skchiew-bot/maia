import { AocConfigSchema, type LlmJsonRequest } from '@aoc/contracts';
import { createLogger, FakeLlm } from '@aoc/kernel';
import { AnthropicSdkLlm, ClaudeCliLlm } from '@aoc/llm';
import { createLearningModule } from '@aoc/mod-learning';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveLlm } from '../src/llm';
import { bootTestServer, removeTempDirs, type TestServer } from './helpers';

const servers: TestServer[] = [];
afterEach(async () => {
  for (const t of servers.splice(0)) await t.close();
  removeTempDirs();
});

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

  it('answers the learning passes of the fake extractor with "nothing to report", and fails every other call loudly', async () => {
    const llm = resolveLlm(config('fake'), {});
    const ask = (purpose: string): Promise<unknown> =>
      llm.completeJson({ model: 'haiku', purpose, prompt: 'p', schema: { type: 'object' } } satisfies LlmJsonRequest);
    await expect(ask('learning.classify')).resolves.toMatchObject({ data: { classId: null, newClass: null, confidence: 0 } });
    await expect(ask('learning.distill')).resolves.toMatchObject({ data: { skip: true } });
    await expect(ask('fx.extract')).rejects.toThrow(/no response for fx\.extract/);
  });

  it('builds the SDK adapter from ANTHROPIC_API_KEY and refuses to start without it', () => {
    expect(resolveLlm(config('anthropic-sdk'), { ANTHROPIC_API_KEY: 'sk-test' })).toBeInstanceOf(
      AnthropicSdkLlm,
    );
    expect(() => resolveLlm(config('anthropic-sdk'), {})).toThrow(/needs ANTHROPIC_API_KEY/);
  });
});


describe('a demo daemon (fx.extractor "fake") running the error-learning passes', () => {
  it('logs nothing for errors it cannot classify, and leaves them unassigned', async () => {
    const lines: string[] = [];
    const t = await bootTestServer({ modules: [createLearningModule()], log: createLogger({ level: 'warn', sink: (l) => lines.push(l) }) });
    servers.push(t);
    const learning = t.aoc.runtime.services.get('learning');
    for (const message of ['TypeError: cannot read properties of undefined (reading id)', 'ECONNRESET while uploading receipt']) {
      learning.recordError({ source: 'tool', message, projectId: 'prj_demo' }, { kind: 'system', id: 'test' });
    }
    await t.aoc.runtime.drain();
    await t.aoc.runtime.runJob('learning.ai');
    await t.aoc.runtime.runJob('learning.ai'); // a second pass does not ask again
    expect(lines.filter((l) => l.includes('learning.'))).toEqual([]);
    expect(t.aoc.runtime.store.list({ types: ['error.observed'] })).toHaveLength(2);
    expect(t.aoc.runtime.store.list({ types: ['rootcause.assigned'] })).toEqual([]);
  });
});
