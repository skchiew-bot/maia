import { describe, expect, it } from 'vitest';
import {
  BNM_API_ACCEPT,
  bnmApiDateUrl,
  excerptForExtraction,
  htmlToText,
  parseBnmUsd,
  readOfficial,
  readPage,
} from '../src/source';
import {
  API_BASE,
  apiUrl,
  bnmApi,
  bnmPage,
  notPublished,
  observed,
  octoberPage,
  PAGE_URL,
  ScriptedFetcher,
} from './helpers';

const band = { min: 3.5, max: 5.5 };
const query = (date: string, session: '0900' | '1200' | '1700' = '1700') => ({
  url: apiUrl(date, session),
  date,
  session,
  band,
});

describe('BNM page', () => {
  it('strips scripts, comments and markup but keeps the month table readable (inline spans joined)', () => {
    const text = htmlToText(octoberPage('2026-10-08').body);
    expect(text).toContain('USD | GBP | EUR | JPY100 | CHF | AUD | CAD | SGD | HKD100');
    expect(text).toContain('1 Oct 2026 | 4.0880 | 5.3972');
    expect(text).toContain('8 Oct 2026 | 4.0900 | 5.3972 | 4.5767 | 2.5846');
    expect(text).toContain('as at 0900, 1200 and 1700. Rates at 1130 are the best counter rates');
    expect(text).not.toMatch(/7\.7777|1\.2345|dataLayer|padding/);
    expect(text).toContain('© Bank Negara Malaysia');
  });

  it.each([
    ['network error', new Error('getaddrinfo ENOTFOUND www.bnm.gov.my'), 'page_network_error'],
    ['non-200', { status: 503, body: '<html><body>Service Unavailable</body></html>' }, 'page_http_status'],
    [
      'empty',
      { status: 200, body: '<html><head><title>x</title></head><body>  </body></html>' },
      'page_empty',
    ],
    [
      'no rate-like text',
      { status: 200, body: '<html><body><h1>Site under maintenance</h1><p>Back at 2:00.</p></body></html>' },
      'page_no_rate_text',
    ],
  ] as const)('is unreadable on %s', async (_label, response, problem) => {
    const http = new ScriptedFetcher().page(response);
    const read = await readPage(http.fetch, PAGE_URL);
    expect(read).toMatchObject({ ok: false, problem });
  });

  it('bounds large pages to the windows around USD and dates, densest first', () => {
    const page = htmlToText(bnmPage({ date: '2026-10-09', mid: 4.213 }).body);
    const noise = 'Lorem ipsum dolor sit amet. '.repeat(1500);
    const big = `${noise}\n${page}\n${noise}`;
    const ex = excerptForExtraction(big, 4000);
    expect(ex.length).toBeLessThanOrEqual(4000 + 10);
    expect(ex).toContain('9 Oct 2026 | 4.2130');
    expect(ex).toContain('USD | GBP | EUR');
    expect(excerptForExtraction(page)).toBe(page);
  });
});

