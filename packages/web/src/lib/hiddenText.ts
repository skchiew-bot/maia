/**
 * T-15 / O-17: text a person approves (a lesson, a playbook, any decision card) may hide instructions in characters
 * that do not show, or in words whose letters only look Latin. This finds both so the console can show them.
 */

/** Format and control characters, odd blanks, variation selectors and tag characters: none render visibly. */
const HIDDEN =
  /[\p{Cf}\p{Co}\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F ᅟᅠ -   ⠀　ㅤ︀-️ﾠ]|[\u{E0100}-\u{E01EF}]/gu;
const WORD = /[\p{L}\p{M}]+/gu;
const LATIN = /\p{Script=Latin}/u;
const LOOKALIKE = /[\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Armenian}\p{Script=Cherokee}]/u;

export type TextPart =
  | { kind: 'text'; text: string }
  | { kind: 'hidden'; codePoint: string }
  | { kind: 'mixed'; text: string };

export interface TextInspection {
  parts: TextPart[];
  hidden: number;
  mixed: number;
}

export const codePointLabel = (ch: string): string =>
  `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;

function words(text: string, out: TextPart[]): number {
  let mixed = 0;
  let last = 0;
  for (const m of text.matchAll(WORD)) {
    const w = m[0];
    if (!LATIN.test(w) || !LOOKALIKE.test(w)) continue;
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    out.push({ kind: 'mixed', text: w });
    mixed++;
    last = m.index + w.length;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return mixed;
}

/** Split text into plain runs, hidden characters (by code point) and words that mix Latin with look-alike letters. */
export function inspectText(text: string): TextInspection {
  const parts: TextPart[] = [];
  let hidden = 0;
  let mixed = 0;
  let last = 0;
  for (const m of text.matchAll(HIDDEN)) {
    mixed += words(text.slice(last, m.index), parts);
    parts.push({ kind: 'hidden', codePoint: codePointLabel(m[0]) });
    hidden++;
    last = m.index + m[0].length;
  }
  mixed += words(text.slice(last), parts);
  return { parts, hidden, mixed };
}

/** Counts over several texts (a whole card). */
export function inspectAll(texts: readonly (string | null | undefined)[]): { hidden: number; mixed: number } {
  let hidden = 0;
  let mixed = 0;
  for (const t of texts) {
    if (!t) continue;
    const r = inspectText(t);
    hidden += r.hidden;
    mixed += r.mixed;
  }
  return { hidden, mixed };
}
