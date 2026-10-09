import { describe, expect, it } from 'vitest';
import type { MeteringDailyDTO, MigrationRecommendationDTO } from '@aoc/contracts';
import { shareText } from '../../src/pages/metering/BreakdownPanels';
import { validateDraft, type RateRow } from '../../src/pages/metering/RateCardDialog';
import {
  carryForwardState,
  dayLabel,
  dayRanges,
  formatIdle,
  fxExtractorText,
  fxPointKind,
  fxReasonText,
  fxSessionLabel,
  fxStampText,
  meteredDays,
  migrationAxis,
  rangeFor,
  rateCardBoundaries,
  tokenTypes,
  unpricedSummary,
} from '../../src/pages/metering/meteringModel';
import { DAILY, DAYS, FX_RATES, FX_STATUS, VERSION_1, fxRate } from './fixtures';

const daily = DAILY as unknown as MeteringDailyDTO;

describe('days and ranges', () => {
  it('ends ranges on the daemon day and labels days without a timezone shift', () => {
    expect(rangeFor('2026-10-09', 30)).toEqual({ from: '2026-09-10', to: '2026-10-09' });
    expect(rangeFor('2026-10-09', 7)).toEqual({ from: '2026-10-03', to: '2026-10-09' });
    expect(dayLabel('2026-10-09')).toBe('Fri Oct 9');
  });

  it('compresses consecutive days into ranges', () => {
    expect(dayRanges(['2026-09-27', '2026-09-25', '2026-09-26', '2026-10-02'])).toBe('Sep 25–27, Oct 2');
    expect(dayRanges(['2026-09-30', '2026-10-01'])).toBe('Sep 30–Oct 1');
    expect(dayRanges([])).toBe('');
  });

  it('drops days before metering began', () => {
    expect(meteredDays(daily).map((d) => d.date)).toEqual(DAYS.map((d) => d.date));
  });

  it('marks where a new rate-card version took effect', () => {
    expect(rateCardBoundaries(DAYS)).toEqual([{ index: 1, version: 1 }]);
  });
});

describe('FX stamps', () => {
  it('says whether a day used a live or an inherited rate, with the source day', () => {
    expect(fxStampText(DAYS[1]!.fx)).toBe('live');
    expect(fxStampText(DAYS[3]!.fx)).toBe('inherited from Oct 2');
    expect(fxStampText({ rate: 4.2, status: 'inherited', sourceDate: null, session: null })).toBe('inherited');
    expect(fxStampText({ rate: null, status: 'missing', sourceDate: null, session: null })).toBe('missing');
  });

  it('tells carried-forward-by-design apart from failures and manual entries', () => {
    expect(fxPointKind(FX_RATES[0]!)).toBe('live');
    expect(fxPointKind(FX_RATES[1]!)).toBe('carried');
    expect(fxPointKind(fxRate({ date: '2026-10-05', rate: 4.24, status: 'inherited', reason: 'validation_failed', flagged: true }))).toBe('flagged');
    expect(fxPointKind(fxRate({ date: '2026-10-06', rate: 4.25, extractor: 'manual', reason: 'manual_override' }))).toBe('manual');
    expect(fxReasonText('weekend_or_holiday')).toBe('weekend or holiday: carried forward by design');
    expect(fxReasonText('bnm_timeout')).toBe('bnm timeout');
    expect(fxExtractorText('sonnet')).toBe('Sonnet (after Haiku failed self-validation)');
  });

  it('labels the BNM session only from what the record says', () => {
    expect(fxSessionLabel('1700')).toBe('session 1700');
    expect(fxSessionLabel('12:00 noon')).toBe('12:00 noon');
    expect(fxSessionLabel(null)).toBeNull();
    expect(fxSessionLabel('  ')).toBeNull();
  });

  it('escalates consecutive carried-forward days at the threshold', () => {
    const at = (days: number) => carryForwardState({ ...FX_STATUS, carryForward: { ...FX_STATUS.carryForward, days, since: days ? '2026-10-06' : null } });
    expect(at(0).level).toBe('none');
    expect(at(2)).toEqual({ level: 'watch', days: 2, since: '2026-10-06', threshold: 3 });
    expect(at(3).level).toBe('alert');
  });
});

