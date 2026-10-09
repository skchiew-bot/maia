# BNM USD/MYR rate: source, semantics, bounds and recommended pipeline

Research note for `mod-fx` (spec §10, risk R13). Live captures were taken 2026-10-09 between 00:04 and 01:42 UTC
(08:04–09:42 MYT), through the agent proxy, from `www.bnm.gov.my` and `api.bnm.gov.my`. Fixtures are in
[`fixtures/bnm/`](fixtures/bnm/). Evidence tags: **OBS** = observed live; **DOC** = official page text;
**NEWS** = press; **INF** = inference.

## 0. Corrections to the Wave 0 FX config defaults (`packages/contracts/src/config.ts` at commit 3f585b8, `fx` block)

| Default today | Problem (evidence) | Recommended |
| --- | --- | --- |
| `apiUrl: https://api.bnm.gov.my/public/exchange-rate/USD` (no query) | With no `session` param the API returns **session 1130**. Those are best counter rates of selected commercial banks: `middle_rate: null`, a wide spread (4.069 / 4.094 on 2026-10-08) (OBS). Comparing a scraped interbank middle rate against it gives a false discrepancy every day. | Always pass the session explicitly: `…/exchange-rate/USD?session=1700` (or `1200`, §3). Add `fx.session` to the config and stamp it on every record. |
| `pageUrl: https://www.bnm.gov.my/exchange-rates` + `runAtLocalTime: '12:30'` | The page's default view is **session 1700, Middle Rate, RM per unit** (OBS: `sessionTime=1700 selected`). At 12:30 MYT the newest 1700 row is **yesterday's**. Even the 1200 rate is not out by 12:30: each session is published about 40 minutes after its time (OBS, §5). Switching the page to 1200 by GET query string renders an empty table (OBS); the form needs a real POST. | Use **1700 middle** and run at **18:00 MYT**, retrying at 18:30 and 21:00. If the 1200 noon rate is mandated, run at 13:00 or later, use the API (`?session=1200`) for the value and scrape a POSTed page for the cross-check. |
| `reconcileTolerance: 0.005` | The page shows 4 decimals and the API float rounds to exactly the same 4-dp value for the same date and session (OBS: 1700 series equal on all 6 October days). A 0.005 tolerance hides real extraction errors, e.g. 4.0900 (1700) vs 4.0870 (1200) differ by 0.003. | Compare at 4 dp after rounding; tolerance `0.0001`. |
| `sanity: {min: 3.5, max: 5.5, maxDailyChangePct: 3}` | The band is sane (2025–26 range 3.8845–4.5130). The largest day-over-day move in 22 months was 2.235% (OBS). | Keep the hard reject at 3%. Add a soft flag above 1.25% (p99 = 1.15%) that requires API corroboration before acceptance (§6). |
| `carryForwardAlertDays: 4` | A legitimate holiday gap is up to **4 consecutive calendar days** without publication (Hari Raya 2025-03-29..04-01, OBS), so a calendar-day count of 4 alerts on a normal holiday. | Count **weekdays** without a live rate and alert at **3**. The observed maximum is 2 weekdays in 22 months. |

## 1. Sources

### 1.1 Public page (scrape target): `https://www.bnm.gov.my/exchange-rates` (OBS)

- The page is server-rendered HTML (Liferay portlet `bnm_exchange_rate_display_portlet`, about 220 KB) and
  needs no JavaScript to read.
- Form fields:
  - `sessionTime`: `0900 | 1130 | 1200 | 1700`, default **1700**.
  - `rateType`: `MR` (middle) | `BR` (buying) | `SR` (selling), default **MR**.
  - `quotation`: `rm` (Ringgit per foreign currency) | `fx` (foreign currency per Ringgit), default **rm**.
  - `monthStart`/`yearStart`/`monthEnd`/`yearEnd`.
  - The page also offers "Export to CSV" and a 1-year chart.
- The default view is a month-to-date table: one row per publication day, columns
  `USD GBP EUR JPY100 CHF AUD CAD SGD HKD100 | THB100 PHP100 TWD100 KRW100 IDR100 SAR100 SDR CNY BND | VND100 KHR100 NZD MMK100 INR100 AED100 PKR100 NPR100 EGP`.
  Row format: `8 Oct 2026 4.0900 5.3972 …`, with 4 decimals. "100" columns are per 100 units.
- Page note (DOC): *"Rates from the Interbank Foreign Exchange Market in Kuala Lumpur as at 0900, 1200 and 1700.
  Rates at 1130 are the best counter rates offered by selected commercial banks. Not all currencies and rate types
  are available."*
- Edge case (INF): on the first business day of a month, before 17:00, the default month table may have **no
  rows**. Treat that as "can't read source" and do not reach back into the previous month.
