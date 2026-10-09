import { sha256hex } from '@aoc/kernel';

/** Long tails differ between otherwise identical failures (stack frames, truncated tool output). */
const MAX_TEMPLATE = 400;

const RULES: [RegExp, string][] = [
  // timestamps and clock times
  [/\b\d{4}-\d{2}-\d{2}(?:[t ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:z|[+-]\d{2}:?\d{2})?)?\b/g, ' <ts> '],
  [/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, ' <ts> '],
  // quoted values (an apostrophe inside a word, as in "can't", is not a quote)
  [/"[^"\n]{0,300}"/g, ' <q> '],
  [/`[^`\n]{0,300}`/g, ' <q> '],
  [/(^|[\s(\[{:=,])'[^'\n]{0,300}'(?=$|[\s)\]}:;,.!?])/g, '$1 <q> '],
  // urls and paths (windows, absolute / explicit relative, relative with ≥2 separators or a file extension)
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/g, ' <url> '],
  [/\b[a-z]:[\\/][\w.@+~\\/-]*/g, ' <path> '],
  [/(^|[\s(\[{:=,<])(?:~|\.{1,2})?[\\/][\w.@+~-]+(?:[\\/][\w.@+~-]*)*/g, '$1 <path> '],
  [/\b[\w@+-]+(?:[\\/][\w.@+-]+){2,}/g, ' <path> '],
  [/\b[\w.@+-]+[\\/][\w.@+-]*\.[a-z0-9]{1,6}\b/g, ' <path> '],
  // uuids, hex literals, hashes, AOC/ULID-style ids
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, ' <hex> '],
  [/\b0x[0-9a-f]+\b/g, ' <hex> '],
  [/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,}\b/g, ' <hex> '],
  [/\b[a-z]{2,6}_[0-9a-z]{10,}\b/g, ' <id> '],
  // remaining numbers
  [/\d+(?:\.\d+)?/g, ' <n> '],
  [/…/g, ' '],
];

/**
 * Strip the variable parts of an error message (numbers, hex, ids, paths, quoted values, timestamps) so the
 * same failure template always normalises to the same text. Clustering by CAUSE happens later (root-cause
 * classes); the signature only recognises the same symptom.
 */
export function normalizeMessage(message: string): string {
  let s = message.toLowerCase();
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_TEMPLATE).trim();
}

/** sha256 of the normalised message. */
export function errorSignature(message: string): string {
  return sha256hex(normalizeMessage(message) || '<empty>');
}

const ERROR_KEYS = ['error', 'stderr', 'message', 'reason', 'content', 'stdout', 'output', 'result'] as const;

function textOf(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) {
    const parts = v
      .map((x) =>
        x && typeof x === 'object' && typeof (x as { text?: unknown }).text === 'string'
          ? (x as { text: string }).text
          : typeof x === 'string'
            ? x
            : '',
      )
      .filter(Boolean);
    return parts.join('\n').trim() || null;
  }
  return null;
}

/**
 * Tool output arrives as a (possibly truncated) JSON summary of the tool response. Pull out the human error
 * text — stripping quoted values from raw JSON would collapse every tool failure onto one signature.
 */
export function toolErrorText(outputSummary: string | undefined | null): string | null {
  const raw = outputSummary?.trim();
  if (!raw) return null;
  if (!raw.startsWith('{') && !raw.startsWith('[')) return raw;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const k of ERROR_KEYS) {
        const t = textOf((parsed as Record<string, unknown>)[k]);
        if (t) return t;
      }
      return raw;
    }
    return textOf(parsed) ?? raw;
  } catch {
    // truncated summary ("…"): recover the first error-ish string field
    for (const k of ERROR_KEYS) {
      const m = raw.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
      if (m?.[1]) {
        try {
          return (JSON.parse(`"${m[1]}"`) as string).trim() || null;
        } catch {
          return m[1];
        }
      }
    }
    return raw;
  }
}
