import type { Clock } from '@aoc/kernel';

export interface ThrottleOptions {
  /** Failures tolerated before backoff starts. */
  threshold: number;
  /** First lock duration; doubles with every further failure. */
  baseMs: number;
  maxMs: number;
  /** A key's failures are forgotten after this long without a new one. */
  windowMs: number;
  /** Memory bound under a distributed attack. */
  maxEntries: number;
}

export const DEFAULT_THROTTLE: ThrottleOptions = {
  threshold: 5,
  baseMs: 1_000,
  maxMs: 15 * 60_000,
  windowMs: 15 * 60_000,
  maxEntries: 10_000,
};

interface Entry {
  failures: number;
  lastAt: number;
  lockedUntil: number;
}

/** In-memory failure counter with exponential backoff, keyed by "ip:<addr>" and "prefix:<token prefix>". */
export class FailureThrottle {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly clock: Clock,
    private readonly opts: ThrottleOptions = DEFAULT_THROTTLE,
  ) {}

  /** Milliseconds until the key may try again (0 = not locked). */
  retryAfterMs(key: string): number {
    const e = this.entries.get(key);
    return e ? Math.max(0, e.lockedUntil - this.clock.now()) : 0;
  }

  /** Record a failure; returns the lock it started (0 = still under the threshold). */
  fail(key: string): number {
    const now = this.clock.now();
    let e = this.entries.get(key);
    if (e && now - e.lastAt > this.opts.windowMs) e = undefined;
    if (!e) {
      if (this.entries.size >= this.opts.maxEntries) this.evict(now);
      e = { failures: 0, lastAt: now, lockedUntil: 0 };
    }
    e.failures += 1;
    e.lastAt = now;
    let lockMs = 0;
    if (e.failures >= this.opts.threshold) {
      lockMs = Math.min(this.opts.maxMs, this.opts.baseMs * 2 ** (e.failures - this.opts.threshold));
      e.lockedUntil = now + lockMs;
    }
    // Re-insert so Map order tracks recency for eviction.
    this.entries.delete(key);
    this.entries.set(key, e);
    return lockMs;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private evict(now: number): void {
    for (const [k, e] of this.entries)
      if (now - e.lastAt > this.opts.windowMs && e.lockedUntil <= now) this.entries.delete(k);
    while (this.entries.size >= this.opts.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
}
