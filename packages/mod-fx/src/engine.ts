/**
 * The daily FX run (§10, R13) for today's local date D, at fx.runAtLocalTime and again at each fx.retryAtLocalTimes.
 * The rate is BNM's Kuala Lumpur interbank middle rate for fx.session, RM per 1 USD, stamped with that session.
 *   weekend → inherit (no fetch)
 *   session 1700 (the page's default view):
 *     page unreadable → carry forward (flagged; a scheduled retry tries again)
 *     → Haiku extract → self-validate → Sonnet once → still failing: carry forward (flagged)
 *     → no row for D yet → wait for a retry; at the last attempt: holiday (or, if the API has D, a stale page: flagged)
 *     → reconcile with the BNM Open API for (D, session) at 4 dp — exactly when the move is above the soft flag
 *       → API cannot confirm → wait for a retry; at the last attempt record it unreconciled, except a soft-flagged
 *         move, which is carried forward (flagged)
 *       → mismatch → re-fetch + re-extract once → still mismatched: discrepancy decision, day carried forward (flagged)
 *   session 0900 / 1200: the API figure for (D, session), sanity-bounded; the page cannot show it, so no cross-check.
 * The first run of a day first re-checks the previous weekday if it was carried forward and BNM has since published it.
 * Every day is stamped live or inherited with its source date; closed days are never restated.
 */
import type {
  Actor,
  FxDiscrepancyChoice,
  FxExtractor,
  FxRateDTO,
  FxReason,
  FxRunOutcome,
  FxRunResultDTO,
  FxSession,
  FxValidation,
  LlmService,
  MetaOf,
  PayloadOf,
  StoredEvent,
  User,
} from '@aoc/contracts';
import { HttpError, localDate, localParts, type ModuleContext, type NewEvent } from '@aoc/kernel';
import {
  BNM_PAGE_SESSION,
  bnmApiDateUrl,
  excerptForExtraction,
  readOfficial,
  readPage,
  type ApiRead,
  type FxFetcher,
  type OfficialRate,
} from './source';
import { extractRate, type ExtractionAttempt, type ExtractionOutcome } from './extract';
import {
  FX_BODY_SCOPE,
  toRateDTO,
  type FxDiscrepancyRow,
  type FxRateRow,
  type FxReadModel,
} from './read-model';
import { isCalendarDate, isWeekend, movePct, pipsApart, previousWeekday, reconciles } from './rules';

export interface FxTrigger {
  actor: Actor;
  source: 'scheduler' | 'api' | 'system';
  /**
   * Scheduled attempts only. `first` (the daily job) also re-checks the previous weekday; a `retry` re-attempts only a
   * day not recorded yet (awaiting publication) or whose source was unreadable.
   */
  attempt?: 'first' | 'retry';
}
/** Raises discrepancy decisions (never a human, so no approver is excluded by separation of duties). */
export const FX_SYSTEM_ACTOR: Actor = { kind: 'system', id: 'scheduler:fx' };

type RateMeta = MetaOf<'fx.rate_recorded'>;
type RatePayload = NonNullable<PayloadOf<'fx.rate_recorded'>>;
type Extracted = Extract<ExtractionOutcome, { ok: true }>;

/** One attempt at date D. `final`: no scheduled attempt remains today, so whatever this one finds decides the day. */
interface Attempt {
  t: FxTrigger;
  date: string;
  prior: FxRateRow | null;
  final: boolean;
}

export class FxEngine {
  private chain: Promise<unknown> = Promise.resolve();
  /** The last previous weekday re-checked conclusively (in memory: a restart re-checks it at most once more). */
  private recheckedThrough: string | null = null;

  constructor(
    private readonly ctx: ModuleContext,
    private readonly model: FxReadModel,
    private readonly deps: { fetcher: FxFetcher; llm: () => LlmService },
  ) {}

  today(): string {
    return localDate(this.ctx.clock.now(), this.ctx.config.timezone);
  }

  /** Resolves once queued runs / overrides have finished. */
  idle(): Promise<unknown> {
    return this.chain;
  }

