/** Notional API-equivalent pricing (pure). */
import { MODEL_ID_BY_TIER, modelTierOf, type RateCardRate, type UsageTotals } from '@aoc/contracts';

export type PricedBy = 'exact' | 'tier' | 'unpriced';

export interface PricingCard {
  version: number;
  effectiveFrom: string;
  /** null when the version's body was crypto-shredded: nothing can be priced with it. */
  rates: RateCardRate[] | null;
  tierFallback: Partial<Record<string, string>>;
}

export interface RateMatch {
  rate: RateCardRate | null;
  pricedBy: PricedBy;
  rateModel: string | null;
}

export interface PricedUsage extends RateMatch {
  costUsd: number;
  rateCardVersion: number;
}

const CONTEXT_SUFFIX = /\[[^\]]*\]$/; // context-window marker, e.g. "claude-opus-5-5[1m]"
const SNAPSHOT_SUFFIX = /-\d{8}$/; // dated snapshot, e.g. "claude-haiku-4-5-20251001"

/** Same model id modulo case, a context-window marker and a dated snapshot suffix. */
export function normalizeModelId(model: string): string {
  return model.trim().toLowerCase().replace(CONTEXT_SUFFIX, '').replace(SNAPSHOT_SUFFIX, '');
}

/** Exact model id, else the card's tier fallback (tier from modelTierOf), else unpriced. */
export function matchRate(
  model: string,
  card: Pick<PricingCard, 'rates' | 'tierFallback'> | null,
): RateMatch {
  if (!card?.rates) return { rate: null, pricedBy: 'unpriced', rateModel: null };
  const find = (id: string) => {
    const want = normalizeModelId(id);
    return card.rates!.find((r) => normalizeModelId(r.model) === want) ?? null;
  };
  const exact = find(model);
  if (exact) return { rate: exact, pricedBy: 'exact', rateModel: exact.model };
  const tier = modelTierOf(model);
  if (tier !== 'unknown') {
    const viaTier = find(card.tierFallback[tier] ?? MODEL_ID_BY_TIER[tier]);
    if (viaTier) return { rate: viaTier, pricedBy: 'tier', rateModel: viaTier.model };
  }
  return { rate: null, pricedBy: 'unpriced', rateModel: null };
}

export function costUsd(rate: RateCardRate, u: UsageTotals): number {
  return (
    (u.inputTokens * rate.inputPerMTok +
      u.outputTokens * rate.outputPerMTok +
      u.cacheReadTokens * rate.cacheReadPerMTok +
      u.cacheWrite5mTokens * rate.cacheWrite5mPerMTok +
      u.cacheWrite1hTokens * rate.cacheWrite1hPerMTok) /
    1_000_000
  );
}

/** Version in force on `date`: the greatest effectiveFrom ≤ date; on a tie the newest version wins. */
export function effectiveCard<T extends { version: number; effectiveFrom: string }>(
  cards: readonly T[],
  date: string,
): T | null {
  let best: T | null = null;
  for (const c of cards) {
    if (c.effectiveFrom > date) continue;
    if (
      !best ||
      c.effectiveFrom > best.effectiveFrom ||
      (c.effectiveFrom === best.effectiveFrom && c.version > best.version)
    )
      best = c;
  }
  return best;
}

export function priceUsage(model: string, usage: UsageTotals, card: PricingCard | null): PricedUsage {
  const m = matchRate(model, card);
  return { ...m, costUsd: m.rate ? costUsd(m.rate, usage) : 0, rateCardVersion: card?.version ?? 0 };
}
