import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { RateCardRate } from '@aoc/contracts';
import { checkForwardOnly, effectiveCard, matchRate, normalizeModelId, priceUsage } from '../src';
import { RATE_CARD_FILE } from './helpers';

const file = JSON.parse(readFileSync(RATE_CARD_FILE, 'utf8')) as {
  rates: RateCardRate[];
  tierFallback: Record<string, string>;
};
const card = { version: 1, effectiveFrom: '2026-10-01', rates: file.rates, tierFallback: file.tierFallback };
const zero = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
};
const M = 1_000_000;

describe('notional pricing', () => {
  it('prices every token class, including the 5-minute and 1-hour cache writes separately', () => {
    const p = priceUsage(
      'claude-opus-5-5',
      { inputTokens: M, outputTokens: M, cacheReadTokens: M, cacheWrite5mTokens: M, cacheWrite1hTokens: M },
      card,
    );
    expect(p.pricedBy).toBe('exact');
    expect(p.rateCardVersion).toBe(1);
    expect(p.costUsd).toBeCloseTo(4 + 20 + 0.2 + 5 + 8, 9);
    expect(priceUsage('claude-opus-5-5', { ...zero, cacheWrite5mTokens: 2 * M }, card).costUsd).toBeCloseTo(
      10,
      9,
    );
    expect(priceUsage('claude-opus-5-5', { ...zero, cacheWrite1hTokens: 2 * M }, card).costUsd).toBeCloseTo(
      16,
      9,
    );
    expect(priceUsage('claude-haiku-5-5', { ...zero, cacheReadTokens: 500_000 }, card).costUsd).toBeCloseTo(
      0.005,
      12,
    );
  });

  it('matches exact ids modulo case, context-window markers and dated snapshots', () => {
    expect(normalizeModelId(' Claude-Opus-5-5[1m] ')).toBe('claude-opus-5-5');
    expect(matchRate('claude-opus-5-5[1m]', card)).toMatchObject({
      pricedBy: 'exact',
      rateModel: 'claude-opus-5-5',
    });
    expect(matchRate('claude-haiku-4-5-20251001', card)).toMatchObject({
      pricedBy: 'exact',
      rateModel: 'claude-haiku-4-5',
    });
    // claude-opus-5 has its own rate: it must not collapse onto the opus tier fallback
    expect(matchRate('claude-opus-5', card)).toMatchObject({ pricedBy: 'exact', rateModel: 'claude-opus-5' });
  });

  it('falls back by tier, then leaves the model unpriced at zero cost', () => {
    const viaTier = priceUsage('claude-sonnet-7-preview', { ...zero, outputTokens: M }, card);
    expect(viaTier).toMatchObject({ pricedBy: 'tier', rateModel: 'claude-sonnet-5-5' });
    expect(viaTier.costUsd).toBeCloseTo(10, 9);
    // a card without a tierFallback map uses the contracts' MODEL_ID_BY_TIER
    expect(matchRate('claude-fable-9', { rates: file.rates, tierFallback: {} })).toMatchObject({
      pricedBy: 'tier',
      rateModel: 'claude-fable-5-1',
    });
    const unknown = priceUsage('gpt-something', { ...zero, inputTokens: M }, card);
    expect(unknown).toMatchObject({ pricedBy: 'unpriced', rate: null, costUsd: 0, rateCardVersion: 1 });
    // tier present but the fallback target is not priced on this card
    expect(matchRate('claude-opus-9', { rates: [file.rates[3]!], tierFallback: {} }).pricedBy).toBe(
      'unpriced',
    );
    // no card, or a card whose body was crypto-shredded
    expect(priceUsage('claude-opus-5-5', { ...zero, inputTokens: M }, null)).toMatchObject({
      pricedBy: 'unpriced',
      costUsd: 0,
      rateCardVersion: 0,
    });
    expect(
      priceUsage('claude-opus-5-5', { ...zero, inputTokens: M }, { ...card, rates: null }).pricedBy,
    ).toBe('unpriced');
  });

  it('picks the version in force on a date: latest effectiveFrom ≤ date, newest version on a tie', () => {
    const cards = [
      { version: 1, effectiveFrom: '2026-10-01' },
      { version: 2, effectiveFrom: '2026-10-15' },
      { version: 3, effectiveFrom: '2026-10-12' },
      { version: 4, effectiveFrom: '2026-10-15' },
    ];
    expect(effectiveCard(cards, '2026-09-30')).toBeNull();
    expect(effectiveCard(cards, '2026-10-11')?.version).toBe(1);
    expect(effectiveCard(cards, '2026-10-12')?.version).toBe(3);
    expect(effectiveCard(cards, '2026-10-20')?.version).toBe(4);
  });

  it('forward-only rule rejects today, the past and closed days', () => {
    expect(checkForwardOnly('2026-10-10', '2026-10-09', null)).toEqual({ ok: true });
    expect(checkForwardOnly('2026-10-09', '2026-10-09', null)).toMatchObject({
      ok: false,
      reason: 'not_after_today',
      earliest: '2026-10-10',
    });
    expect(checkForwardOnly('2026-10-01', '2026-10-09', '2026-10-08')).toMatchObject({
      ok: false,
      reason: 'closed_day',
    });
    // a closed day at or after today (clock skew) still blocks — closed days are never restated
    expect(checkForwardOnly('2026-10-11', '2026-10-09', '2026-10-12')).toMatchObject({
      ok: false,
      reason: 'closed_day',
      earliest: '2026-10-13',
    });
  });
});