  run(trigger: FxTrigger): Promise<FxRunResultDTO> {
    return this.exclusive(async () => {
      const date = this.today();
      if (trigger.attempt === 'first' && this.ctx.config.fx.recheckPreviousWeekday) {
        await this.recheckPreviousWeekday(trigger, date);
      }
      return this.runDay(trigger, date, this.isFinalAttempt(date));
    });
  }

  /** Approver override for a day that metering has not closed (resolves an open discrepancy for that day). */
  override(input: { date: string; rate: number; reason: string }, user: User): Promise<FxRateDTO> {
    return this.exclusive(async () => {
      const { date, rate, reason } = input;
      const { min, max } = this.ctx.config.fx.sanity;
      if (!isCalendarDate(date)) {
        throw new HttpError(422, 'invalid_date', 'date must be a calendar date (YYYY-MM-DD)');
      }
      if (date > this.today()) throw new HttpError(422, 'future_date', 'Rates cannot be set for future days');
      if (!(rate >= min && rate <= max)) {
        throw new HttpError(422, 'out_of_band', `Rate must be within the sanity band ${min}–${max}`);
      }
      if (this.model.isClosed(date)) {
        throw new HttpError(
          409,
          'day_closed',
          `${date} is closed by metering; closed days are never restated`,
        );
      }
      const actor: Actor = { kind: 'human', id: user.id };
      // The approver enters the figure for the session AOC records now.
      const session = this.ctx.config.fx.session;
      const open = this.model.openDiscrepancyFor(date);
      if (open) {
        const decisions = this.ctx.services.get('decisions');
        if (decisions.get(open.decisionId)?.status === 'open') {
          try {
            await decisions.resolve(open.decisionId, { optionId: 'manual', comment: reason }, user);
          } catch (err) {
            throw new HttpError(
              409,
              'decision_not_resolvable',
              `The discrepancy decision cannot be resolved by you: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        this.applyResolution(
          open,
          {
            choice: 'manual',
            rate,
            sourceDate: date,
            extractor: 'manual',
            validation: 'not_applicable',
            session,
            notes: reason,
          },
          actor,
          'api',
        );
        if (this.model.isClosed(date)) {
          throw new HttpError(
            409,
            'day_closed',
            `${date} was closed by metering meanwhile; the decision is recorded but the day is not restated`,
          );
        }
      } else {
        const meta: RateMeta = {
          date,
          pair: 'USD/MYR',
          rate,
          status: 'live',
          sourceDate: date,
          extractor: 'manual',
          validation: 'not_applicable',
          reason: 'manual_override',
          session,
        };
        this.ctx.store.append({
          type: 'fx.rate_recorded',
          actor,
          meta,
          payload: { notes: reason },
          source: 'api',
          bodyScope: FX_BODY_SCOPE,
        });
      }
      return toRateDTO(this.model.record(date)!, false);
    });
  }

  /** Reactor: a human resolved an fx_discrepancy decision. Idempotent (only open discrepancies; keyed appends). */
  onDecisionResolved(e: StoredEvent): void {
    const m = e.meta as MetaOf<'decision.resolved'>;
    if (m.kind !== 'fx_discrepancy') return;
    const d = this.model.discrepancyByDecision(m.decisionId);
    if (!d || d.status !== 'open') return;
    const session = d.bnmSession ?? undefined;
    if (m.optionId === 'accept_official') {
      this.applyResolution(
        d,
        {
          choice: 'accept_official',
          rate: d.official,
          sourceDate: d.officialDate ?? d.date,
          extractor: 'api',
          validation: 'pass',
          session,
        },
        e.actor,
        'system',
        e.id,
      );
    } else if (m.optionId === 'accept_scraped') {
      this.applyResolution(
        d,
        {
          choice: 'accept_scraped',
          rate: d.scraped,
          sourceDate: d.scrapedDate ?? d.date,
          extractor: d.extractor ?? 'haiku',
          validation: 'pass',
          session,
        },
        e.actor,
        'system',
        e.id,
      );
    }
    // 'manual': the day stays carried forward until the approver records the rate via the override route.
  }

  // ── the daily run ─────────────────────────────────────────────────────────

  /** One attempt at `date`; `final` when no scheduled attempt remains for it. */
  private async runDay(t: FxTrigger, date: string, final: boolean): Promise<FxRunResultDTO> {
    if (this.model.isClosed(date)) return this.result(date, 'skipped_closed');
    const existing = this.model.record(date);
    // A human-set rate is final for the day; only another override changes it.
    if (existing?.reason === 'manual_override') return this.result(date, 'skipped_manual');
    if (existing?.status === 'live') return this.result(date, 'skipped_live');
    const open = this.model.openDiscrepancyFor(date);
    if (open) return this.result(date, 'skipped_discrepancy', { decisionId: open.decisionId });
    // Retries exist for a rate that is not published yet, or a source that could not be read; anything else is settled
    // (a failed Sonnet escalation stops for the day, §10). The approver can still run it again by hand.
    if (t.attempt === 'retry' && existing && existing.reason !== 'source_unreadable') {
      return this.result(date, 'unchanged');
    }
    const a: Attempt = { t, date, prior: this.model.latestBefore(date), final };
    if (isWeekend(date) && a.prior)
      return this.carryForward(a, 'weekend_or_holiday', 'none', 'not_applicable', {});
    return this.ctx.config.fx.session === BNM_PAGE_SESSION ? this.fromPage(a) : this.fromApi(a);
  }

  /**
   * The previous weekday was carried forward because nothing could be read (a holiday stamp or an unreadable source),
   * but BNM may have published it since: if the API now has it, that day is attempted again. A failed extraction is
   * not re-checked (the Sonnet escalation stops for the day). Metering normally closes the day at 00:15, and a closed
   * day is never restated (R12), so then the late figure is only reported.
   */
  private async recheckPreviousWeekday(t: FxTrigger, today: string): Promise<void> {
    const date = previousWeekday(today);
    // Each weekday is re-checked once: a weekend's first runs would otherwise look at the same Friday again.
    if (date === this.recheckedThrough) return;
    const r = this.model.record(date);
    if (
      r?.status !== 'inherited' ||
      !(r.reason === 'weekend_or_holiday' || r.reason === 'source_unreadable')
    ) {
      return;
    }
    const api = await this.readApi(date);
    if (!api.ok) {
      // Still unpublished: a holiday. An unreadable answer is tried again at the next first run.
      if (api.problem === 'api_not_published') this.recheckedThrough = date;
      return;
    }
    this.recheckedThrough = date;
    if (this.model.isClosed(date)) {
      const f = (n: number) => n.toFixed(4);
      this.ctx.notify({
        kind: 'fx.alert',
        title: `BNM published USD/MYR ${f(api.official.rate)} for ${date} (session ${api.official.session}) after it was carried forward; metering has closed ${date}, so it keeps ${f(r.rate)} from ${r.sourceDate}`,
        audience: ['approver', 'builder'],
        severity: 'info',
        link: '/fx',
        refs: { date },
      });
      return;
    }
    const res = await this.runDay({ actor: t.actor, source: t.source }, date, true);
    this.ctx.log.info('fx: re-checked the previous weekday', { date, outcome: res.outcome });
  }

  /** No scheduled attempt remains today (weekends never get a later one). */
  private isFinalAttempt(date: string): boolean {
    if (isWeekend(date)) return true;
    const now = localParts(this.ctx.clock.now(), this.ctx.config.timezone).time;
    return !this.ctx.config.fx.retryAtLocalTimes.some((time) => time > now);
  }

  /** Session 1700: scrape the page (its default view shows 1700), then reconcile with the BNM Open API. */
  private async fromPage(a: Attempt): Promise<FxRunResultDTO> {
    const cfg = this.ctx.config.fx;
    const page = await readPage(this.deps.fetcher, cfg.pageUrl);
    if (!page.ok) {
      return this.carryForward(a, 'source_unreadable', 'none', 'not_applicable', {
        sourceUrl: cfg.pageUrl,
        problems: [page.problem],
        notes: page.detail,
      });
    }
    const first = await this.extract(a, page.text);
    if (!first.ok) {
      return this.carryForward(a, 'validation_failed', 'sonnet', 'fail', {
        sourceUrl: cfg.pageUrl,
        problems: problemsOf(first.attempts),
        attempts: first.attempts,
      });
    }
    const api = await this.readApi(a.date);
    if (first.value.publishedDate !== a.date) return this.notOnPage(a, first, api);
    const soft = this.softFlag(first.value.usdMyr, a.prior);
    if (!api.ok) return this.unconfirmed(a, first, api, soft);
    if (this.agrees(first, api.official, soft)) return this.recordLive(a, first, api.official, soft);

    // Read but mismatched: re-fetch and re-extract once (and re-read the API; keep the first figure if it is now unavailable).
    const page2 = await readPage(this.deps.fetcher, cfg.pageUrl);
    const again = page2.ok ? await this.extract(a, page2.text) : null;
    const second = again?.ok && again.value.publishedDate === a.date ? again : null;
    const api2 = await this.readApi(a.date);
    const official = api2.ok ? api2.official : api.official;
    if (second) {
      const soft2 = this.softFlag(second.value.usdMyr, a.prior);
      if (this.agrees(second, official, soft2)) return this.recordLive(a, second, official, soft2);
    }
    const confirmed = second ?? first;
    return this.raiseDiscrepancy(
      a,
      confirmed,
      second !== null,
      official,
      [...first.attempts, ...(again?.attempts ?? [])],
      this.softFlag(confirmed.value.usdMyr, a.prior),
    );
  }

  /** The page shows no row for D: not published yet (wait for a retry) or, at the last attempt, a public holiday. */
  private notOnPage(a: Attempt, ex: Extracted, api: ApiRead): FxRunResultDTO {
    if (!a.final) {
      return this.result(a.date, 'awaiting_publication', {
        problems: [api.ok ? 'page_not_updated' : 'not_published'],
      });
    }
    if (api.ok) {
      // BNM published D (the API has it) but the page still shows an older day: the scrape could not read D.
      return this.carryForward(a, 'source_unreadable', 'none', 'not_applicable', {
        ...this.scrapedPayload(ex),
        official: api.official.rate,
        officialDate: api.official.date,
        problems: ['page_not_updated'],
        attempts: ex.attempts,
      });
    }
    const meta: RateMeta = {
      date: a.date,
      pair: 'USD/MYR',
      rate: ex.value.usdMyr,
      status: 'inherited',
      sourceDate: ex.value.publishedDate,
      extractor: ex.model,
      validation: 'pass',
      reason: 'weekend_or_holiday',
      session: this.ctx.config.fx.session,
    };
    const payload: RatePayload = { ...this.scrapedPayload(ex), attempts: ex.attempts };
    if (api.problem !== 'api_not_published') {
      payload.notes = `BNM Open API unreadable (${api.problem}: ${api.detail}); holiday inferred from the page alone`;
    }
    return this.write(a, meta, payload, 'inherited');
  }

  /** The page has D's figure but the API cannot confirm it: wait for a retry; at the last attempt decide without it. */
  private unconfirmed(
    a: Attempt,
    ex: Extracted,
    api: Extract<ApiRead, { ok: false }>,
    soft: number | null,
  ): FxRunResultDTO {
    if (!a.final) return this.result(a.date, 'awaiting_corroboration', { problems: [api.problem] });
    if (soft === null) return this.recordLive(a, ex, null, null, `${api.problem}: ${api.detail}`);
    // A move above the soft flag is never accepted on the page alone.
    const cfg = this.ctx.config.fx;
    const move = `${soft.toFixed(2)}%`;
    this.ctx.notify({
      kind: 'fx.alert',
      title: `USD/MYR ${a.date}: a ${move} move on the BNM page could not be confirmed by the BNM Open API — carried forward, check it manually`,
      audience: ['approver', 'builder'],
      severity: 'warn',
      link: '/fx',
      refs: { date: a.date },
    });
    return this.carryForward(a, 'validation_failed', ex.model, 'fail', {
      ...this.scrapedPayload(ex),
      problems: ['soft_flag_unconfirmed', api.problem],
      notes: `Day-over-day move ${move} is above the ${cfg.sanity.softFlagPct}% soft flag and the BNM Open API could not confirm it (${api.problem}: ${api.detail})`,
      attempts: ex.attempts,
    });
  }

  /** Session 0900 / 1200: the page cannot show that session without a form POST, so the API figure is the rate. */
  private async fromApi(a: Attempt): Promise<FxRunResultDTO> {
    const cfg = this.ctx.config.fx;
    const sourceUrl = bnmApiDateUrl(cfg.apiUrl, a.date, cfg.session);
    const api = await this.readApi(a.date);
    if (!api.ok) {
      if (api.problem === 'api_not_published') {
        if (!a.final) return this.result(a.date, 'awaiting_publication', { problems: ['not_published'] });
        return this.carryForward(a, 'weekend_or_holiday', 'none', 'not_applicable', { sourceUrl });
      }
      const payload: RatePayload = { sourceUrl, problems: [api.problem], notes: api.detail };
      return api.problem === 'api_out_of_band'
        ? this.carryForward(a, 'validation_failed', 'api', 'fail', payload)
        : this.carryForward(a, 'source_unreadable', 'none', 'not_applicable', payload);
    }
    const { rate } = api.official;
    if (a.prior && movePct(rate, a.prior.rate) > cfg.sanity.maxDailyChangePct) {
      return this.carryForward(a, 'validation_failed', 'api', 'fail', {
        sourceUrl,
        official: rate,
        officialDate: a.date,
        problems: ['daily_change_exceeded'],
      });
    }
    const soft = this.softFlag(rate, a.prior);
    const notes = [
      `BNM Open API figure for session ${cfg.session}; not cross-checked with the page, whose default view is session ${BNM_PAGE_SESSION}`,
    ];
    if (soft !== null) {
      notes.push(
        `day-over-day move ${soft.toFixed(2)}% is above the ${cfg.sanity.softFlagPct}% soft flag (accepted: it is the published figure)`,
      );
    }
    const meta: RateMeta = {
      date: a.date,
      pair: 'USD/MYR',
      rate,
      status: 'live',
      sourceDate: a.date,
      extractor: 'api',
      validation: 'pass',
      reason: 'fetched',
      session: cfg.session,
    };
    return this.write(
      a,
      meta,
      { sourceUrl, official: rate, officialDate: a.date, notes: notes.join('. ') },
      'live',
    );
  }

  private extract(a: Attempt, pageText: string): Promise<ExtractionOutcome> {
    const text = excerptForExtraction(pageText);
    return extractRate(
      this.deps.llm(),
      { text, sourceUrl: this.ctx.config.fx.pageUrl, today: a.date, timezone: this.ctx.config.timezone },
      {
        today: a.date,
        sanity: this.ctx.config.fx.sanity,
        priorRate: a.prior?.rate ?? null,
        minPublishedDate: a.prior?.sourceDate ?? null,
        sourceText: text,
      },
    );
  }

  /** The BNM Open API figure for exactly (date, configured session). */
  private readApi(date: string): Promise<ApiRead> {
    const cfg = this.ctx.config.fx;
    return readOfficial(this.deps.fetcher, {
      url: bnmApiDateUrl(cfg.apiUrl, date, cfg.session),
      date,
      session: cfg.session,
      band: cfg.sanity,
    });
  }

  /** The day-over-day move (%) when it is above the soft flag, else null. */
  private softFlag(rate: number, prior: FxRateRow | null): number | null {
    if (!prior) return null;
    const pct = movePct(rate, prior.rate);
    return pct > this.ctx.config.fx.sanity.softFlagPct ? pct : null;
  }

  private agrees(ex: Extracted, official: OfficialRate, soft: number | null): boolean {
    return reconciles(ex.value.usdMyr, official.rate, {
      tolerance: this.ctx.config.fx.reconcileTolerance,
      exact: soft !== null,
    });
  }

  private recordLive(
    a: Attempt,
    ex: Extracted,
    official: OfficialRate | null,
    soft: number | null,
    apiProblem?: string,
  ): FxRunResultDTO {
    const cfg = this.ctx.config.fx;
    const meta: RateMeta = {
      date: a.date,
      pair: 'USD/MYR',
      rate: ex.value.usdMyr,
      status: 'live',
      sourceDate: a.date,
      extractor: ex.model,
      validation: 'pass',
      reason: 'fetched',
      session: cfg.session,
    };
    const payload: RatePayload = { ...this.scrapedPayload(ex), attempts: ex.attempts };
    if (official) {
      payload.official = official.rate;
      payload.officialDate = official.date;
    } else {
      payload.notes = `BNM Open API could not confirm it (${apiProblem}); scraped figure recorded without reconciliation`;
    }
    if (soft !== null) {
      payload.notes = `Day-over-day move ${soft.toFixed(2)}% is above the ${cfg.sanity.softFlagPct}% soft flag; the BNM Open API agrees exactly at 4 dp`;
    }
    return this.write(a, meta, payload, 'live');
  }

  private carryForward(
    a: Attempt,
    reason: FxReason,
    extractor: FxExtractor,
    validation: FxValidation,
    payload: RatePayload,
  ): FxRunResultDTO {
    if (!a.prior) {
      // A retry is coming for an unreadable source: only its last attempt raises the alarm.
      if (a.final || reason !== 'source_unreadable') {
        this.ctx.notify({
          kind: 'fx.alert',
          title: `No USD/MYR rate for ${a.date}: ${reason.replace(/_/g, ' ')} and no earlier rate to carry forward`,
          audience: ['approver', 'builder'],
          severity: 'danger',
          link: '/fx',
          refs: { date: a.date },
        });
      }
      return this.result(a.date, 'no_rate', { problems: payload.problems });
    }
    const outcome: FxRunOutcome = reason === 'weekend_or_holiday' ? 'inherited' : 'carried_forward';
    return this.write(a, inherit(a.date, a.prior, extractor, validation, reason), payload, outcome);
  }

  private raiseDiscrepancy(
    a: Attempt,
    confirmed: Extracted,
    refetchConfirmed: boolean,
    official: OfficialRate,
    attempts: ExtractionAttempt[],
    soft: number | null,
  ): FxRunResultDTO {
    const { t, date, prior } = a;
    const cfg = this.ctx.config.fx;
    const s = confirmed.value;
    const f = (n: number) => n.toFixed(4);
    const diff = (pipsApart(s.usdMyr, official.rate) / 1e4).toFixed(4);
    const detail = [
      `Original confirmed figure: ${f(s.usdMyr)} scraped from ${cfg.pageUrl} by ${confirmed.model}, published ${s.publishedDate}, session ${cfg.session}; ${refetchConfirmed ? 're-confirmed by one re-fetch' : 'the one re-fetch could not be read or validated'}.`,
      `Conflicting figure: ${f(official.rate)} from the BNM Open API for ${official.date}, session ${official.session}.`,
      soft === null
        ? `At 4 dp they differ by ${diff}, more than the reconcile tolerance ${cfg.reconcileTolerance}.`
        : `The day-over-day move ${soft.toFixed(2)}% is above the ${cfg.sanity.softFlagPct}% soft flag, so the figures must agree exactly at 4 dp; they differ by ${diff}.`,
      prior
        ? `Until resolved, ${date} carries forward ${f(prior.rate)} from ${prior.sourceDate} (flagged).`
        : `No earlier rate exists, so ${date} has no rate until resolved.`,
      `Resolve before metering closes ${date}: a closed day is never restated.`,
      `Page evidence (untrusted text): "${s.evidence}"`,
    ].join('\n');
    const decisions = this.ctx.services.get('decisions');
    const card = decisions.request(
      {
        kind: 'fx_discrepancy',
        title: `USD/MYR ${date}: scraped ${f(s.usdMyr)} vs BNM ${f(official.rate)}`,
        question: `The BNM page and the BNM published figure still disagree after one re-fetch. Which USD/MYR rate should ${date} use?`,
        options: [
          {
            id: 'accept_official',
            label: `Use the BNM published figure ${f(official.rate)}`,
            description: `BNM Open API middle rate, session ${official.session}`,
          },
          {
            id: 'accept_scraped',
            label: `Use the scraped figure ${f(s.usdMyr)}`,
            description: `Extracted from the BNM page by ${confirmed.model}`,
          },
          {
            id: 'manual',
            label: 'Enter the rate manually',
            description: `Then record it with POST /api/fx/rates/${date}/override`,
          },
        ],
        recommendation: {
          optionId: 'accept_official',
          rationale:
            'The BNM Open API is the published reference figure; the page scrape is the fragile source.',
        },
        context: detail,
        subjectType: 'fx_day',
        subjectId: date,
        requesterId: FX_SYSTEM_ACTOR.id,
      },
      t.actor,
    );
    const events: NewEvent[] = [
      {
        type: 'fx.discrepancy_raised',
        actor: t.actor,
        source: t.source,
        bodyScope: FX_BODY_SCOPE,
        meta: {
          date,
          scraped: s.usdMyr,
          official: official.rate,
          decisionId: card.id,
          scrapedDate: s.publishedDate,
          officialDate: official.date,
          extractor: confirmed.model,
          session: official.session,
        },
        payload: { detail, evidence: s.evidence, attempts },
      },
    ];
    const meta = prior ? inherit(date, prior, confirmed.model, 'fail', 'discrepancy_pending') : null;
    if (meta) {
      events.push({
        type: 'fx.rate_recorded',
        actor: t.actor,
        source: t.source,
        bodyScope: FX_BODY_SCOPE,
        meta,
        payload: {
          ...this.scrapedPayload(confirmed),
          official: official.rate,
          officialDate: official.date,
          problems: ['reconcile_mismatch'],
          attempts,
        },
      });
    }
    try {
      this.ctx.store.appendMany(events);
    } catch (err) {
      decisions.withdraw(card.id, 'fx_append_failed', t.actor);
      throw err;
    }
    if (meta) this.afterRecord(meta, t);
    return this.result(date, 'discrepancy', { decisionId: card.id, problems: ['reconcile_mismatch'] });
  }

  private applyResolution(
    d: FxDiscrepancyRow,
    r: {
      choice: FxDiscrepancyChoice;
      rate: number;
      sourceDate: string;
      extractor: FxExtractor;
      validation: FxValidation;
      session: FxSession | undefined;
      notes?: string;
    },
    actor: Actor,
    source: 'api' | 'system',
    causationId?: string,
  ): void {
    // A resolution arriving after metering froze the day is audited but never restates it (R12).
    const applied = !this.model.isClosed(d.date);
    const events: NewEvent[] = [
      {
        type: 'fx.discrepancy_resolved',
        actor,
        source,
        causationId,
        idempotencyKey: `fx:discrepancy_resolved:${d.decisionId}`,
        meta: { date: d.date, chosenRate: r.rate, decisionId: d.decisionId, choice: r.choice, applied },
      },
    ];
    const meta: RateMeta = {
      date: d.date,
      pair: 'USD/MYR',
      rate: r.rate,
      status: r.sourceDate === d.date ? 'live' : 'inherited',
      sourceDate: r.sourceDate,
      extractor: r.extractor,
      validation: r.validation,
      reason: 'manual_override',
      ...(r.session ? { session: r.session } : {}),
    };
    if (applied) {
      const payload: RatePayload = { notes: r.notes ?? `Discrepancy decision ${d.decisionId}: ${r.choice}` };
      if (r.choice !== 'manual') payload.official = d.official;
      events.push({
        type: 'fx.rate_recorded',
        actor,
        source,
        causationId,
        idempotencyKey: `fx:rate:${d.decisionId}`,
        bodyScope: FX_BODY_SCOPE,
        meta,
        payload,
      });
    }
    this.ctx.store.appendMany(events);
    if (applied) this.afterRecord(meta, { actor, source });
    else {
      this.ctx.notify({
        kind: 'fx.alert',
        title: `FX discrepancy for ${d.date} resolved after the day closed — the day keeps its carried-forward rate`,
        audience: ['approver', 'builder'],
        severity: 'info',
        link: '/fx',
        refs: { date: d.date, decisionId: d.decisionId },
      });
    }
  }

  // ── recording ─────────────────────────────────────────────────────────────

  private write(a: Attempt, meta: RateMeta, payload: RatePayload, outcome: FxRunOutcome): FxRunResultDTO {
    const existing = this.model.record(meta.date);
    const problems = payload.problems ?? [];
    const changed = !existing || !sameStamp(existing, meta);
    if (changed) {
      this.ctx.store.append({
        type: 'fx.rate_recorded',
        actor: a.t.actor,
        meta,
        payload,
        source: a.t.source,
        bodyScope: FX_BODY_SCOPE,
      });
    }
    // An unreadable source that a scheduled retry will try again is not the day's last word yet.
    if (a.final || meta.reason !== 'source_unreadable') this.afterRecord(meta, a.t);
    return this.result(meta.date, changed ? outcome : 'unchanged', { problems });
  }

  /** After N weekdays in a row without a live rate, ask for a manual check — once per streak. */
  private afterRecord(meta: RateMeta, t: Pick<FxTrigger, 'actor' | 'source'>): void {
    if (meta.status !== 'inherited') return;
    const threshold = this.ctx.config.fx.carryForwardAlertWeekdays;
    const { days, since } = this.model.carryForwardStreak(meta.date);
    if (days < threshold || !since || this.model.hasAlert(since)) return;
    this.ctx.store.append({
      type: 'fx.carry_forward_alert',
      actor: t.actor,
      meta: { consecutiveDays: days, since, date: meta.date },
      source: t.source,
    });
    this.ctx.notify({
      kind: 'fx.alert',
      title: `No live USD/MYR rate for ${days} weekdays in a row (since ${since}) — manual check needed`,
      audience: ['approver', 'builder'],
      severity: 'warn',
      link: '/fx',
      refs: { since, date: meta.date },
    });
  }

  private scrapedPayload(ex: Extracted): RatePayload {
    return {
      sourceUrl: this.ctx.config.fx.pageUrl,
      rawExcerpt: ex.rawExcerpt,
      evidence: ex.value.evidence,
      publishedDate: ex.value.publishedDate,
      ...(ex.value.session ? { session: ex.value.session } : {}),
    };
  }

  private result(
    date: string,
    outcome: FxRunOutcome,
    extra: { decisionId?: string; problems?: string[] } = {},
  ): FxRunResultDTO {
    const r = this.model.record(date);
    return {
      date,
      outcome,
      record: r ? toRateDTO(r, this.model.isClosed(date)) : null,
      discrepancyDecisionId: extra.decisionId ?? null,
      problems: extra.problems ?? [],
    };
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => undefined);
    return p;
  }
}

/** Carry the rate in effect yesterday forward to `date`, keeping its original source date and session. */
function inherit(
  date: string,
  prior: FxRateRow,
  extractor: FxExtractor,
  validation: FxValidation,
  reason: FxReason,
): RateMeta {
  return {
    date,
    pair: 'USD/MYR',
    rate: prior.rate,
    status: 'inherited',
    sourceDate: prior.sourceDate,
    extractor,
    validation,
    reason,
    ...(prior.bnmSession ? { session: prior.bnmSession } : {}),
  };
}

function sameStamp(r: FxRateRow, m: RateMeta): boolean {
  return (
    r.rate === m.rate &&
    r.status === m.status &&
    r.sourceDate === m.sourceDate &&
    r.extractor === m.extractor &&
    r.validation === m.validation &&
    r.reason === m.reason &&
    r.bnmSession === (m.session ?? null)
  );
}

function problemsOf(attempts: ExtractionAttempt[]): string[] {
  return attempts.flatMap((a) => a.problems.map((p) => `${a.model}:${p}`));
}
