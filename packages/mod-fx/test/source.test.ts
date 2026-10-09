import { describe, expect, it } from 'vitest';
import {
  BNM_API_ACCEPT,
  excerptForExtraction,
  htmlToText,
  parseBnmUsd,
  readOfficial,
  readPage,
} from '../src/source';
import { API_URL, bnmApi, bnmPage, PAGE_URL, ScriptedFetcher } from './helpers';

const band = { min: 3.5, max: 5.5 };

describe('BNM page', () => {
  it('strips scripts, comments and markup but keeps the rate table readable (inline spans joined)', () => {
    const text = htmlToText(bnmPage({ date: '2026-10-09', mid: 4.213 }).body);
    expect(text).toContain('Rates as at 9 October 2026, 12:00 noon.');
    expect(text).toContain('USD | 1 U.S. Dollar | 4.2080 | 4.2180 | 4.2130');
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
    expect(ex).toContain('USD | 1 U.S. Dollar | 4.2080 | 4.2180 | 4.2130');
    expect(ex).toContain('Rates as at 9 October 2026');
    expect(excerptForExtraction(page)).toBe(page);
  });
});

describe('BNM Open API', () => {
  it('sends the BNM Accept header and parses the USD middle rate', async () => {
    const http = new ScriptedFetcher().api(bnmApi({ date: '2026-10-09', mid: 4.213 }));
    expect(await readOfficial(http.fetch, API_URL, band)).toEqual({
      ok: true,
      official: { rate: 4.213, date: '2026-10-09', session: '1200' },
    });
    expect(http.calls[0]!.headers.accept).toBe(BNM_API_ACCEPT);
  });

  it('parses defensively', () => {
    const list = {
      data: [
        { currency_code: 'SGD', unit: 1, rate: { date: '2026-10-09', middle_rate: 3.2485 } },
        {
          currency_code: 'usd',
          unit: '1',
          rate: { date: '2026-10-09', buying_rate: '4.2080', selling_rate: '4.2180' },
        },
      ],
    };
    expect(parseBnmUsd(JSON.stringify(list))).toEqual({ rate: 4.213, date: '2026-10-09', session: null });
    const range = {
      data: {
        currency_code: 'USD',
        unit: 1,
        rate: [
          { date: '2026-10-08', middle_rate: 4.2 },
          { date: '2026-10-09', middle_rate: 4.21 },
        ],
      },
      meta: { session: '0900' },
    };
    expect(parseBnmUsd(JSON.stringify(range))).toEqual({ rate: 4.21, date: '2026-10-09', session: '0900' });
    const perHundred = {
      data: { currency_code: 'USD', unit: 100, rate: { date: '2026-10-09', middle_rate: 421.3 } },
    };
    expect(parseBnmUsd(JSON.stringify(perHundred))?.rate).toBe(4.213);
    const fxQuote = {
      data: { currency_code: 'USD', unit: 1, rate: { date: '2026-10-09', middle_rate: 0.25 } },
      meta: { quote: 'fx', last_updated: '2026-10-09 12:01:00' },
    };
    expect(parseBnmUsd(JSON.stringify(fxQuote))).toEqual({ rate: 4, date: '2026-10-09', session: null });
    for (const bad of [
      '<html>',
      '{}',
      '{"data":{"currency_code":"USD","rate":{"middle_rate":"n/a"}}}',
      '{"data":{"currency_code":"EUR","rate":{"middle_rate":4.9}}}',
    ]) {
      expect(parseBnmUsd(bad)).toBeNull();
    }
  });

  it('treats errors, garbage and out-of-band figures as unavailable', async () => {
    const http = new ScriptedFetcher().api(
      { status: 500, body: 'oops' },
      { status: 200, body: 'not json' },
      bnmApi({ date: '2026-10-09', mid: 42.13 }),
      new Error('ECONNRESET'),
    );
    expect((await readOfficial(http.fetch, API_URL, band)).ok).toBe(false);
    expect(await readOfficial(http.fetch, API_URL, band)).toMatchObject({
      ok: false,
      problem: 'api_unparseable',
    });
    expect(await readOfficial(http.fetch, API_URL, band)).toMatchObject({
      ok: false,
      problem: 'api_out_of_band',
    });
    expect(await readOfficial(http.fetch, API_URL, band)).toMatchObject({
      ok: false,
      problem: 'api_network_error',
    });
  });
});
