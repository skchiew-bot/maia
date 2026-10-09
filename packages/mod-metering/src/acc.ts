/** Accumulates token / notional-cost totals from live usage rows and frozen rollup entries alike. */
import type { MeteringCostRow, RollupBreakdownRow } from '@aoc/contracts';
import { round6 } from './stats';

/** One SQL aggregate over mtr_usage (per date and group key). */
export interface UsageAggRow {
  date: string;
  k: string | null;
  input: number;
  output: number;
  cache_read: number;
  cw5m: number;
  cw1h: number;
  messages: number;
  usd: number;
  unpriced_tokens: number;
  /** char(31)-joined model ids (GROUP_CONCAT), possibly repeated. */
  unpriced_models: string | null;
  tier_models: string | null;
}

export const MODEL_SEP = '\u001f';
const models = (s: string | null): string[] => (s ? s.split(MODEL_SEP) : []);

export interface CostTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  messages: number;
  usd: number;
  /** null = no FX rate for that contribution. */
  rm: number | null;
  unpricedTokens: number;
  unpricedModels: readonly string[];
  tierPricedModels: readonly string[];
}

export class CostAcc {
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWrite5mTokens = 0;
  cacheWrite1hTokens = 0;
  messages = 0;
  usd = 0;
  rm = 0;
  unpricedTokens = 0;
  readonly unpricedModels = new Set<string>();
  readonly tierPricedModels = new Set<string>();
  private rmKnown = false;
  private rmMissing = false;

  add(t: CostTotals): this {
    this.inputTokens += t.inputTokens;
    this.outputTokens += t.outputTokens;
    this.cacheReadTokens += t.cacheReadTokens;
    this.cacheWrite5mTokens += t.cacheWrite5mTokens;
    this.cacheWrite1hTokens += t.cacheWrite1hTokens;
    this.messages += t.messages;
    this.usd += t.usd;
    if (t.rm === null) {
      if (t.usd > 0) this.rmMissing = true;
    } else {
      this.rm += t.rm;
      this.rmKnown = true;
    }
    this.unpricedTokens += t.unpricedTokens;
    for (const m of t.unpricedModels) this.unpricedModels.add(m);
    for (const m of t.tierPricedModels) this.tierPricedModels.add(m);
    return this;
  }

  /**
   * A live aggregate row, converted to RM with that day's rate (null = FX missing). `share` is the part of the row this
   * accumulator carries: an outcome takes its part of a session that served several outcomes.
   */
  addUsage(r: UsageAggRow, fxRate: number | null, share = 1): this {
    const part = (n: number) => n * share;
    return this.add({
      inputTokens: part(r.input),
      outputTokens: part(r.output),
      cacheReadTokens: part(r.cache_read),
      cacheWrite5mTokens: part(r.cw5m),
      cacheWrite1hTokens: part(r.cw1h),
      messages: part(r.messages),
      usd: part(r.usd),
      rm: fxRate === null ? null : part(r.usd) * fxRate,
      unpricedTokens: part(r.unpriced_tokens),
      unpricedModels: models(r.unpriced_models),
      tierPricedModels: models(r.tier_models),
    });
  }

  /** A frozen rollup entry: its USD/RM were fixed when the day closed and are never recomputed. */
  addFrozen(r: RollupBreakdownRow): this {
    return this.add(r);
  }

  merge(o: CostAcc): this {
    this.inputTokens += o.inputTokens;
    this.outputTokens += o.outputTokens;
    this.cacheReadTokens += o.cacheReadTokens;
    this.cacheWrite5mTokens += o.cacheWrite5mTokens;
    this.cacheWrite1hTokens += o.cacheWrite1hTokens;
    this.messages += o.messages;
    this.usd += o.usd;
    this.rm += o.rm;
    this.rmKnown ||= o.rmKnown;
    this.rmMissing ||= o.rmMissing;
    this.unpricedTokens += o.unpricedTokens;
    for (const m of o.unpricedModels) this.unpricedModels.add(m);
    for (const m of o.tierPricedModels) this.tierPricedModels.add(m);
    return this;
  }

  get hasUsage(): boolean {
    return (
      this.messages > 0 ||
      this.usd > 0 ||
      this.inputTokens +
        this.outputTokens +
        this.cacheReadTokens +
        this.cacheWrite5mTokens +
        this.cacheWrite1hTokens >
        0
    );
  }

  rmValue(): number | null {
    return this.rmMissing && !this.rmKnown ? null : round6(this.rm);
  }

  toRow(): MeteringCostRow {
    const cacheWriteTokens = this.cacheWrite5mTokens + this.cacheWrite1hTokens;
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens,
      cacheWrite5mTokens: this.cacheWrite5mTokens,
      cacheWrite1hTokens: this.cacheWrite1hTokens,
      totalTokens: this.inputTokens + this.outputTokens + this.cacheReadTokens + cacheWriteTokens,
      messages: this.messages,
      notionalUsd: round6(this.usd),
      notionalRm: this.rmValue(),
      rmComplete: !this.rmMissing,
      unpriced: this.unpricedTokens > 0 || this.unpricedModels.size > 0,
      unpricedTokens: this.unpricedTokens,
      unpricedModels: [...this.unpricedModels].sort(),
      tierPricedModels: [...this.tierPricedModels].sort(),
    };
  }

  toBreakdown(key: string | null): RollupBreakdownRow {
    return {
      key,
      usd: round6(this.usd),
      rm: this.rmValue(),
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWrite5mTokens: this.cacheWrite5mTokens,
      cacheWrite1hTokens: this.cacheWrite1hTokens,
      messages: this.messages,
      unpricedTokens: this.unpricedTokens,
      unpricedModels: [...this.unpricedModels].sort(),
      tierPricedModels: [...this.tierPricedModels].sort(),
    };
  }
}

/** Group-key → accumulator map with lazy creation. */
export class AccMap extends Map<string | null, CostAcc> {
  at(key: string | null): CostAcc {
    let a = this.get(key);
    if (!a) this.set(key, (a = new CostAcc()));
    return a;
  }
  total(): CostAcc {
    const t = new CostAcc();
    for (const a of this.values()) t.merge(a);
    return t;
  }
}
