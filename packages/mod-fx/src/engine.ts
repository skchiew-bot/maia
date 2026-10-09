/**
 * The daily FX run (§10, R13) for today's local date:
 *   weekend → inherit (no fetch) │ page unreadable → carry forward (flagged)
 *   → Haiku extract → self-validate → Sonnet once → still failing: carry forward (flagged)
 *   → reconcile with the BNM Open API → mismatch: re-fetch + re-extract once → still mismatched: discrepancy decision,
 *     day carried forward (flagged) until a human resolves it.
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
  FxValidation,
  LlmService,
  MetaOf,
  PayloadOf,
  StoredEvent,
  User,
} from '@aoc/contracts';
import { HttpError, localDate, type ModuleContext, type NewEvent } from '@aoc/kernel';
import {
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
import { carryForwardStreak, isCalendarDate, isWeekend, reconcile, type Reconciliation } from './rules';

export interface FxTrigger {
  actor: Actor;
  source: 'scheduler' | 'api' | 'system';
}
/** Raises discrepancy decisions (never a human, so no approver is excluded by separation of duties). */
export const FX_SYSTEM_ACTOR: Actor = { kind: 'system', id: 'scheduler:fx' };

type RateMeta = MetaOf<'fx.rate_recorded'>;
type RatePayload = NonNullable<PayloadOf<'fx.rate_recorded'>>;
type Extracted = Extract<ExtractionOutcome, { ok: true }>;

