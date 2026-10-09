/** Linear-interpolated percentile (p in 0..1) of a numeric sample; null when empty. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = (s.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return Math.round(s[lo]! + (s[hi]! - s[lo]!) * (idx - lo));
}

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Percentage 0..100 with one decimal; 0 when the denominator is 0. */
export function pct(part: number, whole: number): number {
  return whole > 0 ? round1((part / whole) * 100) : 0;
}
