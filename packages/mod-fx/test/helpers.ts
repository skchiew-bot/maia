import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FxRateDTO, JsonValue, LlmJsonRequest, MetaOf } from '@aoc/contracts';
import { createTestRuntime, type TestRuntime } from '@aoc/kernel';
import { createFxModule, type FxFetcher, type FxHttpRequest, type FxHttpResponse } from '../src';

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = readFileSync(join(here, 'fixtures/bnm-exchange-rates.html'), 'utf8');
export const PAGE_URL = 'https://www.bnm.gov.my/exchange-rates';
export const API_URL = 'https://api.bnm.gov.my/public/exchange-rate/USD';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The BNM exchange-rates page as published on `date` (the USD middle rate is split over inline markup, as on the live site). */
export function bnmPage(o: { date: string; mid: number; session?: string }): FxHttpResponse {
  const [y, m, d] = o.date.split('-').map(Number) as [number, number, number];
  const [int, dec] = o.mid.toFixed(4).split('.') as [string, string];
  const body = TEMPLATE.replaceAll('{{DATE_LONG}}', `${d} ${MONTHS[m - 1]} ${y}`)
    .replaceAll('{{SESSION}}', o.session ?? '12:00 noon')
    .replaceAll('{{USD_BUY}}', (o.mid - 0.005).toFixed(4))
    .replaceAll('{{USD_SELL}}', (o.mid + 0.005).toFixed(4))
    .replaceAll('{{USD_MID_INT}}', int)
    .replaceAll('{{USD_MID_DEC}}', dec);
  return { status: 200, body };
}

/** BNM Open API `GET /public/exchange-rate/USD` response (Accept: application/vnd.BNM.API.v1+json). */
export function bnmApi(o: { date: string; mid: number; session?: string }): FxHttpResponse {
  const r4 = (n: number) => Number(n.toFixed(4));
  return {
    status: 200,
    body: JSON.stringify({
      data: {
        currency_code: 'USD',
        unit: 1,
        rate: {
          date: o.date,
          buying_rate: r4(o.mid - 0.005),
          selling_rate: r4(o.mid + 0.005),
          middle_rate: o.mid,
        },
      },
      meta: {
        quote: 'rm',
        session: o.session ?? '1200',
        last_updated: `${o.date} 12:00:00`,
        total_result: 1,
      },
    }),
  };
}

type Scripted = FxHttpResponse | Error;

/** Scripted HTTP for the page and the API: responses are consumed in order and the last one repeats. */
export class ScriptedFetcher {
  readonly calls: FxHttpRequest[] = [];
  private readonly queues = new Map<string, Scripted[]>();

  page(...r: Scripted[]): this {
    return this.add(PAGE_URL, r);
  }
  api(...r: Scripted[]): this {
    return this.add(API_URL, r);
  }
  count(url: string): number {
    return this.calls.filter((c) => c.url === url).length;
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

/** A model that reads the USD row and the "Rates as at" line of the page text it was given. */
export function honestModel(req: LlmJsonRequest): JsonValue {
  const row = /USD \| 1 U\.S\. Dollar \| (\d+\.\d+) \| (\d+\.\d+) \| (\d+\.\d+)/.exec(req.prompt);
  const at = /Rates as at (\d{1,2}) ([A-Z][a-z]+) (\d{4}), ([^.]+)\./.exec(req.prompt);
  if (!row || !at) return { usdMyr: 0, publishedDate: '', session: '', evidence: 'no USD rate in the text' };
  const date = `${at[3]}-${String(MONTHS.indexOf(at[2]!) + 1).padStart(2, '0')}-${at[1]!.padStart(2, '0')}`;
  return { usdMyr: Number(row[3]), publishedDate: date, session: at[4]!, evidence: row[0] };
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

/** Set the clock to `time` local (Asia/Kuala_Lumpur, UTC+8) on `date`. */
export function at(t: TestRuntime, date: string, time = '12:30'): void {
  t.clock.set(`${date}T${time}:00+08:00`);
}

/** Run the scheduled daily job on `date` and surface job failures (the runtime only logs them). */
export async function runDaily(t: TestRuntime, date: string): Promise<void> {
  at(t, date);
  await t.rt.runJob('fx.daily');
  const row = t.rt.store.db
    .prepare(`SELECT last_status, last_error FROM job_runs WHERE name = 'fx.daily'`)
    .get() as { last_status: string; last_error: string | null };
  if (row.last_status !== 'ok') throw new Error(`fx.daily failed: ${row.last_error}`);
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
    payload: { byActor: [], byProject: [], byModel: [], byProcessType: [], unpricedModels: [], tierPricedModels: [] },
    source: 'scheduler',
  });
}