describe('BNM Open API', () => {
  it('asks for one date and one session explicitly', () => {
    expect(bnmApiDateUrl(API_BASE, '2026-10-08', '1700')).toBe(
      'https://api.bnm.gov.my/public/exchange-rate/USD/date/2026-10-08?session=1700',
    );
    expect(bnmApiDateUrl(`${API_BASE}/?session=1130&quote=rm`, '2026-10-07', '1200')).toBe(
      'https://api.bnm.gov.my/public/exchange-rate/USD/date/2026-10-07?session=1200&quote=rm',
    );
  });

  it('sends the BNM Accept header and reads the middle rate of the requested date and session', async () => {
    const http = new ScriptedFetcher()
      .api('2026-10-08', observed('api-USD-session-1700.json'))
      .apiSession('1200', '2026-10-07', observed('api-USD-date-2026-10-07-session-1200.json'));
    expect(await readOfficial(http.fetch, query('2026-10-08'))).toEqual({
      ok: true,
      official: { rate: 4.09, date: '2026-10-08', session: '1700' },
    });
    expect(http.calls[0]).toMatchObject({ url: apiUrl('2026-10-08'), headers: { accept: BNM_API_ACCEPT } });
    expect(await readOfficial(http.fetch, query('2026-10-07', '1200'))).toEqual({
      ok: true,
      official: { rate: 4.0862, date: '2026-10-07', session: '1200' },
    });
  });

  it('never yields the session 1130 counter rates served without a session (middle_rate null, no midpoint)', async () => {
    for (const file of ['api-USD-no-session-param.json', 'api-USD-session-1130.json']) {
      expect(parseBnmUsd(observed(file).body)).toEqual({ middle: null, date: '2026-10-08', session: '1130' });
      const http = new ScriptedFetcher().api('2026-10-08', observed(file));
      expect(await readOfficial(http.fetch, query('2026-10-08'))).toEqual({
        ok: false,
        problem: 'api_wrong_session',
        detail: 'session 1130, expected 1700',
      });
    }
  });

  it('distinguishes "not published" (404 JSON) from an unreadable answer (HTML 404 without the Accept header)', async () => {
    const http = new ScriptedFetcher()
      .api('2026-09-16', notPublished())
      .api('2026-10-04', observed('api-USD-date-2026-10-04-sunday-404.json', 404))
      .api('2026-10-08', {
        status: 404,
        body: '<!DOCTYPE html><html><head><title>BNM.API</title></head><body>Not Found</body></html>',
      });
    expect(await readOfficial(http.fetch, query('2026-09-16'))).toMatchObject({
      ok: false,
      problem: 'api_not_published',
    });
    expect(await readOfficial(http.fetch, query('2026-10-04'))).toMatchObject({
      problem: 'api_not_published',
    });
    expect(await readOfficial(http.fetch, query('2026-10-08'))).toEqual({
      ok: false,
      problem: 'api_http_status',
      detail: 'HTTP 404',
    });
  });

  it('rejects a figure for another date or session, without a middle rate, garbage, errors and out-of-band values', async () => {
    const http = new ScriptedFetcher().api(
      '2026-10-09',
      bnmApi({ date: '2026-10-08', mid: 4.09 }),
      bnmApi({ date: '2026-10-09', mid: 4.0875, session: '1200' }),
      {
        status: 200,
        body: bnmApi({ date: '2026-10-09', mid: 4.09 }).body.replace(
          '"middle_rate":4.09',
          '"middle_rate":null',
        ),
      },
      { status: 500, body: 'oops' },
      { status: 200, body: 'not json' },
      bnmApi({ date: '2026-10-09', mid: 42.13 }),
      new Error('ECONNRESET'),
    );
    const problems = [];
    for (let i = 0; i < 7; i++) {
      const r = await readOfficial(http.fetch, query('2026-10-09'));
      problems.push(r.ok ? 'ok' : r.problem);
    }
    expect(problems).toEqual([
      'api_wrong_date',
      'api_wrong_session',
      'api_no_middle_rate',
      'api_http_status',
      'api_unparseable',
      'api_out_of_band',
      'api_network_error',
    ]);
  });

  it('parses defensively: lists, ranges (latest), units, fx quotes — and only the published middle rate', () => {
    const list = {
      data: [
        { currency_code: 'SGD', unit: 1, rate: { date: '2026-10-09', middle_rate: 3.2485 } },
        { currency_code: 'usd', unit: '1', rate: { date: '2026-10-09', middle_rate: '4.2130' } },
      ],
      meta: { session: '1700' },
    };
    expect(parseBnmUsd(JSON.stringify(list))).toEqual({ middle: 4.213, date: '2026-10-09', session: '1700' });
    expect(parseBnmUsd(observed('api-USD-month-2026-10-session-1700.json').body)).toEqual({
      middle: 4.09,
      date: '2026-10-08',
      session: '1700',
    });
    const perHundred = {
      data: { currency_code: 'USD', unit: 100, rate: { date: '2026-10-09', middle_rate: 421.3 } },
    };
    expect(parseBnmUsd(JSON.stringify(perHundred))?.middle).toBe(4.213);
    const fxQuote = {
      data: { currency_code: 'USD', unit: 1, rate: { date: '2026-10-09', middle_rate: 0.25 } },
      meta: { quote: 'fx', last_updated: '2026-10-09 12:01:00' },
    };
    expect(parseBnmUsd(JSON.stringify(fxQuote))).toEqual({ middle: 4, date: '2026-10-09', session: null });
    // Buying and selling only: their midpoint is not the published middle rate.
    const noMiddle = {
      data: {
        currency_code: 'USD',
        unit: 1,
        rate: { date: '2026-10-07', buying_rate: 4.0845, selling_rate: 4.0878 },
      },
      meta: { session: '1200', last_updated: '2026-10-08 23:01:23' },
    };
    expect(parseBnmUsd(JSON.stringify(noMiddle))).toEqual({
      middle: null,
      date: '2026-10-07',
      session: '1200',
    });
    // The rate's own date only: last_updated is a refresh time.
    const undated = {
      data: { currency_code: 'USD', rate: { middle_rate: 4.09 } },
      meta: { last_updated: '2026-10-08 23:01:23' },
    };
    expect(parseBnmUsd(JSON.stringify(undated))?.date).toBeNull();
    for (const bad of [
      '<html>',
      '{}',
      '{"data":{"currency_code":"EUR","rate":{"middle_rate":4.9}}}',
      '{"data":{"currency_code":"USD","unit":0,"rate":{"middle_rate":4.9}}}',
    ]) {
      expect(parseBnmUsd(bad)).toBeNull();
    }
  });
});
