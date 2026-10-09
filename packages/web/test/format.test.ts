import { describe, expect, it } from 'vitest';
import {
  formatAge,
  formatCompact,
  formatInteger,
  formatMyr,
  formatPercent,
  formatShortDate,
  formatSignedPercent,
  formatTokens,
  formatUsd,
  shortHash,
} from '../src/lib/format';

const S = 1000;
const M = 60 * S;
const H = 60 * M;

describe('formatters', () => {
  it('formats ages compactly', () => {
    expect(formatAge(35 * S)).toBe('35s');
    expect(formatAge(4 * M + 59 * S)).toBe('4m');
    expect(formatAge(2 * H + 14 * M)).toBe('2h 14m');
    expect(formatAge(2 * H)).toBe('2h');
    expect(formatAge(3 * 24 * H + 2 * H)).toBe('3d 2h');
    expect(formatAge(12 * 24 * H)).toBe('12d');
    expect(formatAge(-5 * S)).toBe('0s');
  });

  it('formats token counts like 1.2M with sensible precision', () => {
    expect(formatTokens(812)).toBe('812');
    expect(formatTokens(1_234)).toBe('1.2K');
    expect(formatTokens(48_210)).toBe('48.2K');
    expect(formatTokens(123_456)).toBe('123K');
    expect(formatTokens(1_234_567)).toBe('1.2M');
    expect(formatTokens(1_000_000)).toBe('1M');
    expect(formatCompact(999_960)).toBe('1M');
    expect(formatCompact(999_600)).toBe('1M');
    expect(formatCompact(99_960)).toBe('100K');
    expect(formatCompact(999.6)).toBe('1K');
    expect(formatCompact(2_500_000_000)).toBe('2.5B');
    expect(formatCompact(-1_500)).toBe('−1.5K');
  });

  it('formats money as US$ / RM pairs', () => {
    expect(formatUsd(12.4)).toBe('US$12.40');
    expect(formatUsd(1284.5)).toBe('US$1,284.50');
    expect(formatUsd(48_210, { compact: true })).toBe('US$48.2K');
    expect(formatUsd(-3)).toBe('−US$3.00');
    expect(formatMyr(58.3)).toBe('RM 58.30');
  });

  it('rounds percentages the way people expect', () => {
    expect(formatPercent(0.575)).toBe('58%');
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(0.1234, 1)).toBe('12.3%');
    expect(formatSignedPercent(0.12)).toBe('+12%');
    expect(formatSignedPercent(-0.18)).toBe('−18%');
    expect(formatSignedPercent(0.001)).toBe('0%');
    expect(formatPercent(Number.NaN)).toBe('—');
  });

  it('formats integers, dates and hashes', () => {
    expect(formatInteger(1_234_567)).toBe('1,234,567');
    expect(formatShortDate('2026-10-08')).toBe('Oct 8');
    expect(shortHash('9c1e4b7a2f0d58e3b6a1c9d4')).toBe('9c1e4b7a');
    expect(shortHash('sha256:3f9a1c7e5b2d4f6a', 6)).toBe('3f9a1c');
  });
});
