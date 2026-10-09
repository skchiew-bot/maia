/**
 * Pure credit rules (§10 Credits, R7, R8). They are only ever evaluated at task boundaries, so a
 * session is never cut mid-task, and nothing here takes or returns a model: credits meter cost only.
 */
import type { BoundaryInstruction } from '@aoc/contracts';

/** Computed notional amounts keep sub-cent precision without float noise (and never -0). */
export function roundUsd(x: number): number {
  const r = Math.round(x * 10_000) / 10_000;
  return r === 0 ? 0 : r;
}

/** Allocations, grants and top-ups are whole cents. */
export function roundCents(x: number): number {
  const r = Math.round(x * 100) / 100;
  return r === 0 ? 0 : r;
}

export function balanceOf(a: { allocationUsd: number; grantedUsd: number; usedUsd: number }): number {
  return roundUsd(a.allocationUsd + a.grantedUsd - a.usedUsd);
}

/**
 * The once-per-period auto grant is `pct` of the ORIGINAL period allocation. Grants and top-ups are
 * never part of the base, so nothing compounds.
 */
export function autoGrantAmount(allocationUsd: number, pct: number): number {
  return Math.max(0, roundCents((allocationUsd * pct) / 100));
}

export interface BoundaryState {
  exempt: boolean;
  balanceUsd: number;
  autoGrantUsed: boolean;
  /** autoGrantAmount() for the period. */
  autoGrantUsd: number;
}

export type BoundaryVerdict =
  | { action: 'continue' }
  | { action: 'auto_grant'; amountUsd: number; balanceAfter: number }
  | { action: 'cap' };

export function boundaryVerdict(s: BoundaryState): BoundaryVerdict {
  if (s.exempt || s.balanceUsd > 0) return { action: 'continue' };
  if (!s.autoGrantUsed && s.autoGrantUsd > 0) {
    return {
      action: 'auto_grant',
      amountUsd: s.autoGrantUsd,
      balanceAfter: roundUsd(s.balanceUsd + s.autoGrantUsd),
    };
  }
  return { action: 'cap' };
}

/** Would the next task boundary stop work? (An auto grant that cannot lift the balance above zero still stops it.) */
export function isCapped(s: BoundaryState): boolean {
  const v = boundaryVerdict(s);
  return v.action === 'cap' || (v.action === 'auto_grant' && v.balanceAfter <= 0);
}

export function capInstruction(period: string): BoundaryInstruction {
  return {
    continue: false,
    reason: 'credit_cap',
    instruction: `Credit cap reached for ${period}. Finish nothing new: end your turn now. Work resumes automatically after a top-up is approved.`,
  };
}
