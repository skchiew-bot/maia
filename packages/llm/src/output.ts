import type { JsonValue } from '@aoc/contracts';
import { LlmOutputInvalidError } from './errors';
import { validateJsonSchema } from './json-schema';

/** Parse model text as JSON: plain JSON, a ```json fenced block, or the outermost {...} span. */
export function parseJsonText(text: string, raw: string = text): JsonValue {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const candidates = [fenced ? fenced[1]! : trimmed];
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c) as JsonValue;
    } catch {
      // try the next candidate
    }
  }
  throw new LlmOutputInvalidError('model output is not JSON', ['$: not JSON'], raw);
}

/** Throw LlmOutputInvalidError unless `data` satisfies the request schema. */
export function assertMatchesSchema(schema: Record<string, unknown>, data: unknown, raw: string): void {
  const problems = validateJsonSchema(schema, data);
  if (problems.length) {
    throw new LlmOutputInvalidError(
      `model output does not match the schema: ${problems.slice(0, 5).join('; ')}`,
      problems,
      raw,
    );
  }
}
