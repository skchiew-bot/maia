const HOUR_MS = 3_600_000;

export interface SubmissionLimits {
  /** Intake submissions one Requester may send per rolling hour, counted before the form is read. */
  perRequesterPerHour: number;
}

export const DEFAULT_SUBMISSION_LIMITS: SubmissionLimits = { perRequesterPerHour: 20 };

/**
 * Per Requester, intake submissions are counted in a rolling hour on the injected clock (threat model, D: upload
 * flooding). A submission is charged before its form is parsed, so a refused one costs aocd no parsing; one the route
 * later rejects (a bad title, a refused file) still counts. Requesters are authenticated users, so the map is bounded.
 */
export class SubmissionLimiter {
  private readonly recent = new Map<string, number[]>();

  constructor(
    readonly perHour: number,
    private readonly now: () => number,
  ) {}

  /** Charges one submission to `requesterId`: 0 when allowed, otherwise the ms until one would be. */
  take(requesterId: string): number {
    const now = this.now();
    const times = (this.recent.get(requesterId) ?? []).filter((t) => now - t < HOUR_MS);
    this.recent.set(requesterId, times);
    if (times.length >= this.perHour) return Math.max(1000, times[0]! + HOUR_MS - now);
    times.push(now);
    return 0;
  }
}
