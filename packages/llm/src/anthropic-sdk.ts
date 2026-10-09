import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import {
  MODEL_ID_BY_TIER,
  type JsonValue,
  type LlmJsonRequest,
  type LlmJsonResult,
  type LlmService,
  type ModelTier,
} from '@aoc/contracts';
import { LlmOutputInvalidError, LlmUnavailableError } from './errors';
import { assertMatchesSchema, parseJsonText } from './output';

export interface AnthropicSdkLlmOptions {
  /** Defaults to the SDK's own resolution (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN). */
  apiKey?: string;
  baseURL?: string;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof fetch;
  /** Pre-built client (overrides apiKey/baseURL/fetch). */
  client?: Anthropic;
  timeoutMs?: number;
  maxRetries?: number;
  /** Default max_tokens when the request does not set one. Adaptive thinking counts against it. */
  maxTokens?: number;
  /** output_config.effort; omitted → the model's documented default. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  modelIds?: Partial<Record<ModelTier, string>>;
}

/**
 * Structured JSON via the Messages API for API-key deployments: `output_config.format` json_schema
 * (schema made API-compatible by the SDK helper; the original schema is still enforced locally).
 * No `thinking` or sampling parameters: current models run adaptive thinking by default and reject the rest.
 */
export class AnthropicSdkLlm implements LlmService {
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicSdkLlmOptions = {}) {
    this.client =
      opts.client ??
      new Anthropic({
        ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
        ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
        ...(opts.fetch ? { fetch: opts.fetch } : {}),
        timeout: opts.timeoutMs ?? 60_000,
        maxRetries: opts.maxRetries ?? 2,
      });
  }

  modelId(tier: ModelTier): string {
    return this.opts.modelIds?.[tier] ?? MODEL_ID_BY_TIER[tier];
  }

  async completeJson<T = JsonValue>(req: LlmJsonRequest): Promise<LlmJsonResult<T>> {
    // Moves keywords the API does not enforce (minimum, maxLength, …) into descriptions; throws on non-object schemas.
    const { schema } = jsonSchemaOutputFormat(req.schema as Parameters<typeof jsonSchemaOutputFormat>[0]);
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create({
        model: this.modelId(req.model),
        max_tokens: req.maxTokens ?? this.opts.maxTokens ?? 4096,
        ...(req.system ? { system: req.system } : {}),
        messages: [{ role: 'user', content: req.prompt }],
        output_config: {
          format: { type: 'json_schema', schema },
          ...(this.opts.effort ? { effort: this.opts.effort } : {}),
        },
      });
    } catch (err) {
      const status = err instanceof Anthropic.APIError && typeof err.status === 'number' ? err.status : null;
      throw new LlmUnavailableError(
        `Anthropic API request failed: ${err instanceof Error ? err.message : String(err)}`,
        status,
        { cause: err },
      );
    }
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    if (message.stop_reason === 'refusal') {
      throw new LlmOutputInvalidError('model refused the request', ['$: refusal'], text);
    }
    if (message.stop_reason === 'max_tokens') {
      throw new LlmOutputInvalidError('output truncated at max_tokens', ['$: truncated'], text);
    }
    const data = parseJsonText(text);
    assertMatchesSchema(req.schema, data, text);
    return {
      data: data as T,
      model: message.model,
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      raw: text,
    };
  }
}
