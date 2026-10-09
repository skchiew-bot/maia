import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  CostPerOutcomeDTO,
  DecisionListResponse,
  FxRateDTO,
  FxStatusDTO,
  MeteringDailyDTO,
  MeteringSubscriptionDTO,
  MeteringSummaryDTO,
  MeteringSummaryRow,
  MeteringThrottleDTO,
  MigrationRecommendationDTO,
  ProjectSummary,
  RateCardDTO,
  RateCardVersionDTO,
  RateCardVersionsDTO,
} from '@aoc/contracts';
import { useAuth } from '../../api/auth';
import { apiPut } from '../../api/client';
import { useResource } from '../../api/useResource';
import {
  ErrorState,
  FilterBar,
  InlineAlert,
  KpiStrip,
  KpiTile,
  PageHeader,
  ResourceView,
  SegmentedControl,
  Widget,
  WidgetGrid,
  useToast,
} from '../../components';
import { formatMyr, formatPercent, formatShortDate, formatTokens, formatUsd } from '../../lib/format';
import { useSectionScroll } from '../../lib/sectionScroll';
import { isEvent } from '../registry/streamEvents';
import { useNames } from '../registry/useNames';
import { BreakdownPanel, TokenTypesPanel, type BreakdownDim } from './BreakdownPanels';
import { DailyCostChart } from './DailyCostChart';
import { DailyRollups } from './DailyRollups';
import { FxPanel } from './FxPanel';
import {
  RANGE_OPTIONS,
  dayLabel,
  dayRanges,
  formatIdle,
  fxSessionLabel,
  meteredDays,
  rangeFor,
  unpricedSummary,
  type RangeValue,
} from './meteringModel';
import { MigrationPanel } from './MigrationPanel';
import { OutcomePanel } from './OutcomePanel';
import { blendedRate } from './outcomeModel';
import { RateCardPanel } from './RateCardPanel';
import type { RateCardDraft } from './RateCardDialog';
import { ThrottlePanel } from './ThrottlePanel';
import './metering.css';

const USAGE_EVENTS = ['usage.recorded', 'rollup.closed', 'ratecard.published', 'subscription.updated', 'fx.rate_recorded', 'throttle.'];
const THROTTLE_EVENTS = ['throttle.', 'rollup.closed', 'session.ended'];
/** What changes cost per outcome: spend arriving, and the outcomes themselves (ticket closed, change and phase completed). */
const OUTCOME_EVENTS = ['usage.recorded', 'ticket.', 'change.completed', 'phase.completed'];
const FX_EVENTS = ['fx.', 'rollup.closed'];
const SCOPES = [
  { value: 'org', label: 'Team' },
  { value: 'mine', label: 'My sessions' },
] as const;