export class FxEngine {
  private chain: Promise<unknown> = Promise.resolve();

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
    return this.exclusive(() => this.runToday(trigger));
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
    if (m.optionId === 'accept_official') {
      this.applyResolution(
        d,
        {
          choice: 'accept_official',
          rate: d.official,
          sourceDate: d.officialDate ?? d.date,
          extractor: 'api',
          validation: 'pass',
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
        },
        e.actor,
        'system',
        e.id,
      );
    }
    // 'manual': the day stays carried forward until the approver records the rate via the override route.
  }

  // ── the daily run ─────────────────────────────────────────────────────────

  private async runToday(t: FxTrigger): Promise<FxRunResultDTO> {
    const cfg = this.ctx.config.fx;
    const date = this.today();
    if (this.model.isClosed(date)) return this.result(date, 'skipped_closed');
    const existing = this.model.record(date);
    // A human-set rate is final for the day; only another override changes it.
    if (existing?.reason === 'manual_override') return this.result(date, 'skipped_manual');
    if (existing?.status === 'live') return this.result(date, 'skipped_live');
    const open = this.model.openDiscrepancyFor(date);
    if (open) return this.result(date, 'skipped_discrepancy', { decisionId: open.decisionId });
    const prior = this.model.latestBefore(date);

    if (isWeekend(date) && prior) {
      return this.write(
        t,
        inherit(date, prior, 'none', 'not_applicable', 'weekend_or_holiday'),
        {},
        'inherited',
      );
    }

    const page = await readPage(this.deps.fetcher, cfg.pageUrl);
    if (!page.ok) {
      return this.carryForward(t, date, prior, 'source_unreadable', 'none', 'not_applicable', {
        sourceUrl: cfg.pageUrl,
        problems: [page.problem],
        notes: page.detail,
      });
    }
    const first = await this.extract(date, prior, page.text);
    if (!first.ok) {
      return this.carryForward(t, date, prior, 'validation_failed', 'sonnet', 'fail', {
        sourceUrl: cfg.pageUrl,
        problems: problemsOf(first.attempts),
        attempts: first.attempts,
      });
    }

    const api = await readOfficial(this.deps.fetcher, cfg.apiUrl, cfg.sanity);
    const official = api.ok ? api.official : null;
    const verdict = reconcile(first.value, official, cfg.reconcileTolerance);
    if (verdict !== 'mismatch') return this.recordExtraction(t, date, first, official, verdict, api);

    // Read but mismatched: re-fetch and re-extract once (and re-read the API; keep the first figure if it is now down).
    const page2 = await readPage(this.deps.fetcher, cfg.pageUrl);
    const second = page2.ok ? await this.extract(date, prior, page2.text) : null;
    const api2 = await readOfficial(this.deps.fetcher, cfg.apiUrl, cfg.sanity);
    const official2 = api2.ok ? api2.official : official!;
    if (second?.ok) {
      const verdict2 = reconcile(second.value, official2, cfg.reconcileTolerance);
      if (verdict2 !== 'mismatch') return this.recordExtraction(t, date, second, official2, verdict2, api2);
    }
    const attempts = [...first.attempts, ...(second?.attempts ?? [])];
    return this.raiseDiscrepancy(
      t,
      date,
      prior,
      second?.ok ? second : first,
      second?.ok === true,
      official2,
      attempts,
    );
  }

  private extract(date: string, prior: FxRateRow | null, pageText: string): Promise<ExtractionOutcome> {
    const text = excerptForExtraction(pageText);
    return extractRate(
      this.deps.llm(),
      { text, sourceUrl: this.ctx.config.fx.pageUrl, today: date, timezone: this.ctx.config.timezone },
      {
        today: date,
        sanity: this.ctx.config.fx.sanity,
        priorRate: prior?.rate ?? null,
        minPublishedDate: prior?.sourceDate ?? null,
        sourceText: text,
      },
    );
  }

  private recordExtraction(
    t: FxTrigger,
    date: string,
    ex: Extracted,
    official: OfficialRate | null,
    verdict: Reconciliation,
    api: ApiRead,
  ): FxRunResultDTO {
    const live = ex.value.publishedDate === date;
    const meta: RateMeta = {
      date,
      pair: 'USD/MYR',
      rate: ex.value.usdMyr,
      status: live ? 'live' : 'inherited',
      sourceDate: ex.value.publishedDate,
      extractor: ex.model,
      validation: 'pass',
      // A weekday page still showing an older publication date is a public holiday: inherited from that date.
      reason: live ? 'fetched' : 'weekend_or_holiday',
    };
    const payload: RatePayload = { ...this.scrapedPayload(ex), attempts: ex.attempts };
    if (verdict === 'reconciled' && official) {
      payload.official = official.rate;
      if (official.date) payload.officialDate = official.date;
    } else if (verdict === 'not_comparable' && official) {
      payload.notes = `BNM Open API still on ${official.date}; scraped figure recorded without reconciliation`;
    } else if (!api.ok) {
      payload.notes = `BNM Open API unavailable (${api.problem}: ${api.detail}); scraped figure recorded without reconciliation`;
    }
    return this.write(t, meta, payload, live ? 'live' : 'inherited');
  }

  private carryForward(
    t: FxTrigger,
    date: string,
    prior: FxRateRow | null,
    reason: FxReason,
    extractor: FxExtractor,
    validation: FxValidation,
    payload: RatePayload,
  ): FxRunResultDTO {
    if (!prior) {
      this.ctx.notify({
        kind: 'fx.alert',
        title: `No USD/MYR rate for ${date}: ${reason.replace(/_/g, ' ')} and no earlier rate to carry forward`,
        audience: ['approver', 'builder'],
        severity: 'danger',
        link: '/fx',
        refs: { date },
      });
      return this.result(date, 'no_rate', { problems: payload.problems });
    }
    return this.write(t, inherit(date, prior, extractor, validation, reason), payload, 'carried_forward');
  }

  private raiseDiscrepancy(
    t: FxTrigger,
    date: string,
    prior: FxRateRow | null,
    confirmed: Extracted,
    refetchConfirmed: boolean,
    official: OfficialRate,
    attempts: ExtractionAttempt[],
  ): FxRunResultDTO {
    const cfg = this.ctx.config.fx;
    const s = confirmed.value;
    const f = (n: number) => n.toFixed(4);
    const detail = [
      `Original confirmed figure: ${f(s.usdMyr)} scraped from ${cfg.pageUrl} by ${confirmed.model}, published ${s.publishedDate}${s.session ? ` (${s.session})` : ''}; ${refetchConfirmed ? 're-confirmed by one re-fetch' : 'the one re-fetch could not be read or validated'}.`,
      `Conflicting figure: ${f(official.rate)} from the BNM Open API${official.date ? `, dated ${official.date}` : ''}${official.session ? ` (session ${official.session})` : ''}.`,
      `Difference ${Math.abs(s.usdMyr - official.rate).toFixed(4)} exceeds the reconcile tolerance ${cfg.reconcileTolerance}.`,
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
            description: 'BNM Open API middle rate',
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
          ...(official.date ? { officialDate: official.date } : {}),
          extractor: confirmed.model,
        },
        payload: { detail, evidence: s.evidence, attempts },
      },
    ];
    const meta = prior ? inherit(date, prior, confirmed.model, 'fail', 'discrepancy_pending') : null;
    if (meta) {
      const payload: RatePayload = {
        ...this.scrapedPayload(confirmed),
        official: official.rate,
        problems: ['reconcile_mismatch'],
        attempts,
      };
      if (official.date) payload.officialDate = official.date;
      events.push({
        type: 'fx.rate_recorded',
        actor: t.actor,
        source: t.source,
        bodyScope: FX_BODY_SCOPE,
        meta,
        payload,
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

  private write(t: FxTrigger, meta: RateMeta, payload: RatePayload, outcome: FxRunOutcome): FxRunResultDTO {
    const existing = this.model.record(meta.date);
    const problems = payload.problems ?? [];
    if (existing && sameStamp(existing, meta)) return this.result(meta.date, 'unchanged', { problems });
    this.ctx.store.append({
      type: 'fx.rate_recorded',
      actor: t.actor,
      meta,
      payload,
      source: t.source,
      bodyScope: FX_BODY_SCOPE,
    });
    this.afterRecord(meta, t);
    return this.result(meta.date, outcome, { problems });
  }

  /** After N consecutive carried-forward weekdays, ask for a manual check — once per streak. */
  private afterRecord(meta: RateMeta, t: FxTrigger): void {
    if (meta.status !== 'inherited' || isWeekend(meta.date)) return;
    const threshold = this.ctx.config.fx.carryForwardAlertDays;
    const { days, since } = carryForwardStreak(this.model.recordsDescFrom(meta.date));
    if (days < threshold || !since || this.model.hasAlert(since)) return;
    this.ctx.store.append({
      type: 'fx.carry_forward_alert',
      actor: t.actor,
      meta: { consecutiveDays: days, since, date: meta.date },
      source: t.source,
    });
    this.ctx.notify({
      kind: 'fx.alert',
      title: `USD/MYR carried forward ${days} weekdays in a row (since ${since}) — manual check needed`,
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
      session: ex.value.session,
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

/** Carry the rate in effect yesterday forward to `date`, keeping its original source date. */
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
  };
}

function sameStamp(r: FxRateRow, m: RateMeta): boolean {
  return (
    r.rate === m.rate &&
    r.status === m.status &&
    r.sourceDate === m.sourceDate &&
    r.extractor === m.extractor &&
    r.validation === m.validation &&
    r.reason === m.reason
  );
}

function problemsOf(attempts: ExtractionAttempt[]): string[] {
  return attempts.flatMap((a) => a.problems.map((p) => `${a.model}:${p}`));
}
