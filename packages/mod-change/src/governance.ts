/**
 * Invisible governance with accountability (§14): the AI drafts each change-record field, the developer must edit
 * or affirm it, and a blind one-click confirm is itself flagged. Pure functions.
 */
import { BLIND_AFFIRM_DWELL_MS, type AffirmRateRowDTO } from '@aoc/contracts';

const normalise = (s: string): string => s.replace(/\r\n?/g, '\n').trim();

/** Levenshtein distance; common prefix/suffix are stripped first so typical small edits stay cheap. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  let x = a.slice(start, endA);
  let y = b.slice(start, endB);
  if (!x.length) return y.length;
  if (!y.length) return x.length;
  if (x.length < y.length) [x, y] = [y, x];
  let prev = new Uint32Array(y.length + 1);
  let cur = new Uint32Array(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    const cx = x.charCodeAt(i - 1);
    for (let j = 1; j <= y.length; j++) {
      const sub = prev[j - 1]! + (cx === y.charCodeAt(j - 1) ? 0 : 1);
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, sub);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[y.length]!;
}

/** Normalised edit distance in [0, 1] between the AI draft and the affirmed value (whitespace at the ends ignored). */
export function editRatio(draft: string, value: string): number {
  const a = normalise(draft);
  const b = normalise(value);
  const max = Math.max(a.length, b.length);
  return max === 0 ? 0 : Math.round((editDistance(a, b) / max) * 10_000) / 10_000;
}

export interface AffirmationInput {
  draft: string;
  value: string;
  /** rollbackPlan only: the drafted and the affirmed rollback ref (changing the ref is an edit). */
  draftRef?: string;
  ref?: string;
  dwellMs: number;
  blindDwellMs?: number;
}

export interface AffirmationAssessment {
  edited: boolean;
  editRatio: number;
  /** Affirmed without any edit after less than the dwell threshold: a blind one-click confirm. */
  blind: boolean;
}

export function assessAffirmation(i: AffirmationInput): AffirmationAssessment {
  const ratio = editRatio(i.draft, i.value);
  const refChanged = i.ref !== undefined && (i.draftRef ?? '').trim() !== i.ref.trim();
  const edited = normalise(i.draft) !== normalise(i.value) || refChanged;
  const blind = !edited && i.dwellMs < (i.blindDwellMs ?? BLIND_AFFIRM_DWELL_MS);
  return { edited, editRatio: ratio, blind };
}

export interface AffirmationCounts {
  userId: string;
  name: string | null;
  affirmations: number;
  affirmedWithoutEdit: number;
  flagged: number;
  editRatioSum: number;
}

export function affirmRateRow(c: AffirmationCounts): AffirmRateRowDTO {
  const rate = (n: number) => (c.affirmations ? Math.round((n / c.affirmations) * 10_000) / 10_000 : 0);
  return {
    userId: c.userId,
    name: c.name,
    affirmations: c.affirmations,
    affirmedWithoutEdit: c.affirmedWithoutEdit,
    affirmWithoutEditRate: rate(c.affirmedWithoutEdit),
    flagged: c.flagged,
    meanEditRatio: rate(c.editRatioSum),
  };
}
