import type { DatabaseSync, StatementSync } from 'node:sqlite';
import {
  modelTierOf,
  type CostBasis,
  type ErrorPriority,
  type MeteringService,
  type ModelTier,
  type OccurrenceCostDTO,
  type UsageTotals,
} from '@aoc/contracts';
import { localDate } from '@aoc/kernel';

interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/**
 * Token-estimate fallback (USD per MTok by tier, mirroring config/rate-card.json tier prices), used only when
 * no MeteringService is available. Unknown models are priced as opus so recurrence cost is never understated.
 */
export const ESTIMATE_RATES: Record<ModelTier, Rates> = {
  fable: { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  opus: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
};

export function estimateUsd(model: string, u: UsageTotals): number {
  const tier = modelTierOf(model);
  const r = ESTIMATE_RATES[tier === 'unknown' ? 'opus' : tier];
  return (
    (u.inputTokens * r.input +
      u.outputTokens * r.output +
      u.cacheReadTokens * r.cacheRead +
      u.cacheWrite5mTokens * r.cacheWrite5m +
      u.cacheWrite1hTokens * r.cacheWrite1h) /
    1e6
  );
}

export interface CostSubject {
  errorId: string;
  seq: number;
  sessionId: string | null;
  observedMs: number;
  priority: ErrorPriority;
  directUsd: number;
  directMs: number;
}

export interface CostSettings {
  windowMs: number;
  highPriorityMultiplier: number;
  timezone: string;
  nowMs: number;
  metering: MeteringService | null;
}

interface UsageRow {
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_w5: number;
  cache_w1: number;
  last_ms: number;
}

/**
 * Cost of an occurrence = the linked session's usage in the window after the error (tokens → notional USD via
 * metering, else the tier estimate; time = how long the session kept working inside the window). The window
 * closes early at the session's next error, so a burst of failures does not count the same recovery twice.
 */
export class CostCalculator {
  private readonly usage: StatementSync;
  private readonly nextError: StatementSync;

  constructor(
    db: DatabaseSync,
    private readonly s: CostSettings,
  ) {
    this.usage = db.prepare(
      'SELECT model, input, output, cache_read, cache_w5, cache_w1, last_ms FROM lrn_usage WHERE session_id = ? AND last_ms > ? AND last_ms <= ?',
    );
    this.nextError = db.prepare(
      'SELECT MIN(observed_ms) AS t FROM lrn_errors WHERE session_id = ? AND (observed_ms > ? OR (observed_ms = ? AND seq > ?))',
    );
  }

  multiplier(priority: ErrorPriority): number {
    return priority === 'high' ? this.s.highPriorityMultiplier : 1;
  }

  of(x: CostSubject): OccurrenceCostDTO {
    let end = x.observedMs + this.s.windowMs;
    let usd = x.directUsd;
    let tokens = 0;
    let lastMs = x.observedMs;
    let basis: CostBasis = 'none';
    if (x.sessionId) {
      const next = (
        this.nextError.get(x.sessionId, x.observedMs, x.observedMs, x.seq) as { t: number | null }
      ).t;
      if (next !== null && next < end) end = next;
      const rows = this.usage.all(x.sessionId, x.observedMs, end) as unknown as UsageRow[];
      for (const r of rows) {
        const totals: UsageTotals = {
          inputTokens: r.input,
          outputTokens: r.output,
          cacheReadTokens: r.cache_read,
          cacheWrite5mTokens: r.cache_w5,
          cacheWrite1hTokens: r.cache_w1,
        };
        const priced = this.price(r.model, totals, r.last_ms);
        usd += priced.usd;
        basis = basis === 'estimate' || priced.basis === 'estimate' ? 'estimate' : priced.basis;
        tokens += r.input + r.output + r.cache_read + r.cache_w5 + r.cache_w1;
        lastMs = Math.max(lastMs, r.last_ms);
      }
    }
    const round = (n: number) => Math.round(n * 1e6) / 1e6;
    return {
      usd: round(usd),
      ms: x.directMs + (lastMs - x.observedMs),
      tokens,
      basis,
      weightedUsd: round(usd * this.multiplier(x.priority)),
      provisional: this.s.nowMs < end,
    };
  }

  private price(model: string, totals: UsageTotals, atMs: number): { usd: number; basis: CostBasis } {
    if (this.s.metering) {
      try {
        const usd = this.s.metering.notionalCostUsd(model, totals, localDate(atMs, this.s.timezone));
        if (Number.isFinite(usd) && usd >= 0) return { usd, basis: 'metering' };
      } catch {
        // unknown model on the rate card: fall through to the estimate
      }
    }
    return { usd: estimateUsd(model, totals), basis: 'estimate' };
  }
}
