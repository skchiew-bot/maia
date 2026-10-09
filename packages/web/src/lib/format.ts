/**
 * Display formatters shared by components, charts and pages. Every metric the console shows goes through
 * one of these so the same quantity always reads the same way everywhere (§12: numbers are always text).
 */

const MINUS = '−';
const integerFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** Strips binary floating-point noise so halves round as people expect (0.575 → 57.5%, not 57.4999…%). */
function clean(n: number): number {
  return Number(n.toPrecision(15));
}

/** Anything that names an instant: epoch ms, an ISO-8601 string, or a Date. */
export type Instant = number | string | Date;

/** Epoch milliseconds for an instant; NaN when unparseable. */
export function toEpoch(value: Instant): number {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  return Date.parse(value);
}

/** `1,234,567` */
export function formatInteger(n: number): string {
  if (!Number.isFinite(n)) return '—';
  return integerFmt.format(clean(n)).replace('-', MINUS);
}

/** Generic number with fixed decimals and grouping: `1,234.5` */
export function formatNumber(n: number, decimals = 0): string {
  if (!Number.isFinite(n)) return '—';
  return clean(n)
    .toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .replace('-', MINUS);
}

function trimZero(s: string): string {
  return s.replace(/\.0$/, '');
}

/**
 * Compact magnitude: `999`, `1.2K`, `12.3K`, `123K`, `1.2M`, `1.2B`. One decimal below 100 of a unit,
 * none above — the exact value belongs in a `title` (see TokenCount).
 */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? MINUS : '';
  const a = Math.abs(n);
  const units: ReadonlyArray<[number, string]> = [
    [1e3, 'K'],
    [1e6, 'M'],
    [1e9, 'B'],
  ];
  if (Math.round(a) < 1000) return `${sign}${integerFmt.format(Math.round(a))}`;
  let idx = a >= 1e9 ? 2 : a >= 1e6 ? 1 : 0;
  const render = (i: number) => {
    const v = clean(a / units[i]![0]);
    return v.toFixed(v < 100 ? 1 : 0);
  };
  let text = render(idx);
  // 999.96K must read 1M, not 1000K: promote when rounding reaches the next unit.
  if (Number(text) >= 1000 && idx < units.length - 1) {
    idx += 1;
    text = render(idx);
  }
  return `${sign}${trimZero(text)}${units[idx]![1]}`;
}

/** Token counts use the compact form: `1.2M`. */
export const formatTokens = formatCompact;

/** `52%` from a ratio (0.52). */
export function formatPercent(ratio: number, decimals = 0): string {
  if (!Number.isFinite(ratio)) return '—';
  return `${clean(ratio * 100)
    .toFixed(decimals)
    .replace('-', MINUS)}%`;
}

/** Signed percentage change from a ratio: `+12%`, `−18%`, `0%`. */
export function formatSignedPercent(ratio: number, decimals = 0): string {
  if (!Number.isFinite(ratio)) return '—';
  const v = Number(clean(ratio * 100).toFixed(decimals));
  if (v === 0) return `0%`;
  return `${v > 0 ? '+' : MINUS}${Math.abs(v).toFixed(decimals)}%`;
}

export interface MoneyFormatOptions {
  /** Compact magnitude (`US$1.2K`). Default false. */
  compact?: boolean;
  /** Fraction digits when not compact. Default 2. */
  decimals?: number;
}

function money(prefix: string, n: number, opts: MoneyFormatOptions = {}): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? MINUS : '';
  const a = Math.abs(n);
  const body = opts.compact && a >= 1000 ? formatCompact(a) : formatNumber(a, opts.decimals ?? 2);
  return `${sign}${prefix}${body}`;
}

/** `US$12.40` — always prefixed so it cannot be mistaken for ringgit. */
export function formatUsd(n: number, opts?: MoneyFormatOptions): string {
  return money('US$', n, opts);
}

/** `RM 58.30` */
export function formatMyr(n: number, opts?: MoneyFormatOptions): string {
  return money('RM ', n, opts);
}

/**
 * Elapsed time in the console's compact style: `35s`, `4m`, `2h 14m`, `3d 2h`, `12d`.
 * Negative input (clock skew) reads as `0s`.
 */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  if (d < 7) return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`;
  return `${d}d`;
}

/** Durations read exactly like ages. */
export const formatDuration = formatAge;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Local wall-clock time, 24h: `14:05`. */
export function formatClock(value: Instant): string {
  const t = toEpoch(value);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Unambiguous local timestamp used in titles and audit views: `2026-10-08 14:05:12`. */
export function formatDateTime(value: Instant): string {
  const t = toEpoch(value);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(
    d.getMinutes(),
  )}:${pad(d.getSeconds())}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Short calendar date: `Oct 8`. A bare `YYYY-MM-DD` is read as a calendar day (no timezone shift), which is
 * what daily rollups mean.
 */
export function formatShortDate(value: Instant): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [, mm, dd] = value.split('-');
    return `${MONTHS[Number(mm) - 1] ?? mm} ${Number(dd)}`;
  }
  const t = toEpoch(value);
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Short git-style hash for display: first `length` characters. */
export function shortHash(value: string, length = 8): string {
  const v = value.startsWith('sha256:') ? value.slice(7) : value;
  return v.slice(0, length);
}
