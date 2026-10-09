import { toEpoch, type Instant } from '../../lib/format';

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

/** `9 Oct 2026` — day-first, as requesters in Malaysia write dates. */
export function formatDay(value: Instant): string {
  const t = toEpoch(value);
  return Number.isFinite(t) ? DAY.format(t) : '—';
}

/** `9 Oct 2026, 14:05` */
export function formatDayTime(value: Instant): string {
  const t = toEpoch(value);
  return Number.isFinite(t) ? `${DAY.format(t)}, ${TIME.format(t)}` : '—';
}

/** `14:05` */
export function formatTime(value: Instant): string {
  const t = toEpoch(value);
  return Number.isFinite(t) ? TIME.format(t) : '—';
}
