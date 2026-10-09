import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FxRateDTO, FxSession, JsonValue, LlmJsonRequest, MetaOf } from '@aoc/contracts';
import { createTestRuntime, type TestRuntime } from '@aoc/kernel';
import { createFxModule, type FxFetcher, type FxHttpRequest, type FxHttpResponse } from '../src';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(join(here, 'fixtures/bnm-exchange-rates.html'), 'utf8');
/** Captured from the live BNM site and API on 2026-10-09 (docs/research/bnm-fx.md §8). */
const OBSERVED = join(here, '../../../docs/research/fixtures/bnm');

export const PAGE_URL = 'https://www.bnm.gov.my/exchange-rates';
export const API_BASE = 'https://api.bnm.gov.my/public/exchange-rate/USD';
export const apiUrl = (date: string, session: FxSession = '1700') =>
  `${API_BASE}/date/${date}?session=${session}`;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** GBP … HKD100 of the observed 8 Oct 2026 row (session 1700): the columns after USD. */
const OTHER_COLUMNS = ['5.3972', '4.5767', '2.5846', '4.9050', '2.8442', '2.8685', '3.1917', '52.1205'];

/** An observed BNM response file, served with `status`. */
export function observed(file: string, status = 200): FxHttpResponse {
  return { status, body: readFileSync(join(OBSERVED, file), 'utf8') };
}
/** The API's answer for a date without publication (observed for Malaysia Day 2026-09-16 and a Sunday). */
export const notPublished = (): FxHttpResponse => observed('api-USD-date-2026-09-16-holiday-404.json', 404);

/** USD/MYR middle rates, session 1700, as published 1–8 October 2026 (observed month series, raw API floats). */
export const OCTOBER_1700: [string, number][] = (
  JSON.parse(observed('api-USD-month-2026-10-session-1700.json').body) as {
    data: { rate: { date: string; middle_rate: number }[] };
  }
).data.rate.map((r) => [r.date, r.middle_rate]);

const longDate = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

/**
 * The BNM exchange-rates page in its default view (session 1700, middle rate, RM per unit): one row per publication
 * day, oldest first, ending with `date`. The newest USD figure is split over inline markup.
 */
