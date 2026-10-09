import { CONTEXT_WINDOW_TOKENS, DEFAULT_MODEL_ALIAS, MAX_OUTPUT_TOKENS, MODEL_ALIASES } from './constants';

/** Map an alias (opus, sonnet, haiku, fable, optionally with a [1m] suffix) to a model id; ids pass through. */
export function resolveModel(input: string | undefined): string {
  const raw = (input ?? DEFAULT_MODEL_ALIAS).trim().replace(/\[1m\]$/i, '');
  return MODEL_ALIASES[raw.toLowerCase()] ?? raw;
}

/** `message.usage` exactly as Claude Code writes it into transcripts and stream-json. */
export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  server_tool_use: { web_search_requests: number; web_fetch_requests: number };
  service_tier: 'standard';
  cache_creation: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number };
}

export interface UsageParts {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export function makeUsage(parts: UsageParts): Usage {
  return {
    input_tokens: parts.input,
    cache_creation_input_tokens: parts.cacheWrite,
    cache_read_input_tokens: parts.cacheRead,
    output_tokens: parts.output,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    // Claude Code's main thread writes the 1-hour cache.
    cache_creation: { ephemeral_1h_input_tokens: parts.cacheWrite, ephemeral_5m_input_tokens: 0 },
  };
}

interface Price {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Notional API-equivalent USD per million tokens (1-hour cache writes). */
const PRICES: Readonly<Record<string, Price>> = {
  opus: { input: 5, output: 25, cacheWrite: 10, cacheRead: 0.5 },
  fable: { input: 5, output: 25, cacheWrite: 10, cacheRead: 0.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 6, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 2, cacheRead: 0.1 },
};

function familyOf(model: string): string | undefined {
  return Object.keys(PRICES).find((name) => model.includes(name));
}

function priceFor(model: string): Price {
  return PRICES[familyOf(model) ?? 'sonnet']!;
}

export function costUsd(model: string, usage: Usage): number {
  const price = priceFor(model);
  return (
    (usage.input_tokens * price.input +
      usage.output_tokens * price.output +
      usage.cache_creation_input_tokens * price.cacheWrite +
      usage.cache_read_input_tokens * price.cacheRead) /
    1_000_000
  );
}

/** What re-caching `tokens` of context would cost on `model` (SessionStart's estimated_cache_write_usd). */
export function cacheWriteUsd(model: string, tokens: number): number {
  return roundUsd((tokens * priceFor(model).cacheWrite) / 1_000_000);
}

const roundUsd = (value: number): number => Math.round(value * 1e6) / 1e6;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface ModelCost {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
}

/** Body of the `cost-state` transcript line: cumulative for the whole session, across --resume. */
export interface CostState {
  totalCostUSD: number;
  totalAPIDuration: number;
  totalAPIDurationWithoutRetries: number;
  totalToolDuration: number;
  totalLinesAdded: number;
  totalLinesRemoved: number;
  totalDuration: number;
  startTime: number;
  modelUsage: Record<string, ModelCost>;
  hasUnknownModelCost: boolean;
}

const emptyModelCost = (): ModelCost => ({
  inputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  webSearchRequests: 0,
  costUSD: 0,
});

function mergeModelCosts(...sources: Record<string, ModelCost>[]): Record<string, ModelCost> {
  const out: Record<string, ModelCost> = {};
  for (const source of sources) {
    for (const [model, cost] of Object.entries(source)) {
      const into = (out[model] ??= emptyModelCost());
      for (const key of Object.keys(into) as (keyof ModelCost)[]) into[key] += cost[key] ?? 0;
    }
  }
  return out;
}

/**
 * Spend and usage bookkeeping. `usage` in the result covers this invocation only; `total_cost_usd`,
 * `modelUsage` and the `cost-state` line are cumulative, restored from the previous cost-state on resume.
 */
export class CostLedger {
  private readonly current: Record<string, ModelCost> = {};
  private readonly invocation = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private apiMs = 0;
  private toolMs = 0;
  private linesAdded = 0;
  private linesRemoved = 0;

  constructor(private readonly restored: CostState | null) {}

  addResponse(model: string, usage: Usage, thinkingTokens: number, durationMs: number): void {
    const cost = (this.current[model] ??= emptyModelCost());
    cost.inputTokens += usage.input_tokens;
    cost.outputTokens += usage.output_tokens;
    cost.thinkingTokens += thinkingTokens;
    cost.cacheReadInputTokens += usage.cache_read_input_tokens;
    cost.cacheCreationInputTokens += usage.cache_creation_input_tokens;
    cost.costUSD += costUsd(model, usage);
    this.invocation.input += usage.input_tokens;
    this.invocation.output += usage.output_tokens;
    this.invocation.cacheRead += usage.cache_read_input_tokens;
    this.invocation.cacheWrite += usage.cache_creation_input_tokens;
    this.apiMs += durationMs;
  }

