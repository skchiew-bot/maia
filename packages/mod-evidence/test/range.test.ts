import { describe, expect, it } from 'vitest';
import { isCalendarDate, resolveRange, zonedStartOfDay } from '../src';

const iso = (ms: number) => new Date(ms).toISOString();

describe('local-date ranges', () => {
  it('finds local midnight in fixed, fractional and DST time zones', () => {
    expect(iso(zonedStartOfDay('2026-10-03', 'Asia/Kuala_Lumpur'))).toBe('2026-10-02T16:00:00.000Z');
    expect(iso(zonedStartOfDay('2026-10-03', 'UTC'))).toBe('2026-10-03T00:00:00.000Z');
    expect(iso(zonedStartOfDay('2026-10-03', 'Asia/Kolkata'))).toBe('2026-10-02T18:30:00.000Z');
    // New York: DST starts 2026-03-08 02:00 and ends 2026-11-01 02:00 (both after local midnight).
    expect(iso(zonedStartOfDay('2026-03-08', 'America/New_York'))).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(zonedStartOfDay('2026-03-09', 'America/New_York'))).toBe('2026-03-09T04:00:00.000Z');
    expect(iso(zonedStartOfDay('2026-11-01', 'America/New_York'))).toBe('2026-11-01T04:00:00.000Z');
    expect(iso(zonedStartOfDay('2026-11-02', 'America/New_York'))).toBe('2026-11-02T05:00:00.000Z');
  });

  it('validates calendar dates', () => {
    expect(isCalendarDate('2026-02-28')).toBe(true);
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
    expect(isCalendarDate('2026-13-01')).toBe(false);
    expect(isCalendarDate('26-01-01')).toBe(false);
  });

  it('resolves inclusive local dates into [start, end) and refuses future or oversized ranges', () => {
    const now = Date.parse('2026-10-09T02:00:00.000Z'); // 10:00 on 9 Oct in Kuala Lumpur
    const r = resolveRange('2026-10-03', '2026-10-05', 'Asia/Kuala_Lumpur', now, 366);
    expect(r).toMatchObject({
      ok: true,
      range: {
        days: 3,
        fromTs: '2026-10-02T16:00:00.000Z',
        toTsExclusive: '2026-10-05T16:00:00.000Z',
        complete: true,
      },
    });
    expect(resolveRange('2026-10-09', '2026-10-09', 'Asia/Kuala_Lumpur', now, 366)).toMatchObject({
      ok: true,
      range: { complete: false },
    });
    expect(resolveRange('2026-10-10', '2026-10-10', 'Asia/Kuala_Lumpur', now, 366)).toMatchObject({
      ok: false,
    });
    // "Today" follows the configured zone: at this instant it is still 8 Oct in Honolulu (UTC-10).
    expect(resolveRange('2026-10-08', '2026-10-08', 'Pacific/Honolulu', now, 366)).toMatchObject({
      ok: true,
      range: { complete: false },
    });
    expect(resolveRange('2026-10-05', '2026-10-03', 'UTC', now, 366)).toEqual({
      ok: false,
      problems: ['from must not be after to'],
    });
    expect(resolveRange('2026-01-01', '2026-10-01', 'UTC', now, 30)).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/spans 274 days/)],
    });
  });
});