- Rendering the page with GET parameters (`…&_bnm_exchange_rate_display_portlet_sessionTime=1200…`) selected
  1200 but rendered **an empty table** (OBS). Session switching needs the form POST (with tokens). Do not build
  on GET parameters.

### 1.2 BNM Open API: `https://api.bnm.gov.my/public` (OBS)

- **Header required:** `Accept: application/vnd.BNM.API.v1+json`. Without it the API returns **HTTP 404 with an
  HTML page** (title `BNM.API`), not JSON. A parser must treat non-JSON as "can't read source".
- No auth, no key, no rate-limit headers. `cache-control: no-cache, private, max-age=2592000` and an `ETag`.
  Keep to a few requests per day.
- Endpoints used:

| Path | Returns |
| --- | --- |
| `GET /exchange-rate?session=S&quote=rm` | All currencies, latest date: `data[]` |
| `GET /exchange-rate/USD?session=S` | Latest USD rate: `data.rate{…}` |
| `GET /exchange-rate/USD/date/YYYY-MM-DD?session=S` | That day's rate, or 404 if not published |
| `GET /exchange-rate/USD/year/YYYY/month/M?session=S` | Month series: `data.rate[]` |

- Response (OBS, session 1700, 2026-10-08):

```json
{"data":{"currency_code":"USD","unit":1,"rate":{"date":"2026-10-08","buying_rate":4.0880000000000001,
 "selling_rate":4.0919999999999996,"middle_rate":4.0899999999999999}},
 "meta":{"quote":"rm","session":"1700","last_updated":"2026-10-08 23:01:23","total_result":1}}
```

- Numbers are binary floats. Round to 4 dp (`4.0899999999999999` → `4.0900`). Never compare raw floats.
- `meta.last_updated` has no timezone (MYT assumed). It was identical across sessions in each capture.
- Errors (OBS): `404 {"message":"No records found.","code":404}` for a Sunday, a public holiday, an invalid
  session (`1000`) and `quote=fx` for USD at 1200.
- Not publicly documented in a form fetchable here; the portal `apikijangportal.bnm.gov.my` is a JS app. The
  facts above are observations.

### 1.3 Secondary mirror

data.gov.my publishes `exchangerates_daily_0900/1200/1700` (source: Central Bank of Malaysia, CC BY 4.0). The
1200 dataset page shows "Data as of 08 Oct 2026, 12:00 · Last updated 12:30 · Next update 09 Oct 2026, 12:30".
Its methodology calls 0900 the start-of-day reference, 1130 the best counter rates of selected commercial banks,
1200 the mid-day reference and 1700 the end-of-day reference (DOC).

## 2. Session and rate-type semantics (DOC + OBS, USD on 2026-10-08)

| Session | Meaning | Buying | Selling | Middle |
| --- | --- | --- | --- | --- |
| 0900 | KL interbank, start of day | 4.0840 | 4.0890 | 4.0865 |
| 1130 | Best counter rates of selected commercial banks | 4.0690 | 4.0940 | **null** |
| 1200 | KL interbank, mid-day (BNM statistics reference) | 4.0850 | 4.0890 | 4.0870 |
| 1700 | KL interbank, end of day (**page default**) | 4.0880 | 4.0920 | 4.0900 |

The quotation is `rm`: Ringgit per 1 USD. Higher means a weaker ringgit. The interbank buy/sell spread at 1200
had a median of 0.0050 and a maximum of 0.0100 over 2025–26 (OBS).

## 3. Which figure AOC should use

Pin **one** definition and stamp it on every record, because the four sessions differ by up to 0.025 on the same
day:

> **AOC daily USD/MYR = BNM Kuala Lumpur interbank *middle* rate, session 1700, RM per 1 USD, for the MYT
> calendar date.**

- 1700 is what the public page shows by default, so the scrape needs no form interaction. That is the lowest
  fragility for R13.
- It is the day's closing reference, so it covers the whole metered day.
- Configure `fx.session = '1700'`. Allow `'1200'` only together with an API-first extraction, because the page
  cannot be pinned to 1200 by GET.
- The API cross-check must use **the same session, date, rate type (middle) and quotation (rm)**.

## 4. Publication calendar (OBS, 2025-01-02 → 2026-10-08, 431 publication days)

- **No weekend publications** (0 of 431). Weekends always carry forward.
- **31 weekday gaps** = Malaysian public holidays, including KL/Federal Territory days:

  2025-01-01, 01-29, 01-30, 02-11, 03-18, 03-31, 04-01, 05-01, 05-12, 06-02, 06-27, 09-01, 09-05, 09-15, 09-16,
  10-20, 12-25; 2026-01-01, 02-02, 02-17, 02-18, 03-20, 03-23, 05-01, 05-27, 06-01, 06-02, 06-17, 08-25, 08-31,
  09-16.

  These include New Year, Chinese New Year, Thaipusam, Nuzul Al-Quran, Hari Raya Aidilfitri and Haji, Labour Day,
  Wesak, the Agong's birthday, Awal Muharram, Merdeka, Maulidur Rasul, Malaysia Day, Deepavali, Christmas and
  Sunday-replacement days. Labels are informational: **do not hard-code a holiday calendar.** A 404 or a missing
  row for a past weekday is the holiday signal.
