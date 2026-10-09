import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  CreditAccount,
  CreditAccountsResponse,
  CreditTopupRequestList,
  DecisionListResponse,
  RateCardDTO,
  SessionSummary,
} from '@aoc/contracts';
import { useAuth } from '../../api/auth';
import { apiPost } from '../../api/client';
import { useResource } from '../../api/useResource';
import {
  Button,
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
  useNow,
  useToast,
} from '../../components';
import { formatAge, formatPercent, formatShortDate, formatUsd } from '../../lib/format';
import { useHashScroll } from '../metering/useHashScroll';
import { isEvent } from '../registry/streamEvents';
import { useNames } from '../registry/useNames';
import { AllocationMeters, MetersLegend } from './AllocationMeters';
import { AllocationDialog, RequestTopupDialog, type TopupDraft } from './CreditDialogs';
import {
  TOPUP_SLA_MS,
  forecast,
  grantTrail,
  nextPeriod,
  orphanTopupDecisions,
  periodClock,
  periodLabel,
  recentPeriods,
  teamForecast,
  topupAging,
} from './creditsModel';
import { GrantTrail } from './GrantTrail';
import { TopupRequests } from './TopupRequests';
import './credits.css';

const CREDIT_EVENTS = ['credit.', 'usage.recorded', 'ratecard.published', 'user.'];
const TOPUP_EVENTS = ['credit.', 'decision.'];