describe('usage', () => {
  it('summarises usage no rate card priced, as a share of all tokens', () => {
    const s = unpricedSummary(daily);
    expect(s).not.toBeNull();
    expect(s!.tokens).toBe(21_400_000);
    expect(s!.share).toBeCloseTo(21_400_000 / 26_355_000);
    expect(s!.models).toEqual(['claude-opus-5-5']);
    expect(s!.days).toEqual(['2026-09-30']);
    expect(unpricedSummary({ ...daily, totals: { ...daily.totals, unpriced: false, unpricedTokens: 0 } })).toBeNull();
  });

  it('splits tokens into the five billed types with shares that add up', () => {
    const rows = tokenTypes(daily.totals);
    expect(rows.map((r) => r.label)).toEqual(['Input', 'Output', 'Cache read', 'Cache write · 5 min', 'Cache write · 1 hour']);
    expect(rows.reduce((a, r) => a + r.share, 0)).toBeCloseTo(1);
    expect(rows[2]!.tokens).toBe(4_500_000);
  });

  it('prints shares and idle time readably', () => {
    expect(shareText(0.0005)).toBe('<0.1%');
    expect(shareText(0.005)).toBe('0.5%');
    expect(shareText(0.25)).toBe('25%');
    expect(shareText(0)).toBe('0%');
    expect(formatIdle(0)).toBe('0 min');
    expect(formatIdle(23 * 60_000)).toBe('23 min');
    expect(formatIdle(90 * 60_000)).toBe('1.5 h');
    expect(formatIdle(117 * 60_000)).toBe('2.0 h');
  });
});

describe('migration axis', () => {
  const withRange = (low: number, base: number, high: number) =>
    ({
      range: {
        low: { netMonthlyBenefitUsd: low },
        base: { netMonthlyBenefitUsd: base },
        high: { netMonthlyBenefitUsd: high },
      },
    }) as unknown as MigrationRecommendationDTO;

  it('always includes zero so benefit and cost read off one line', () => {
    expect(migrationAxis(withRange(-100, 50, 300))).toEqual({ min: -132, max: 332 });
    expect(migrationAxis(withRange(100, 200, 300))).toEqual({ min: 0, max: 324 });
  });
});

describe('validateDraft (rate card)', () => {
  const rows = (): RateRow[] =>
    VERSION_1.rates.map((r, key) => ({
      key,
      model: r.model,
      prices: {
        inputPerMTok: String(r.inputPerMTok),
        outputPerMTok: String(r.outputPerMTok),
        cacheReadPerMTok: String(r.cacheReadPerMTok),
        cacheWrite5mPerMTok: String(r.cacheWrite5mPerMTok),
        cacheWrite1hPerMTok: String(r.cacheWrite1hPerMTok),
      },
    }));

  it('accepts a forward-dated card', () => {
    expect(validateDraft(rows(), '2026-10-10', '2026-10-10')).toBeNull();
  });

  it('refuses a date before the earliest allowed day: changes apply forward only', () => {
    expect(validateDraft(rows(), '2026-10-09', '2026-10-10')).toBe('Rate changes apply forward only: choose Sat Oct 10 or later.');
    expect(validateDraft(rows(), '', '2026-10-10')).toBe('Choose the day the new prices take effect.');
  });

  it('refuses duplicate models, missing ids and negative or empty prices', () => {
    expect(validateDraft([], '2026-10-10', '2026-10-10')).toBe('Add at least one model.');
    const dup = rows();
    dup[1]!.model = 'CLAUDE-OPUS-5-5';
    expect(validateDraft(dup, '2026-10-10', '2026-10-10')).toBe('CLAUDE-OPUS-5-5 appears twice.');
    const blank = rows();
    blank[0]!.model = ' ';
    expect(validateDraft(blank, '2026-10-10', '2026-10-10')).toBe('Every row needs a model id.');
    const negative = rows();
    negative[0]!.prices.outputPerMTok = '-1';
    expect(validateDraft(negative, '2026-10-10', '2026-10-10')).toBe('Output for claude-opus-5-5 must be a price of 0 or more.');
    const empty = rows();
    empty[1]!.prices.cacheWrite1hPerMTok = '';
    expect(validateDraft(empty, '2026-10-10', '2026-10-10')).toBe('Cache write 1h for claude-haiku-5-5 must be a price of 0 or more.');
  });
});