- Longest run without publication: 4 calendar days (2025-03-29 → 04-01). Longest weekday run: 2. Hence the
  alert rule in §0.
- Same-day availability: each session is published about 40 minutes after its time (§5).

## 5. Intraday availability (OBS)

`GET /exchange-rate/USD?session=0900` was polled every 2 minutes from 08:30 MYT (fixture
`api-USD-session-0900-publication-poll-2026-10-09.txt`, 37 polls):

- Until 09:37:36 MYT the API served 2026-10-08, with `last_updated: "2026-10-08 23:01:23"`.
- At **09:41:39 MYT** it served **2026-10-09**: buying 4.0880, selling 4.0930, middle 4.0905, with
  `last_updated: "2026-10-09 09:41:20"`.
- The API is therefore **updated intraday, about 40 minutes after the session time**, and `last_updated` is MYT.
  The data.gov.my mirror shows the same lag: 0900 data last updated 09:40, 1200 at 12:30, 1700 at 17:30 (DOC).
- `last_updated` had also moved to 23:01 the previous evening, so there is a later refresh. Whether it ever
  changes published values is unknown. A next-morning re-check of yesterday's figure is cheap (one call) and
  catches late revisions.

Implication: for session 1700, run at **18:00 MYT** (the 1700 rate should land around 17:40 by analogy; INF).
Retry at 18:30 and 21:00. The API cross-check can run in the same job.

## 6. Recent levels and bounds

USD/MYR middle rate, session 1200 (OBS, from the API series; full CSV in fixtures):

| Period | Low | High | First / last |
| --- | --- | --- | --- |
| 2025 | 4.0370 (2025-12-26) | 4.5130 (2025-01-06) | 4.4775 → 4.0570 |
| 2026 to 2026-10-08 | 3.8845 (2026-02-27) | 4.1530 (2026-06-22) | 4.0575 → 4.0870 |

Context (NEWS): the ringgit reached a near-8-year high around 3.89 in mid-February 2026, then weakened through
mid-2026. Kenanga forecasts 3.95 by end-2026 (NST, Aug 2026). Press summaries from October 2026 put other
houses' end-2026 forecasts up to about 4.05; that figure was not traced to a primary article.

Day-over-day change between consecutive publications, 430 moves (OBS):

| Statistic | Value |
| --- | --- |
| Median \|Δ\| | 0.189% |
| p95 | 0.844% |
| p99 | 1.151% |
| Maximum | 2.235% (2025-05-02 → 05-05, −2.235%, over a weekend; INF: the early-May 2025 Asian-currency rally) |
| Next largest | +1.697%, +1.207%, −1.164%, −1.151%, +1.124% |

Recommended validation for a candidate rate `r` for date `D`:

1. **Shape.** 4-decimal number. Row date = `D`. Session = 1700. Rate type = middle. Quotation = RM per USD. The
   USD column is the first data column (`JPY100` and `HKD100` are per 100 units and must not be confused with it).
2. **Static band.** `3.50 ≤ r ≤ 5.50`. Reject outside. The all-time context is the 3.80 peg (1998–2005), about
   2.94 in 2011 and about 4.80 in early 2024 (INF from general knowledge). The band catches unit and column mix-ups
   such as SGD 3.19, GBP 5.40 or JPY100 2.58 only partly, so rule 1 matters.
3. **Day-over-day.** Compare with the last **live** rate `r₀`. If `|r/r₀ − 1| > 3%`, reject. If it is above
   1.25%, accept only when the API figure for the same session and date agrees to 4 dp.
4. **Spread check** (API side). `buying ≤ middle ≤ selling` and `selling − buying ≤ 0.02`.
5. **Cross-check.** The API middle rate for the same session and date, rounded to 4 dp, must equal `r`.

## 7. Recommended pipeline (implements spec §10)