  addTool(durationMs: number, linesAdded = 0, linesRemoved = 0): void {
    this.toolMs += durationMs;
    this.linesAdded += linesAdded;
    this.linesRemoved += linesRemoved;
  }

  /** Spend of this invocation (what --max-budget-usd limits). */
  get invocationCostUsd(): number {
    return roundUsd(Object.values(this.current).reduce((sum, cost) => sum + cost.costUSD, 0));
  }

  get invocationApiMs(): number {
    return this.apiMs;
  }

  invocationUsage(): Usage {
    return makeUsage(this.invocation);
  }

  cumulativeCostUsd(): number {
    return roundUsd((this.restored?.totalCostUSD ?? 0) + this.invocationCostUsd);
  }

  /** The result message's `modelUsage` (cumulative). */
  resultModelUsage(): Record<string, Record<string, number>> {
    const merged = mergeModelCosts(this.restored?.modelUsage ?? {}, this.current);
    return Object.fromEntries(
      Object.entries(merged).map(([model, cost]) => [
        model,
        {
          inputTokens: cost.inputTokens,
          outputTokens: cost.outputTokens,
          cacheReadInputTokens: cost.cacheReadInputTokens,
          cacheCreationInputTokens: cost.cacheCreationInputTokens,
          webSearchRequests: cost.webSearchRequests,
          costUSD: roundUsd(cost.costUSD),
          contextWindow: CONTEXT_WINDOW_TOKENS,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        },
      ]),
    );
  }

  costState(invocationMs: number, invocationStart: number): CostState {
    const modelUsage = mergeModelCosts(this.restored?.modelUsage ?? {}, this.current);
    for (const cost of Object.values(modelUsage)) cost.costUSD = roundUsd(cost.costUSD);
    const apiMs = (this.restored?.totalAPIDuration ?? 0) + this.apiMs;
    return {
      totalCostUSD: this.cumulativeCostUsd(),
      totalAPIDuration: apiMs,
      totalAPIDurationWithoutRetries: apiMs,
      totalToolDuration: (this.restored?.totalToolDuration ?? 0) + this.toolMs,
      totalLinesAdded: (this.restored?.totalLinesAdded ?? 0) + this.linesAdded,
      totalLinesRemoved: (this.restored?.totalLinesRemoved ?? 0) + this.linesRemoved,
      totalDuration: (this.restored?.totalDuration ?? 0) + invocationMs,
      startTime: this.restored?.startTime ?? invocationStart,
      modelUsage,
      hasUnknownModelCost:
        (this.restored?.hasUnknownModelCost ?? false) ||
        Object.keys(this.current).some((model) => !familyOf(model)),
    };
  }
}

/** The cached-context model behind every request's cache-read / cache-write numbers (persisted per session). */
export interface ContextState {
  /** Tokens already in the prompt cache (read on the next request). */
  cachedPrefix: number;
  /** Tokens appended since the last request (written to the cache by the next one). */
  uncached: number;
  lastRequestAt: number | null;
}

/** System prompt share that is a global cache hit even on a cold session. */
export const SHARED_PREFIX_TOKENS = 9_000;
/** Session-specific system prompt and built-in tool definitions. */
export const SESSION_PREFIX_TOKENS = 6_500;
const DEFAULT_INPUT_TOKENS = 3;
export const CACHE_TTL_MS = 60 * 60 * 1000;

export function freshContext(extraPrefixTokens: number): ContextState {
  return { cachedPrefix: 0, uncached: SESSION_PREFIX_TOKENS + extraPrefixTokens, lastRequestAt: null };
}

export interface RequestShape {
  inputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** Usage numbers (minus output) for the next request, advancing the context state. */
export function nextRequest(
  context: ContextState,
  shape: RequestShape,
  now: number,
): Omit<UsageParts, 'output'> {
  if (context.lastRequestAt !== null && now - context.lastRequestAt > CACHE_TTL_MS) {
    // The 1-hour cache expired: everything but the global prefix must be written again.
    context.uncached += Math.max(0, context.cachedPrefix - SHARED_PREFIX_TOKENS);
    context.cachedPrefix = SHARED_PREFIX_TOKENS;
  }
  if (context.cachedPrefix === 0) context.cachedPrefix = SHARED_PREFIX_TOKENS;
  const parts = {
    input: shape.inputTokens ?? DEFAULT_INPUT_TOKENS,
    cacheRead: shape.cacheRead ?? context.cachedPrefix,
    cacheWrite: shape.cacheWrite ?? context.uncached,
  };
  context.cachedPrefix = parts.cacheRead + parts.cacheWrite + parts.input;
  context.uncached = 0;
  context.lastRequestAt = now;
  return parts;
}
