/** Money is reported to the micro-dollar; sums are rounded once at the edge, never per row. */
export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Linear-interpolated percentile between closest ranks (Hyndman–Fan type 7 — numpy / Excel PERCENTILE.INC). */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo]! + (h - lo) * (s[hi]! - s[lo]!);
}
