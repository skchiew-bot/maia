import type { z } from 'zod';
import type { LlmService, ModelTier } from '@aoc/contracts';
import { LlmOutputInvalidError, LlmUnavailableError } from '@aoc/llm';

/** Why a model answer was not used. */
export type DistillFailure = 'llm_unavailable' | 'llm_error' | 'llm_invalid_output';

/** One distillation call: what to ask, and the contract its answer must meet. */
export interface DistillRequest<T> {
  /** Machine label for metering and scripted test models, e.g. `registry.distill`. */
  purpose: string;
  model: ModelTier;
  system: string;
  prompt: string;
  /** JSON Schema handed to the adapter (which enforces it too). */
  schema: Record<string, unknown>;
  maxTokens: number;
  /** Model output is untrusted: whatever this rejects is never used. A transform may normalise it. */
  output: z.ZodType<T, z.ZodTypeDef, unknown>;
}

export type DistillOutcome<T> =
  { ok: true; value: T } | { ok: false; reason: DistillFailure; detail: string };

/** A distilled value with how it was produced: refined by the model, or the caller's deterministic fallback. */
export type Distilled<T> =
  { method: 'llm'; value: T } | { method: 'fallback'; value: T; reason: DistillFailure; detail: string };

/** Ask the model once and validate the answer. Model trouble is an outcome, never an exception. */
export async function distill<T>(llm: LlmService | null, req: DistillRequest<T>): Promise<DistillOutcome<T>> {
  if (!llm) return { ok: false, reason: 'llm_unavailable', detail: 'no LLM service is loaded' };
  let data: unknown;
  try {
    data = (
      await llm.completeJson({
        model: req.model,
        purpose: req.purpose,
        system: req.system,
        prompt: req.prompt,
        schema: req.schema,
        maxTokens: req.maxTokens,
      })
    ).data;
  } catch (err) {
    const reason: DistillFailure =
      err instanceof LlmOutputInvalidError
        ? 'llm_invalid_output'
        : err instanceof LlmUnavailableError
          ? 'llm_unavailable'
          : 'llm_error';
    return { ok: false, reason, detail: (err instanceof Error ? err.message : String(err)).slice(0, 500) };
  }
  const parsed = req.output.safeParse(data);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { ok: false, reason: 'llm_invalid_output', detail: detail.slice(0, 500) };
  }
  return { ok: true, value: parsed.data };
}

/** The model's value when it produced a valid one, else the caller's deterministic candidate. */
export function withFallback<T>(
  outcome: DistillOutcome<T>,
  fallback: (reason: DistillFailure) => T,
): Distilled<T> {
  return outcome.ok
    ? { method: 'llm', value: outcome.value }
    : { method: 'fallback', value: fallback(outcome.reason), reason: outcome.reason, detail: outcome.detail };
}