/** Browser-local `YYYY-MM-DD`, only until the daemon's own date has loaded. */
function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function CreditsPage() {
  const { user } = useAuth();
  const approver = user?.role === 'approver';
  const toast = useToast();
  const nameOf = useNames();
  const now = useNow();
  const [period, setPeriod] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [allocating, setAllocating] = useState<CreditAccount | null>(null);

  const query = period ? { period } : undefined;
  const card = useResource<RateCardDTO>('/api/ratecard');
  const me = useResource<CreditAccount>('/api/credits/me', { query, refreshOn: (m) => isEvent(m, CREDIT_EVENTS) });
  const accounts = useResource<CreditAccountsResponse>(approver ? '/api/credits/accounts' : null, {
    query,
    refreshOn: (m) => isEvent(m, CREDIT_EVENTS),
  });
  const topups = useResource<CreditTopupRequestList>('/api/credits/topup-requests', { refreshOn: (m) => isEvent(m, TOPUP_EVENTS) });
  const decisions = useResource<DecisionListResponse>('/api/decisions', {
    query: { kind: 'credit_topup', status: 'open' },
    refreshOn: (m) => isEvent(m, TOPUP_EVENTS),
  });
  const sessions = useResource<SessionSummary[]>(requesting ? '/api/sessions' : null, { query: { mode: 'managed' } });
  useHashScroll(me.data !== undefined);

  const today = card.data?.today ?? localDay(now);
  const currentPeriod = today.slice(0, 7);
  const viewPeriod = period ?? currentPeriod;
  const clock = periodClock(viewPeriod, today);
  const list: CreditAccount[] = approver ? (accounts.data?.accounts ?? []) : me.data ? [me.data] : [];
  const openDecisions = useMemo(() => new Map((decisions.data?.decisions ?? []).map((d) => [d.id, d])), [decisions.data]);
  const requests = (topups.data?.requests ?? []).filter((r) => r.status === 'pending' || r.period === viewPeriod);
  const pending = requests.filter((r) => r.status === 'pending');
  const overdue = pending.filter((r) => topupAging(r, openDecisions.get(r.decisionId)).overdue);
  const orphans = approver ? orphanTopupDecisions(decisions.data?.decisions ?? [], topups.data?.requests ?? []) : [];
  const team = teamForecast(list, clock);
  const trail = grantTrail(list);
  const mine = me.data;
  const myForecast = mine ? forecast(mine, clock) : null;

  const reload = () => {
    me.reload();
    accounts.reload();
    topups.reload();
    decisions.reload();
  };
  const requestTopup = async (draft: TopupDraft) => {
    await apiPost('/api/credits/topup-requests', draft);
    toast.notify({ tone: 'ok', title: 'Top-up request sent', body: 'An Approver decides it; it waits here as its own state, not a stall.' });
    reload();
  };
  const resolve = async (decisionId: string, optionId: 'approve' | 'deny') => {
    await apiPost(`/api/decisions/${encodeURIComponent(decisionId)}/resolve`, { optionId });
    toast.notify({
      tone: 'ok',
      title: optionId === 'approve' ? 'Top-up approved' : 'Top-up denied',
      body: optionId === 'approve' ? 'The grant is recorded with the balance before and after.' : 'The requester sees the decision; their balance is unchanged.',
    });
    reload();
  };
  const allocate = async (input: { userId: string; period: string; amountUsd: number }) => {
    await apiPost('/api/credits/allocations', input);
    toast.notify({ tone: 'ok', title: `Allocation saved for ${periodLabel(input.period)}`, body: formatUsd(input.amountUsd) });
    reload();
  };

  const periods = recentPeriods(currentPeriod, 3);
  const canRequest = clock.current && mine !== undefined && !mine.exempt && mine.pendingTopup === null;
  const requestBlocked = !mine
    ? null
    : mine.exempt
      ? 'You are exempt from the cap.'
      : mine.pendingTopup
        ? 'A request of yours is already waiting for an Approver.'
        : !clock.current
          ? 'Requests apply to the current period.'
          : null;

  const loading = (approver ? accounts : me).data === undefined;
  const loadError = (approver ? accounts : me).error;

  return (
    <>
      <PageHeader
        title="Credits"
        subtitle={`Allocations and usage for ${periodLabel(viewPeriod)} · credits meter cost at task boundaries; they never pick the model`}
        actions={
          <Button icon="plus" disabled={!canRequest} onClick={() => setRequesting(true)}>
            Request a top-up
          </Button>
        }
        meta={
          <>
            {clock.current ? (
              <span className="aoc-num">
                Day {clock.elapsed} of {clock.days} · {clock.daysLeft} day{clock.daysLeft === 1 ? '' : 's'} left
              </span>
            ) : (
              <span>Closed period: read-only</span>
            )}
            {requestBlocked && <span>{requestBlocked}</span>}
          </>
        }
      />
      <FilterBar label="Credit filters">
        <SegmentedControl
          label="Period"
          value={viewPeriod}
          onChange={(p) => setPeriod(p === currentPeriod ? null : p)}
          options={periods.map((p) => ({ value: p, label: periodLabel(p) }))}
        />
      </FilterBar>

      {loadError && loading ? (
        <ErrorState title="Couldn't load credits" error={loadError} onRetry={reload} />
      ) : (
        <>
          <KpiStrip label="Credits at a glance">
            {approver ? (
              <>
                <KpiTile label="Allocated" value={formatUsd(team.allocatedUsd, { decimals: 0 })} footnote={`${list.length} accounts · ${periodLabel(viewPeriod)}`} />
                <KpiTile
                  label="Used"
                  value={formatUsd(team.usedUsd)}
                  footnote={`${team.allocatedUsd > 0 ? formatPercent(team.usedUsd / team.allocatedUsd) : '—'} of allocations · notional`}
                />
                <KpiTile
                  label="Granted"
                  value={formatUsd(team.grantedUsd)}
                  footnote={`${trail.filter((g) => g.kind === 'auto').length} auto-grants · ${trail.filter((g) => g.kind === 'topup').length} top-ups`}
                  href="#trail"
                />
              </>
            ) : (
              <>
                <KpiTile
                  label="Your balance"
                  value={mine ? formatUsd(mine.balanceUsd) : '—'}
                  footnote={mine ? `of ${formatUsd(mine.allocationUsd + mine.grantedUsd)} · ${formatPercent(mine.allocationUsd > 0 ? mine.usedUsd / mine.allocationUsd : 0)} used` : undefined}
                />
                <KpiTile
                  label="25% auto-grant"
                  value={mine ? (mine.autoGrantUsed ? 'Used' : formatUsd(mine.autoGrantAvailableUsd)) : '—'}
                  footnote={mine ? (mine.autoGrantUsed ? 'once per period' : 'added once, at your first cap') : undefined}
                />
              </>
            )}
            <KpiTile
              label="Top-ups waiting"
              value={pending.length}
              tone={overdue.length ? 'warn' : 'neutral'}
              footnote={
                pending.length
                  ? `oldest ${formatAge(Math.max(...pending.map((r) => r.ageMs)))} · SLA ${formatAge(TOPUP_SLA_MS)}${overdue.length ? ` · ${overdue.length} past it` : ''}`
                  : 'nothing waiting'
              }
              href="#topups"
            />
            <KpiTile
              label={clock.current ? 'Period forecast' : 'Period total'}
              value={approver ? formatUsd(team.projectedUsd, { decimals: 0 }) : myForecast ? formatUsd(myForecast.projectedUsd, { decimals: 0 }) : '—'}
              tone={approver ? (team.capBeforeEnd.length || team.capped.length ? 'warn' : 'neutral') : myForecast?.status === 'cap_before_end' ? 'warn' : 'neutral'}
              footnote={
                !clock.current
                  ? 'period closed'
                  : approver
                    ? team.capBeforeEnd.length
                      ? `${team.capBeforeEnd.length} reach their cap before ${formatShortDate(clock.end)}`
                      : team.capped.length
                        ? `${team.capped.length} at cap now`
                        : `no one reaches their cap by ${formatShortDate(clock.end)}`
                    : myForecast?.capDate
                      ? `cap ~${formatShortDate(myForecast.capDate)} at this pace`
                      : `by ${formatShortDate(clock.end)} at this pace`
              }
              info="A straight line at this period's average daily notional spend — capacity planning, not a target."
            />
          </KpiStrip>

          <WidgetGrid>
            <Widget
              span={12}
              id="allocations"
              title="Allocations vs usage"
              subtitle={approver ? 'One shared scale · listed by name, never ranked' : 'Your account · team allocations are visible to Approvers'}
              footer={<MetersLegend />}
              busy={(approver ? accounts : me).loading && !loading}
            >
              {loading ? (
                <div className="crd-skeleton" role="status">
                  <span className="aoc-sr-only">Loading credit accounts…</span>
                </div>
              ) : list.length === 0 ? (
                <p className="crd-sub">No credit accounts for {periodLabel(viewPeriod)} yet.</p>
              ) : (
                <>
                  {approver && clock.current && (team.capBeforeEnd.length > 0 || team.capped.length > 0) && (
                    <p className="crd-plan" role="note">
                      Capacity: {team.capped.map((a) => a.userName ?? a.userId).join(', ')}
                      {team.capped.length ? ' at cap now' : ''}
                      {team.capped.length && team.capBeforeEnd.length ? '; ' : ''}
                      {team.capBeforeEnd.map((a) => a.userName ?? a.userId).join(', ')}
                      {team.capBeforeEnd.length ? ` reach the cap before ${formatShortDate(clock.end)} at this pace` : ''}.
                    </p>
                  )}
                  <AllocationMeters
                    accounts={list}
                    clock={clock}
                    meId={user?.id ?? null}
                    onAllocate={approver && clock.current ? setAllocating : undefined}
                  />
                </>
              )}
            </Widget>
          </WidgetGrid>

          <WidgetGrid>
            <Widget
              span={7}
              id="topups"
              title="Top-up requests"
              subtitle={approver ? 'Waiting requests first, oldest first · you decide' : 'Your requests · an Approver decides them'}
            >
              {orphans.length > 0 && (
                <InlineAlert tone="info" title={`${orphans.length} credit top-up decision${orphans.length === 1 ? ' has' : 's have'} no request behind it`}>
                  Resolving {orphans.length === 1 ? 'it' : 'them'} changes no balance. <Link to="/decisions">Review in Decisions</Link>
                </InlineAlert>
              )}
              <ResourceView resource={topups} loadingText="Loading top-up requests…" isEmpty={() => false}>
                {() => (
                  <TopupRequests requests={requests} decisions={openDecisions} meId={user?.id ?? null} nameOf={nameOf} onResolve={resolve} />
                )}
              </ResourceView>
            </Widget>
            <Widget span={5} title="How credits work" subtitle="Behaviour control, not a blame board">
              <ul className="crd-rules">
                <li>
                  <b>Task boundaries only.</b> A cap never stops a session mid-task; work pauses at the next boundary.
                </li>
                <li>
                  <b>25% once.</b> The first cap in a period adds 25% of the original allocation automatically (AI-approved,
                  audited like any grant). It never compounds.
                </li>
                <li>
                  <b>Then an Approver decides.</b> Further top-ups are a button-raised request to a human — never the
                  requester. Waiting requests age here as their own state.
                </li>
                <li>
                  <b>Cost, not model.</b> Credits meter notional cost; they never pick the model. Discovery runs on Opus
                  whatever the balance.
                </li>
              </ul>
            </Widget>
          </WidgetGrid>

          <WidgetGrid>
            <Widget
              span={12}
              id="trail"
              title="Grant and top-up audit trail"
              subtitle={`${periodLabel(viewPeriod)} · who, how much, against what task, balance before and after`}
              footer={<Link to="/audit">Open the full audit log</Link>}
              flush
            >
              <GrantTrail rows={trail} meId={user?.id ?? null} nameOf={nameOf} />
            </Widget>
          </WidgetGrid>
        </>
      )}

      <RequestTopupDialog
        open={requesting}
        onClose={() => setRequesting(false)}
        account={mine}
        sessions={(sessions.data ?? []).filter((s) => s.ownerId === user?.id && s.mode === 'managed')}
        onSubmit={requestTopup}
      />
      {approver && (
        <AllocationDialog
          account={allocating}
          onClose={() => setAllocating(null)}
          periods={[currentPeriod, nextPeriod(currentPeriod)]}
          onSubmit={allocate}
        />
      )}
    </>
  );
}
