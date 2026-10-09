/** Reading the two BNM sources: the exchange-rates web page (scraped) and the BNM Open API (the published figure). */
import type { FxSession } from '@aoc/contracts';

export interface FxHttpRequest {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}
export interface FxHttpResponse {
  status: number;
  body: string;
}
/** Minimal HTTP GET (injectable for tests); throws on network failure. */
export type FxFetcher = (req: FxHttpRequest) => Promise<FxHttpResponse>;

export const BNM_API_ACCEPT = 'application/vnd.BNM.API.v1+json';
/** The page's default view (a GET cannot select another session): session 1700, middle rate, RM per unit. */
export const BNM_PAGE_SESSION: FxSession = '1700';
const USER_AGENT = 'AOC-FX/1.0 (daily USD/MYR reference rate)';
const MAX_BODY_CHARS = 2_000_000;
const PAGE_TIMEOUT_MS = 20_000;
const API_TIMEOUT_MS = 10_000;

export function createHttpFetcher(fetchImpl: typeof fetch = fetch): FxFetcher {
  return async ({ url, headers, timeoutMs }) => {
    const res = await fetchImpl(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
    const body = await res.text();
    return { status: res.status, body: body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body };
  };
}

export type PageProblem = 'page_network_error' | 'page_http_status' | 'page_empty' | 'page_no_rate_text';
export type PageRead = { ok: true; text: string } | { ok: false; problem: PageProblem; detail: string };

/** "Can't read source" = network error, non-200, empty, or no rate-like text. */
export async function readPage(fetcher: FxFetcher, url: string): Promise<PageRead> {
  let res: FxHttpResponse;
  try {
    res = await fetcher({
      url,
      headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': USER_AGENT },
      timeoutMs: PAGE_TIMEOUT_MS,
    });
  } catch (err) {
    return { ok: false, problem: 'page_network_error', detail: errorText(err) };
  }
  if (res.status !== 200) return { ok: false, problem: 'page_http_status', detail: `HTTP ${res.status}` };
  const text = htmlToText(res.body);
  if (!text) return { ok: false, problem: 'page_empty', detail: 'no text content' };
  if (!hasRateLikeText(text)) {
    return { ok: false, problem: 'page_no_rate_text', detail: 'no USD rate-like text' };
  }
  return { ok: true, text };
}

/** A BNM Open API middle rate (MYR per 1 USD) for one date and session. */
export interface OfficialRate {
  rate: number;
  date: string;
  session: FxSession;
}
export type ApiProblem =
  | 'api_network_error'
  | 'api_http_status'
  | 'api_not_published'
  | 'api_unparseable'
  | 'api_wrong_session'
  | 'api_no_middle_rate'
  | 'api_wrong_date'
  | 'api_out_of_band';
export type ApiRead =
  { ok: true; official: OfficialRate } | { ok: false; problem: ApiProblem; detail: string };

/** `<apiUrl>/date/<date>?session=<session>`: one day's rate for one session, or a 404 JSON when not published. */
export function bnmApiDateUrl(apiUrl: string, date: string, session: FxSession): string {
  const u = new URL(apiUrl);
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/date/${date}`;
  u.searchParams.set('session', session);
  return u.toString();
}

/**
 * The BNM Open API USD middle rate for exactly `date` and `session`, sanity-bounded like any fetched rate. A 404 JSON
 * ("No records found.") means not published (a holiday, or not yet). Anything that is not that day's middle rate for
 * that session is unusable — notably the session 1130 counter rates (no middle rate) served when no session is sent.
 */
export async function readOfficial(
  fetcher: FxFetcher,
  q: { url: string; date: string; session: FxSession; band: { min: number; max: number } },
): Promise<ApiRead> {
  let res: FxHttpResponse;
  try {
    res = await fetcher({
      url: q.url,
      headers: { accept: BNM_API_ACCEPT, 'user-agent': USER_AGENT },
      timeoutMs: API_TIMEOUT_MS,
    });
  } catch (err) {
    return { ok: false, problem: 'api_network_error', detail: errorText(err) };
  }
  if (res.status === 404 && isNoRecords(res.body)) {
    return {
      ok: false,
      problem: 'api_not_published',
      detail: `no session ${q.session} record for ${q.date}`,
    };
  }
  // Without the BNM Accept header the API answers 404 with an HTML page: unreadable, not "not published".
  if (res.status !== 200) return { ok: false, problem: 'api_http_status', detail: `HTTP ${res.status}` };
  const quote = parseBnmUsd(res.body);
  if (!quote) return { ok: false, problem: 'api_unparseable', detail: 'no USD rate in the response' };
  if (quote.session !== q.session) {
    const got = quote.session ?? 'missing';
    return { ok: false, problem: 'api_wrong_session', detail: `session ${got}, expected ${q.session}` };
  }
  if (quote.middle === null)
    return { ok: false, problem: 'api_no_middle_rate', detail: 'middle_rate is null' };
  if (quote.date !== q.date) {
    return {
      ok: false,
      problem: 'api_wrong_date',
      detail: `dated ${quote.date ?? 'unknown'}, expected ${q.date}`,
    };
  }
  if (quote.middle < q.band.min || quote.middle > q.band.max) {
    return { ok: false, problem: 'api_out_of_band', detail: `official ${quote.middle}` };
  }
  return { ok: true, official: { rate: quote.middle, date: q.date, session: q.session } };
}

export interface BnmUsdQuote {
  /** Middle rate, MYR per 1 USD; null when the response has none (session 1130 counter rates). */
  middle: number | null;
  date: string | null;
  session: string | null;
}

/**
 * Defensive parse of a BNM Open API exchange-rate response: `data` may be one currency object or a list; `rate` may
 * be an object or a list (date ranges → latest); divided by `unit`; `meta.quote: "fx"` (foreign units per ringgit) is
 * inverted. Only `middle_rate` counts: a buying/selling midpoint is not the published middle rate.
 */
export function parseBnmUsd(body: string): BnmUsdQuote | null {
  let root: unknown;
  try {
    root = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isObject(root)) return null;
  const meta = isObject(root.meta) ? root.meta : {};
  const entries = Array.isArray(root.data) ? root.data : [root.data];
  const entry =
    entries.find((e) => isObject(e) && String(e.currency_code ?? '').toUpperCase() === 'USD') ??
    (entries.length === 1 && isObject(entries[0]) && entries[0].currency_code === undefined
      ? entries[0]
      : undefined);
  if (!isObject(entry)) return null;
  let rate: unknown = entry.rate;
  if (Array.isArray(rate)) {
    rate = rate
      .filter(isObject)
      .sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')))
      .at(-1);
  }
  if (!isObject(rate)) return null;
  const middle = num(rate.middle_rate);
  const unit = num(entry.unit) ?? 1;
  if (unit <= 0 || (middle !== null && middle <= 0)) return null;
  const value = middle === null ? null : meta.quote === 'fx' ? unit / middle : middle / unit;
  if (value !== null && !Number.isFinite(value)) return null;
  return {
    middle: value === null ? null : Math.round(value * 1e6) / 1e6,
    // The rate's own date only: `meta.last_updated` is a refresh time, not the publication date.
    date: typeof rate.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(rate.date) ? rate.date : null,
    session: typeof meta.session === 'string' ? meta.session : null,
  };
}

function isNoRecords(body: string): boolean {
  try {
    const r: unknown = JSON.parse(body);
    return (
      isObject(r) && (r.code === 404 || (typeof r.message === 'string' && /no records/i.test(r.message)))
    );
  } catch {
    return false;
  }
}

// ── page text ─────────────────────────────────────────────────────────────

const BLOCK_TAGS =
  'p|div|br|tr|li|ul|ol|table|thead|tbody|tfoot|section|article|header|footer|nav|aside|main|h[1-6]|dl|dt|dd|form|fieldset|figure|figcaption|blockquote|pre|hr|caption|label|option|select|button';

/** Visible text of an HTML page: drops scripts/styles/comments, keeps table cells apart, joins inline markup (`<b>4</b>.21`). */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|head|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
      .replace(/<(?:td|th)\b[^>]*>/gi, ' | ')
      .replace(/<\/(?:td|th)\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t\f\v\r\xa0]+/g, ' ')
    .replace(/[ |]*\n[\s|]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// No trailing \b: inline markup can glue a label to its figure ("USD4.2130").
const USD_RE = /\bUSD|U\.\s?S\.?\s*Dollar|\bUS\s+Dollar/i;
const DECIMAL_RE = /(?<![\d.])\d{1,2}\.\d{2,6}(?!\d)/;

export function hasRateLikeText(text: string): boolean {
  return USD_RE.test(text) && DECIMAL_RE.test(text);
}

const ANCHOR_RE =
  /\bUSD|U\.\s?S\.?\s*Dollar|\b\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{4}\b/gi;

/**
 * Bound the text sent to the model: the whole text when small, else the windows around USD mentions and dates,
 * densest in decimal figures first (the rate table), re-joined in page order.
 */
export function excerptForExtraction(text: string, maxChars = 12_000, radius = 600): string {
  if (text.length <= maxChars) return text;
  const spans: [number, number][] = [];
  for (const m of text.matchAll(ANCHOR_RE)) {
    const start = Math.max(0, m.index - radius);
    const end = Math.min(text.length, m.index + m[0].length + radius);
    const last = spans.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else spans.push([start, end]);
  }
  if (!spans.length) return text.slice(0, maxChars);
  const density = (s: [number, number]) => (text.slice(s[0], s[1]).match(/\d\.\d{2,6}/g) ?? []).length;
  const chosen: [number, number][] = [];
  let used = 0;
  for (const s of [...spans].sort((a, b) => density(b) - density(a))) {
    const len = Math.min(s[1] - s[0], maxChars - used);
    if (len <= 0) break;
    chosen.push([s[0], s[0] + len]);
    used += len;
  }
  return chosen
    .sort((a, b) => a[0] - b[0])
    .map(([a, b]) => text.slice(a, b))
    .join('\n…\n');
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  ndash: '–',
  mdash: '—',
  hellip: '…',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function errorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
