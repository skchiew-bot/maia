/**
 * Token-based cost estimate for registry economics, used only when no MeteringService is loaded
 * (metering owns the real, versioned rate card). Notional API-equivalent USD, like metering.
 */
import { MODEL_TIERS, type ModelTier, type UsageTotals } from '@aoc/contracts';

export interface TokenRate {
  inputPerMTok: number;
  outputPerMTok: number;
  cacheReadPerMTok: number;
  cacheWrite5mPerMTok: number;
  cacheWrite1hPerMTok: number;
}

/** Per-tier defaults matching the seeded rate card's tier fallbacks (config/rate-card.json). */
export const DEFAULT_RATES: Readonly<Record<ModelTier, TokenRate>> = {
  fable: {
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: 0.25,
    cacheWrite5mPerMTok: 12.5,
    cacheWrite1hPerMTok: 20,
  },
  opus: {
    inputPerMTok: 4,
    outputPerMTok: 20,
    cacheReadPerMTok: 0.2,
    cacheWrite5mPerMTok: 5,
    cacheWrite1hPerMTok: 8,
  },
  sonnet: {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWrite5mPerMTok: 2.5,
    cacheWrite1hPerMTok: 4,
  },
  haiku: {
    inputPerMTok: 0.1,
    outputPerMTok: 0.5,
    cacheReadPerMTok: 0.01,
    cacheWrite5mPerMTok: 0.125,
    cacheWrite1hPerMTok: 0.2,
  },
};

export function resolveRates(
  overrides: Partial<Record<ModelTier, TokenRate>> = {},
): Record<ModelTier, TokenRate> {
  const out = {} as Record<ModelTier, TokenRate>;
  for (const t of MODEL_TIERS) out[t] = overrides[t] ?? DEFAULT_RATES[t];
  return out;
}

export function estimateCostUsd(u: UsageTotals, r: TokenRate): number {
  return (
    (u.inputTokens * r.inputPerMTok +
      u.outputTokens * r.outputPerMTok +
      u.cacheReadTokens * r.cacheReadPerMTok +
      u.cacheWrite5mTokens * r.cacheWrite5mPerMTok +
      u.cacheWrite1hTokens * r.cacheWrite1hPerMTok) /
    1_000_000
  );
}

/** Blended (input + output) price ratio to project execution cost from discovery cost when no execution run exists yet. */
export function priceRatio(
  rates: Record<ModelTier, TokenRate>,
  from: ModelTier,
  to: ModelTier,
): number | null {
  const a = rates[from].inputPerMTok + rates[from].outputPerMTok;
  const b = rates[to].inputPerMTok + rates[to].outputPerMTok;
  return a > 0 ? b / a : null;
}
