/** Local-calendar helpers (rollups, FX days and daily jobs run on the configured timezone, default Asia/Kuala_Lumpur). */
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM
  weekday: number; // 0=Sun … 6=Sat
}

export function localParts(epochMs: number, tz: string): LocalParts {
  const parts = Object.fromEntries(fmt(tz).formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]));
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday ?? 'Sun');
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, weekday: wd };
}

export function localDate(epochMs: number, tz: string): string {
  return localParts(epochMs, tz).date;
}

export function localPeriod(epochMs: number, tz: string): string {
  return localDate(epochMs, tz).slice(0, 7);
}

/** Add days to a YYYY-MM-DD date (calendar arithmetic, timezone-free). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}
