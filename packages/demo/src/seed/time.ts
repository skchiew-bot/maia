import { localDate } from '@aoc/kernel';
import { DAY } from './world';

const TZ = 'Asia/Kuala_Lumpur';

/**
 * Local time `hhmm` (MYT, UTC+8 all year) on the `k`-th working day before the day of `now` (k = 1 is the previous
 * working day). Governed work in the history lands on working days, in an order that never depends on the weekday
 * the seed happens to run on.
 */
export function workday(now: number, k: number, hhmm: string): number {
  let day = 0;
  for (let found = 0; found < k; ) {
    day++;
    const dow = new Date(`${localDate(now - day * DAY, TZ)}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) found++;
  }
  return Date.parse(`${localDate(now - day * DAY, TZ)}T${hhmm}:00+08:00`);
}