```text
daily @ 18:00 MYT (retry 18:30, 21:00) for date D (MYT):
  if D is Sat/Sun → fx.rate_recorded{status: inherited, reason: weekend_or_holiday, sourceDate: last live}
  html  = GET pageUrl (default view = 1700 / MR / rm)          # can't read → carry forward
  rows  = deterministic HTML→text table rows (date + USD column) # small excerpt, no LLM yet
  cand  = Haiku structured extraction {date, session, rateType, quotation, usd} from the excerpt
  ok    = validate(cand)   # §6 rules 1–3, plus "equals the deterministic parse"
  if !ok: cand = Sonnet (once) on the same excerpt; ok = validate(cand)
  if !ok: → inherited, reason: validation_failed (or source_unreadable)
  if no row for D and D is a weekday → inherited, reason: weekend_or_holiday (holiday signal)
  api   = GET apiUrl/USD/date/D?session=1700 (Accept header)  # "the true BNM published figure"
  if api 404 for D → treat as holiday or not yet published; keep the scraped value only if it is for D, else inherit
  if round4(api.middle) != round4(cand.usd):
        re-fetch page and API once; if still different →
        fx.discrepancy_raised{date: D, scraped, official} → human decision; record status per decision
  else  fx.rate_recorded{status: live, rate, extractor: haiku|sonnet, validation: pass, reason: fetched}
  after the 3rd consecutive weekday without a live rate → fx.carry_forward_alert
next morning: re-read API for D-1 (same session); if round4 changed vs the recorded live rate → fx.discrepancy_raised
```

Notes:

- The meta enums in `fx.rate_recorded` (`extractor: haiku|sonnet|api|manual|none`, `reason: fetched |
  weekend_or_holiday | source_unreadable | validation_failed | discrepancy_pending | manual_override`) already
  cover every branch. Add `session` to meta, or to the payload if meta must stay fixed.
- Store the HTML-to-text excerpt (a few hundred bytes) in the payload `rawExcerpt`, never the whole page.
- "Can't read source" means a network error, non-200, non-HTML or non-JSON, an empty table, or no USD column.
  The result is carry-forward with no ticket. "Read but mismatched" means both sources read and both valid but
  different. That is the only path to a discrepancy ticket (spec §10).
- Rate changes apply forward only; closed rollups keep their stamped rate (R12).
- If the extraction is allowed to fall back to the API value (`extractor: 'api'`), the cross-check is
  meaningless for that day. Record it as such.
- In this sandbox, Node's built-in `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21).
  curl honours it. Production hosts may differ.

## 8. Fixtures (`docs/research/fixtures/bnm/`)

| File | Content |
| --- | --- |
| `api-USD-session-{0900,1130,1200,1700}.json` | Latest USD rate per session (2026-10-08) |
| `api-USD-session-0900-publication-poll-2026-10-09.txt` | 37 timestamped polls (UTC) showing the 0900 record for 2026-10-09 appearing at 09:41 MYT |
| `api-USD-no-session-param.json` | No `session` query → 1130 (middle null) |
| `api-USD-date-2026-10-07-session-1200.json` | Date endpoint, weekday |
| `api-USD-date-2026-10-04-sunday-404.json`, `api-USD-date-2026-09-16-holiday-404.json` | No publication → 404 JSON |
| `api-USD-invalid-session-404.json`, `api-USD-quote-fx-session-1200-404.json` | 404 JSON variants |
| `api-USD-without-accept-header.response.json` | Shape of the HTML 404 returned without the Accept header |
| `api-USD-month-2026-09-session-1200.json`, `api-USD-month-2026-10-session-1700.json` | Month endpoint |
| `api-all-currencies-session-1200.json` | All-currencies endpoint (units: VND per 100, etc.) |
| `page-exchange-rates.default.excerpt.txt` | Visible text of the default page view (session 1700 / MR / rm) incl. the session note |
| `usd-myr-session-1200-2025-01-to-2026-10.csv` | 431 daily rows (date, buying, selling, middle), 4 dp |

All files are public data from Bank Negara Malaysia. Attribute "Source: Bank Negara Malaysia" wherever rates are
shown.

## 9. Sources

- BNM exchange-rate page (live, 2026-10-09): <https://www.bnm.gov.my/exchange-rates>
- BNM Open API (live, 2026-10-09): `https://api.bnm.gov.my/public/exchange-rate/…`; portal
  <https://apikijangportal.bnm.gov.my/>
- data.gov.my, Daily Exchange Rates (1200): <https://data.gov.my/data-catalogue/exchangerates_daily_1200> (also
  `_0900`, `_1700`)
- Malay Mail, 2026-02-16, "Ringgit strengthens to 3.89 against US dollar":
  <https://www.malaymail.com/news/money/2026/02/16/ringgit-strengthens-to-389-against-us-dollar-on-upbeat-gdp-outlook/209416>
- NST, 2026-08, "Kenanga sees ringgit strengthening to RM3.95 by year-end":
  <https://www.nst.com.my/amp/business/economy/2026/08/1513426/kenanga-sees-ringgit-strengthening-rm395-year-end>
- NST, 2026-10, "Ringgit poised for gains as strong growth, exports support outlook":
  <https://www.nst.com.my/amp/business/economy/2026/10/1546087/ringgit-poised-gains-strong-growth-exports-support-outlook-watch>