export function bnmPage(o: { date: string; mid: number; earlier?: [string, number][] }): FxHttpResponse {
  const row = (date: string, usd: string) =>
    `        <tr><td>${longDate(date)}</td><td>${usd}</td>${OTHER_COLUMNS.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const [int, dec] = o.mid.toFixed(4).split('.') as [string, string];
  const rows = [
    ...(o.earlier ?? []).map(([d, mid]) => row(d, mid.toFixed(4))),
    row(o.date, `<span class="int">${int}</span>.<span class="dec">${dec}</span>`),
  ];
  return { status: 200, body: TEMPLATE.replace('{{ROWS}}', rows.join('\n')) };
}

/** The page as published at the end of `date` in October 2026, with the observed rows up to that day. */
export function octoberPage(date: string): FxHttpResponse {
  const rows = OCTOBER_1700.filter(([d]) => d <= date);
  const last = rows.at(-1)!;
  return bnmPage({ date: last[0], mid: last[1], earlier: rows.slice(0, -1) });
}

/**
 * BNM Open API `GET /public/exchange-rate/USD/date/<date>?session=<session>` (shape of the observed responses).
 * `mid` may be a raw float literal such as '4.0899999999999999', as the API serves it.
 */
export function bnmApi(o: { date: string; mid: number | string; session?: string }): FxHttpResponse {
  const mid = Number(o.mid);
  const r4 = (n: number) => Number(n.toFixed(4));
  const rate = `{"date":"${o.date}","buying_rate":${r4(mid - 0.002)},"selling_rate":${r4(mid + 0.002)},"middle_rate":${o.mid}}`;
  const meta = JSON.stringify({
    quote: 'rm',
    session: o.session ?? '1700',
    last_updated: `${o.date} 17:41:20`,
    total_result: 1,
  });
  return { status: 200, body: `{"data":{"currency_code":"USD","unit":1,"rate":${rate}},"meta":${meta}}` };
}

type Scripted = FxHttpResponse | Error;

/** Scripted HTTP keyed by URL: responses are consumed in order and the last one repeats. Unscripted URLs fail. */
export class ScriptedFetcher {
  readonly calls: FxHttpRequest[] = [];
  private readonly queues = new Map<string, Scripted[]>();

  page(...r: Scripted[]): this {
    return this.add(PAGE_URL, r);
  }
  /** Responses for the API's `date` endpoint, session 1700 unless given. */
  api(date: string, ...r: Scripted[]): this {
    return this.add(apiUrl(date), r);
  }
  apiSession(session: FxSession, date: string, ...r: Scripted[]): this {
    return this.add(apiUrl(date, session), r);
  }
  count(url: string): number {
    return this.calls.filter((c) => c.url === url).length;
  }
  /** Calls to the BNM Open API (any path). */
  apiCalls(): FxHttpRequest[] {
    return this.calls.filter((c) => c.url.startsWith(API_BASE));
  }
  /** Drop the remaining scripted responses (keeps the call log). */
  clear(): this {
    this.queues.clear();
    return this;
  }

  readonly fetch: FxFetcher = async (req) => {
    this.calls.push(req);
    const q = this.queues.get(req.url);
    const next = q && (q.length > 1 ? q.shift() : q[0]);
    if (!next) throw new Error(`no scripted response for ${req.url}`);
    if (next instanceof Error) throw next;
    return next;
  };

  private add(url: string, r: Scripted[]): this {
    this.queues.set(url, [...(this.queues.get(url) ?? []), ...r]);
    return this;
  }
}

const ROW_RE = new RegExp(`(\\d{1,2}) (${MONTHS.join('|')}) (\\d{4}) \\| (\\d+\\.\\d{4})`, 'g');

/** A model that does what the prompt asks: the USD figure of today's row, else of the most recent row. */
export function honestModel(req: LlmJsonRequest): JsonValue {
  const today = /Today is (\d{4}-\d{2}-\d{2})/.exec(req.prompt)?.[1];
  const rows = [...req.prompt.matchAll(ROW_RE)].map((m) => ({
    date: `${m[3]}-${String(MONTHS.indexOf(m[2]!) + 1).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`,
    usd: Number(m[4]),
    evidence: m[0],
  }));
  const row = rows.find((r) => r.date === today) ?? rows.at(-1);
  if (!row) return { usdMyr: 0, publishedDate: '', session: '', evidence: 'no USD rate in the text' };
  return { usdMyr: row.usd, publishedDate: row.date, session: '', evidence: row.evidence };
}

/** A model that misreads: returns `usdMyr` (and optionally a date) whatever the page says. */
export const wrongModel =
  (usdMyr: number, publishedDate?: string) =>
  (req: LlmJsonRequest): JsonValue => ({
    ...(honestModel(req) as Record<string, JsonValue>),
    usdMyr,
    ...(publishedDate ? { publishedDate } : {}),
  });

export interface FxTest extends TestRuntime {
  http: ScriptedFetcher;
}

export async function fxRuntime(config: Record<string, unknown> = {}): Promise<FxTest> {
  const http = new ScriptedFetcher();
  const t = await createTestRuntime({
    modules: [createFxModule({ fetcher: http.fetch })],
    config: { fx: config },
  });
  return Object.assign(t, { http });
}

/** Set the clock to `time` local (Asia/Kuala_Lumpur, UTC+8) on `date`; 21:00 is the last scheduled attempt. */
export function at(t: TestRuntime, date: string, time = '21:00'): void {
  t.clock.set(`${date}T${time}:00+08:00`);
}

/**
 * Run the daily job on `date` at `time` and surface job failures (the runtime only logs them). The default, 21:00, is
 * after the last scheduled retry, so this one attempt decides the day.
 */
export async function runDaily(t: TestRuntime, date: string, time = '21:00'): Promise<void> {
  at(t, date, time);
  await t.rt.runJob('fx.daily');
  expectJobsOk(t);
}

/** Tick the scheduler at `time` on `date`; returns the jobs that ran (failures surface). */
export async function tick(t: TestRuntime, date: string, time: string): Promise<string[]> {
  at(t, date, time);
  const ran = await t.rt.tickJobs();
  expectJobsOk(t);
  return ran;
}

function expectJobsOk(t: TestRuntime): void {
  const failed = t.rt.store.db
    .prepare(`SELECT name, last_error FROM job_runs WHERE name LIKE 'fx.%' AND last_status != 'ok'`)
    .all() as { name: string; last_error: string | null }[];
  if (failed.length) throw new Error(`${failed[0]!.name} failed: ${failed[0]!.last_error}`);
}

/** Every fx.rate_recorded meta, in log order. */
export function recorded(t: TestRuntime): MetaOf<'fx.rate_recorded'>[] {
  return t.rt.store.list({ types: ['fx.rate_recorded'] }).map((e) => e.meta as MetaOf<'fx.rate_recorded'>);
}

export async function ratesApi(
  t: TestRuntime,
  headers: Record<string, string>,
  from: string,
  to: string,
): Promise<FxRateDTO[]> {
  return (await t.json<{ rates: FxRateDTO[] }>('GET', `/api/fx/rates?from=${from}&to=${to}`, { headers }))
    .rates;
}

/** Simulate mod-metering freezing a day. */
export function closeDay(t: TestRuntime, date: string): void {
  t.rt.store.append({
    type: 'rollup.closed',
    actor: { kind: 'system', id: 'scheduler:metering' },
    meta: {
      date,
      usdNotional: 0,
      rmNotional: 0,
      fxRate: 0,
      fxStatus: 'missing',
      fxSourceDate: null,
      rateCardVersion: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      messages: 0,
      unpricedTokens: 0,
      throttleIdleMs: 0,
      throttleHits: 0,
      subscriptionUsd: 0,
      closedAt: t.clock.iso(),
    },
    payload: {
      byActor: [],
      byProject: [],
      byModel: [],
      byProcessType: [],
      unpricedModels: [],
      tierPricedModels: [],
    },
    source: 'scheduler',
  });
}