export default function MeteringPage() {
  const { user } = useAuth();
  const toast = useToast();
  const nameOf = useNames();
  const [range, setRange] = useState<RangeValue>('30');
  const [scope, setScope] = useState<'org' | 'mine'>('org');
  const [dim, setDim] = useState<BreakdownDim>('project');

  const card = useResource<RateCardDTO>('/api/ratecard', { refreshOn: (m) => isEvent(m, ['ratecard.published', 'rollup.closed']) });
  const today = card.data?.today;
  const span = today ? rangeFor(today, Number(range)) : undefined;
  const q = span ? { ...span, mine: scope === 'mine' ? '1' : undefined } : undefined;
  const ready = span !== undefined;
  const team = scope === 'org';

  // The team's days always load: their stamped RM prices the outcomes below, a portfolio view whatever the scope.
  // "My sessions" loads its own days next to them.
  const teamDaily = useResource<MeteringDailyDTO>('/api/metering/daily', { query: span, enabled: ready, refreshOn: (m) => isEvent(m, USAGE_EVENTS) });
  const mineDaily = useResource<MeteringDailyDTO>('/api/metering/daily', { query: q, enabled: ready && !team, refreshOn: (m) => isEvent(m, USAGE_EVENTS) });
  const daily = team ? teamDaily : mineDaily;
  // Cost per outcome is a portfolio lens: the daemon refuses a per-person view, so it never takes the scope.
  const outcomes = useResource<CostPerOutcomeDTO>('/api/metering/cost-per-outcome', { query: span, enabled: ready, refreshOn: (m) => isEvent(m, OUTCOME_EVENTS) });
  const summary = useResource<MeteringSummaryDTO>('/api/metering/summary', {
    query: q ? { ...q, groupBy: dim } : undefined,
    enabled: ready,
    refreshOn: (m) => isEvent(m, USAGE_EVENTS),
  });
  const throttle = useResource<MeteringThrottleDTO>('/api/metering/throttle', { query: q, enabled: ready, refreshOn: (m) => isEvent(m, THROTTLE_EVENTS) });
  const versions = useResource<RateCardVersionsDTO>('/api/ratecard/versions', { refreshOn: (m) => isEvent(m, ['ratecard.published']) });
  const subscription = useResource<MeteringSubscriptionDTO>(team ? '/api/metering/subscription' : null, {
    refreshOn: (m) => isEvent(m, ['subscription.updated']),
  });
  const migration = useResource<MigrationRecommendationDTO>(team ? '/api/metering/migration' : null, {
    refreshOn: (m) => isEvent(m, ['rollup.closed', 'subscription.updated', 'ratecard.published']),
  });
  const fxStatus = useResource<FxStatusDTO>('/api/fx/status', { refreshOn: (m) => isEvent(m, FX_EVENTS) });
  const fxRates = useResource<{ from: string; to: string; rates: FxRateDTO[] }>('/api/fx/rates', {
    query: span,
    enabled: ready,
    refreshOn: (m) => isEvent(m, FX_EVENTS),
  });
  const tickets = useResource<DecisionListResponse>('/api/decisions', {
    query: { kind: 'fx_discrepancy' },
    refreshOn: (m) => isEvent(m, ['decision.', 'fx.discrepancy_raised', 'fx.discrepancy_resolved']),
  });
  const projects = useResource<ProjectSummary[]>('/api/projects', { refreshOn: (m) => isEvent(m, ['project.']) });
  useSectionScroll(daily);

  const fxByDate = useMemo(() => new Map((fxRates.data?.rates ?? []).map((r) => [r.date, r])), [fxRates.data]);
  const projectName = (id: string | null) => (id ? (projects.data?.find((p) => p.projectId === id)?.name ?? null) : null);
  const labelOf = (d: BreakdownDim, r: MeteringSummaryRow): string => {
    if (r.key === '[erased]') return '[erased]';
    if (d === 'project') return projectName(r.key) ?? r.key ?? 'No project';
    if (d === 'actor') return r.label ?? nameOf(r.key) ?? r.key ?? 'Unattributed';
    return r.key ?? (d === 'model' ? 'Unknown model' : 'No process type');
  };

  const publish = async (draft: RateCardDraft): Promise<RateCardVersionDTO> => {
    const v = await apiPut<RateCardVersionDTO>('/api/ratecard', draft);
    toast.notify({
      tone: 'ok',
      title: `Rate card v${v.version} scheduled`,
      body: `It takes effect ${dayLabel(v.effectiveFrom)}; closed days keep the prices they were frozen with.`,
    });
    card.reload();
    versions.reload();
    return v;
  };

  const outcomeRate = blendedRate(teamDaily.data?.totals);
  const days = daily.data ? meteredDays(daily.data) : [];
  const unpriced = daily.data ? unpricedSummary(daily.data) : null;
  const totals = daily.data?.totals;
  const status = fxStatus.data;
  const fxToday = status?.todayRecord ?? null;

  return (
    <>
      <PageHeader
        title="Metering"
        subtitle="Notional API-equivalent cost — decision support for the Enterprise question, not a bill. Subscription spend is shown separately."
        meta={
          card.data?.active ? (
            <>
              <span>
                Rate card <b>v{card.data.active.version}</b> since {formatShortDate(card.data.active.effectiveFrom)}
              </span>
              {status?.current && (
                <span className="aoc-num">
                  USD→MYR {status.current.rate.toFixed(4)} ·{' '}
                  {status.current.status === 'live' ? 'live' : `inherited from ${formatShortDate(status.current.sourceDate)}`}
                  {fxSessionLabel(fxToday?.session) ? ` · BNM ${fxSessionLabel(fxToday?.session)}` : ''}
                </span>
              )}
            </>
          ) : undefined
        }
      />
      <FilterBar
        label="Metering filters"
        end={
          daily.data ? (
            <span className="aoc-num">
              {formatShortDate(daily.data.from)}–{formatShortDate(daily.data.to)} ·{' '}
              {days.filter((d) => d.status === 'closed').length} closed · {days.filter((d) => d.status === 'open').length} open
            </span>
          ) : undefined
        }
      >
        <SegmentedControl label="Time range" value={range} onChange={setRange} options={RANGE_OPTIONS} />
        <SegmentedControl label="Scope" value={scope} onChange={setScope} options={SCOPES} />
      </FilterBar>

      {card.error && !card.data ? (
        <ErrorState title="Couldn't load metering" error={card.error} onRetry={card.reload} />
      ) : (
        <>
          {unpriced && (
            <InlineAlert
              tone="warn"
              title={`${formatTokens(unpriced.tokens)} tokens (${formatPercent(unpriced.share)}) are counted at US$0 — no rate priced them`}
              action={<Link to="#rate-card">Rate card</Link>}
              className="met-alert"
            >
              {unpriced.models.join(', ')} on {dayRanges(unpriced.days)}. Closed days are never restated, so this usage
              stays unpriced; a new rate prices usage from {card.data ? dayLabel(card.data.earliestEffectiveFrom) : 'tomorrow'} onward.
            </InlineAlert>
          )}
          <KpiStrip label="Metering at a glance">
            <KpiTile
              label="Notional cost"
              value={totals ? formatUsd(totals.notionalUsd) : '—'}
              footnote={totals ? `${totals.notionalRm !== null ? `${formatMyr(totals.notionalRm)} · ` : ''}notional, not a bill` : 'loading'}
              trend={days.length > 1 ? days.map((d) => d.notionalUsd) : undefined}
              trendLabel="per day"
              info={daily.data?.costLabel}
            />
            {team && (
              <KpiTile
                label="Subscription · actual"
                value={totals?.subscriptionUsd != null ? formatUsd(totals.subscriptionUsd) : '—'}
                footnote={
                  subscription.data?.active
                    ? `${subscription.data.active.plan} · ${subscription.data.active.seats} seats, prorated per day`
                    : 'real plan spend, kept apart'
                }
              />
            )}
            <KpiTile
              label="Lost to throttling"
              value={throttle.data ? formatIdle(throttle.data.totals.idleMs) : '—'}
              tone={throttle.data && throttle.data.totals.idleMs > 0 ? 'warn' : 'neutral'}
              footnote={
                throttle.data
                  ? `${throttle.data.totals.hits} plan-limit hit${throttle.data.totals.hits === 1 ? '' : 's'} · ${throttle.data.totals.throttledNow} throttled now`
                  : undefined
              }
              href="#throttle"
            />
            <KpiTile
              label="Unpriced usage"
              value={unpriced ? formatTokens(unpriced.tokens) : '0'}
              unit="tokens"
              tone={unpriced ? 'warn' : 'neutral'}
              footnote={unpriced ? `${formatPercent(unpriced.share)} of tokens · ${unpriced.models.length} models at US$0` : 'every model priced'}
              href="#rate-card"
            />
            <KpiTile
              label="USD→MYR today"
              value={status?.current ? status.current.rate.toFixed(4) : '—'}
              footnote={
                status?.current
                  ? status.current.status === 'live'
                    ? 'fetched live · BNM'
                    : `inherited from ${formatShortDate(status.current.sourceDate)}`
                  : undefined
              }
              href="#fx"
            />
          </KpiStrip>

          <WidgetGrid>
            <Widget
              span={12}
              id="daily"
              title="Daily notional cost"
              subtitle={team ? 'API-equivalent cost per day, against what the subscription actually costs per day' : 'Your sessions, per day'}
              info={daily.data?.costLabel}
              busy={daily.loading && daily.data !== undefined}
              footer={
                daily.data && days.length > 0 && days[0]!.date > daily.data.from ? (
                  <span>Metering began {dayLabel(days[0]!.date)}; earlier days in the range have no data.</span>
                ) : undefined
              }
            >
              {daily.data ? (
                days.length > 0 ? (
                  <DailyCostChart days={days} fxByDate={fxByDate} showSubscription={team} />
                ) : (
                  <p className="met-quiet">No metered usage in this range yet.</p>
                )
              ) : daily.error ? (
                <ErrorState size="sm" error={daily.error} onRetry={daily.reload} title="Couldn't load daily rollups" />
              ) : (
                <div className="met-skeleton" role="status">
                  <span className="aoc-sr-only">Loading daily rollups…</span>
                </div>
              )}
            </Widget>
          </WidgetGrid>

          <WidgetGrid>
            {throttle.data ? (
              <ThrottlePanel throttle={throttle.data} projectName={projectName} />
            ) : (
              <Widget span={7} id="throttle" title="Productivity lost to throttling">
                <ResourceView resource={throttle} loadingText="Loading plan-limit hits…">
                  {() => null}
                </ResourceView>
              </Widget>
            )}
            {team &&
              (migration.data ? (
                <MigrationPanel m={migration.data} />
              ) : (
                <Widget span={5} id="migration" title="Enterprise migration case">
                  <ResourceView resource={migration} loadingText="Modelling the range…" errorTitle="Couldn't model the migration">
                    {() => null}
                  </ResourceView>
                </Widget>
              ))}
          </WidgetGrid>

          <WidgetGrid>
            <BreakdownPanel dim={dim} onDim={setDim} summary={summary} labelOf={labelOf} />
            {totals ? (
              <TokenTypesPanel totals={totals} />
            ) : (
              <Widget span={5} title="Token types">
                <ResourceView resource={daily} loadingText="Loading tokens…">
                  {() => null}
                </ResourceView>
              </Widget>
            )}
          </WidgetGrid>

          <WidgetGrid>
            <OutcomePanel resource={outcomes} basis={outcomeRate} projectName={projectName} />
          </WidgetGrid>

          <WidgetGrid>
            {daily.data && (
              <DailyRollups
                days={[...days].reverse()}
                fxByDate={fxByDate}
                lastClosedDay={daily.data.lastClosedDay}
                scope={scope}
              />
            )}
          </WidgetGrid>

          <WidgetGrid>
            {card.data ? (
              <RateCardPanel
                card={card.data}
                versions={versions.data}
                subscription={team ? subscription.data : undefined}
                canEdit={user?.role === 'approver'}
                nameOf={nameOf}
                onPublish={publish}
              />
            ) : (
              <Widget span={12} id="rate-card" title="Rate card">
                <ResourceView resource={card} loadingText="Loading the rate card…">
                  {() => null}
                </ResourceView>
              </Widget>
            )}
          </WidgetGrid>

          <WidgetGrid>
            {status && fxRates.data ? (
              <FxPanel status={status} rates={fxRates.data.rates} tickets={tickets.data?.decisions ?? []} />
            ) : (
              <Widget span={12} id="fx" title="FX · USD→MYR">
                {fxStatus.error && !status ? (
                  <ErrorState size="sm" title="Couldn't load FX" error={fxStatus.error} onRetry={fxStatus.reload} />
                ) : (
                  <ResourceView resource={fxRates} loadingText="Loading FX…" errorTitle="Couldn't load FX">
                    {() => null}
                  </ResourceView>
                )}
              </Widget>
            )}
          </WidgetGrid>
        </>
      )}
    </>
  );
}
