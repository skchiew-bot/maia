import { describe, expect, it } from 'vitest';
import type { LlmJsonRequest } from '@aoc/contracts';
import {
  AnthropicSdkLlm,
  ClaudeCliLlm,
  createLlm,
  FakeLlm,
  LlmOutputInvalidError,
  LlmUnavailableError,
} from '../src';
import { FakeLlm as KernelFakeLlm } from '@aoc/kernel';

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
}

/** Injected fetch: every request is captured; no network. */
function fakeFetch(respond: (c: Captured) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const c = {
      url: String(input),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    };
    calls.push(c);
    return respond(c);
  };
  return { fetch: impl as typeof fetch, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
  });
const message = (text: string, stop_reason = 'end_turn') => ({
  id: 'msg_01',
  type: 'message',
  role: 'assistant',
  model: 'claude-haiku-5-5',
  content: [{ type: 'text', text }],
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 900, output_tokens: 40 },
});

const schema = {
  type: 'object',
  properties: { usdMyr: { type: 'number', minimum: 1 }, publishedDate: { type: 'string' } },
  required: ['usdMyr', 'publishedDate'],
};
const req: LlmJsonRequest = {
  model: 'haiku',
  purpose: 'fx.extract',
  system: 'Extract.',
  prompt: 'USD 4.2130',
  schema,
};

describe('AnthropicSdkLlm', () => {
  it('sends a structured-output Messages request with documented defaults and validates the reply', async () => {
    const f = fakeFetch(() => json(200, message('{"usdMyr":4.213,"publishedDate":"2026-10-09"}')));
    const llm = new AnthropicSdkLlm({ apiKey: 'sk-test', fetch: f.fetch, maxRetries: 0 });
    const out = await llm.completeJson(req);

    expect(out).toMatchObject({
      data: { usdMyr: 4.213, publishedDate: '2026-10-09' },
      model: 'claude-haiku-5-5',
      usage: { inputTokens: 900, outputTokens: 40 },
    });
    expect(f.calls).toHaveLength(1);
    const { url, body, headers } = f.calls[0]!;
    expect(url).toMatch(/\/v1\/messages$/);
    expect(headers.get('x-api-key')).toBe('sk-test');
    expect(body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 4096,
      system: 'Extract.',
      messages: [{ role: 'user', content: 'USD 4.2130' }],
    });
    // Adaptive thinking is the default on current models; budget/sampling params would be rejected.
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('temperature');
    const format = (body.output_config as { format: { type: string; schema: Record<string, unknown> } })
      .format;
    expect(format.type).toBe('json_schema');
    expect(format.schema.additionalProperties).toBe(false);
    expect((format.schema.properties as Record<string, Record<string, unknown>>).usdMyr).not.toHaveProperty(
      'minimum',
    );
  });

  it('still enforces constraints the API does not (locally) and passes effort / maxTokens through', async () => {
    const f = fakeFetch(() => json(200, message('{"usdMyr":0.5,"publishedDate":"2026-10-09"}')));
    const llm = new AnthropicSdkLlm({ apiKey: 'sk-test', fetch: f.fetch, maxRetries: 0, effort: 'low' });
    const err = await llm.completeJson({ ...req, model: 'sonnet', maxTokens: 1024 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmOutputInvalidError);
    expect((err as LlmOutputInvalidError).problems).toEqual(['$.usdMyr: must be >= 1']);
    expect(f.calls[0]!.body).toMatchObject({
      model: 'claude-sonnet-5-5',
      max_tokens: 1024,
      output_config: { effort: 'low' },
    });
  });

  it('maps refusals and truncation to invalid output', async () => {
    const refused = fakeFetch(() => json(200, message('', 'refusal')));
    await expect(
      new AnthropicSdkLlm({ apiKey: 'k', fetch: refused.fetch, maxRetries: 0 }).completeJson(req),
    ).rejects.toThrow(/refused/);
    const cut = fakeFetch(() => json(200, message('{"usdMyr":4.2', 'max_tokens')));
    await expect(
      new AnthropicSdkLlm({ apiKey: 'k', fetch: cut.fetch, maxRetries: 0 }).completeJson(req),
    ).rejects.toBeInstanceOf(LlmOutputInvalidError);
  });

  it('maps API and network failures to unavailable', async () => {
    const denied = fakeFetch(() =>
      json(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }),
    );
    const err = await new AnthropicSdkLlm({ apiKey: 'bad', fetch: denied.fetch, maxRetries: 0 })
      .completeJson(req)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmUnavailableError);
    expect((err as LlmUnavailableError).status).toBe(401);

    const offline = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const err2 = await new AnthropicSdkLlm({ apiKey: 'k', fetch: offline.fetch, maxRetries: 0 })
      .completeJson(req)
      .catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(LlmUnavailableError);
    expect((err2 as LlmUnavailableError).status).toBeNull();
  });
});

describe('createLlm', () => {
  it('builds the adapter named by config; fake is the kernel FakeLlm', async () => {
    expect(createLlm('claude-cli', { claudeBin: 'claude' })).toBeInstanceOf(ClaudeCliLlm);
    expect(createLlm('anthropic-sdk', { apiKey: 'k' })).toBeInstanceOf(AnthropicSdkLlm);
    expect(FakeLlm).toBe(KernelFakeLlm);
    const scripted = new FakeLlm().on('fx.extract@haiku', { usdMyr: 4.2 });
    expect(createLlm('fake', { fake: scripted })).toBe(scripted);
    const fresh = createLlm('fake');
    expect(fresh).toBeInstanceOf(FakeLlm);
    await expect(fresh.completeJson(req)).rejects.toThrow(/no response/);
  });
});
