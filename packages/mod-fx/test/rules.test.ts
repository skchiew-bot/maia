import { describe, expect, it } from 'vitest';
import { movePct, pipsApart, reconciles, weekdaysIn } from '../src/rules';

describe('4-dp reconciliation', () => {
  it('rounds both figures to 4 dp before comparing (the API serves binary floats)', () => {
    expect(pipsApart(4.0899999999999999, 4.09)).toBe(0);
    expect(pipsApart(4.0839999999999996, 4.084)).toBe(0);
    expect(pipsApart(4.09, 4.087)).toBe(30);
  });

  it('allows the tolerance, or nothing for a soft-flagged move', () => {
    const tolerance = 0.0001;
    expect(reconciles(4.09, 4.087, { tolerance, exact: false })).toBe(false);
    // The Wave 0 default hid a 1700-vs-1200 mix-up (research §0).
    expect(reconciles(4.09, 4.087, { tolerance: 0.005, exact: false })).toBe(true);
    expect(reconciles(4.0901, 4.09, { tolerance, exact: false })).toBe(true);
    expect(reconciles(4.0902, 4.09, { tolerance, exact: false })).toBe(false);
    expect(reconciles(4.0901, 4.09, { tolerance, exact: true })).toBe(false);
    expect(reconciles(4.1500000000000004, 4.15, { tolerance, exact: true })).toBe(true);
  });
});

describe('calendar', () => {
  it('counts weekdays only (Hari Raya 2025: four days without publication, two of them weekdays)', () => {
    expect(weekdaysIn('2025-03-29', '2025-04-01')).toEqual({ days: 2, since: '2025-03-31' });
    expect(weekdaysIn('2026-10-10', '2026-10-11')).toEqual({ days: 0, since: null });
    expect(weekdaysIn('2026-10-09', '2026-10-13')).toEqual({ days: 3, since: '2026-10-09' });
    expect(weekdaysIn('2026-10-14', '2026-10-13')).toEqual({ days: 0, since: null });
  });

  it('measures the day-over-day move in percent either way', () => {
    expect(movePct(4.15, 4.09).toFixed(2)).toBe('1.47');
    expect(movePct(4.09, 4.15).toFixed(2)).toBe('1.45');
  });
});
