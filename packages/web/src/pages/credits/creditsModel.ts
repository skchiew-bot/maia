/**
 * Pure view-model rules for Credits (§10): cap state, the once-per-period auto grant, top-up aging and the
 * period forecast. Behaviour control, not a blame board: nothing here ranks people.
 */
import type { CreditAccount, CreditTopupRequest, DecisionCardView } from '@aoc/contracts';

/** Credit top-up decision SLA, as approved with the static mock (decision 3: credit top-up 1h). */
export const TOPUP_SLA_MS = 60 * 60_000;

/** `YYYY-MM` → number of days in that month. */
export function daysInPeriod(period: string): number {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export interface PeriodClock {
  period: string;
  days: number;
  /** Days elapsed including today (1-based); the whole period once it has ended. */
  elapsed: number;
  daysLeft: number;
  current: boolean;
  /** Last day of the period, `YYYY-MM-DD`. */
  end: string;
}

/** Where `today` (the daemon's local date) sits in `period`. */
export function periodClock(period: string, today: string): PeriodClock {
  const days = daysInPeriod(period);
  const end = `${period}-${String(days).padStart(2, '0')}`;
  const current = today.slice(0, 7) === period;
  const elapsed = current ? Number(today.slice(8, 10)) : today.slice(0, 7) > period ? days : 0;
  return { period, days, elapsed, daysLeft: current ? days - elapsed : 0, current, end };
}

/** Previous `count` periods, newest first, starting with `period`. */
export function recentPeriods(period: string, count: number): string[] {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  });
}

/** The period after `period`. */
export function nextPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function periodLabel(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return `${MONTH[m - 1]} ${y}`;
}

export type CapState = 'exempt' | 'capped_waiting' | 'capped' | 'on_auto_grant' | 'within';

/** Where the account stands at the next task boundary (work is never stopped mid-task, R7). */
export function capState(a: CreditAccount): CapState {
  if (a.exempt) return 'exempt';
  if (a.capped) return a.pendingTopup ? 'capped_waiting' : 'capped';
  if (a.autoGrantUsed) return 'on_auto_grant';
  return 'within';
}

export const CAP_STATE_TEXT: Record<CapState, string> = {
  exempt: 'Exempt from the cap',
  capped_waiting: 'At cap · top-up waiting',
  capped: 'At cap · next task boundary pauses work',
  on_auto_grant: 'Using the 25% auto-grant',
  within: 'Within allocation',
};

/** Funding the next boundary can still draw on: allocation + grants, plus the unused once-per-period auto grant. */
export function headroomTotal(a: CreditAccount): number {
  return a.allocationUsd + a.grantedUsd + (a.autoGrantUsed || a.exempt ? 0 : a.autoGrantAvailableUsd);
}

export interface Forecast {
  /** Usage by the end of the period at this period's average daily pace. */
  projectedUsd: number;
  /** Pace per day so far. */
  perDayUsd: number;
  /** Day the pace would exhaust allocation + grants + the auto grant, if inside the period. */
  capDate: string | null;
  status: 'exempt' | 'capped' | 'cap_before_end' | 'tight' | 'on_track' | 'closed';
}

/** Linear forecast at this period's average daily burn (capacity planning — never a ranking). */
export function forecast(a: CreditAccount, clock: PeriodClock): Forecast {
  const perDayUsd = clock.elapsed > 0 ? a.usedUsd / clock.elapsed : 0;
  const projectedUsd = clock.current ? perDayUsd * clock.days : a.usedUsd;
  if (a.exempt) return { projectedUsd, perDayUsd, capDate: null, status: 'exempt' };
  if (!clock.current) return { projectedUsd, perDayUsd, capDate: null, status: 'closed' };
  if (a.capped) return { projectedUsd, perDayUsd, capDate: null, status: 'capped' };
  const funding = headroomTotal(a);
  if (perDayUsd > 0 && projectedUsd > funding) {
    const day = Math.max(clock.elapsed, Math.min(clock.days, Math.ceil(funding / perDayUsd)));
    return { projectedUsd, perDayUsd, capDate: `${clock.period}-${String(day).padStart(2, '0')}`, status: 'cap_before_end' };
  }
  const tight = projectedUsd > 0.8 * (a.allocationUsd + a.grantedUsd);
  return { projectedUsd, perDayUsd, capDate: null, status: tight ? 'tight' : 'on_track' };
}

export interface TopupAging {
  ageMs: number;
  overdue: boolean;
  /** Share of the SLA used (1 = at the SLA). */
  slaRatio: number;
}

/** A waiting request ages as its own state (never a stall); the decision's own due time wins when it has one. */
export function topupAging(r: Pick<CreditTopupRequest, 'ageMs' | 'status'>, decision?: DecisionCardView): TopupAging {
  const overdue = decision?.dueAt ? decision.overdue : r.status === 'pending' && r.ageMs > TOPUP_SLA_MS;
  return { ageMs: r.ageMs, overdue, slaRatio: r.ageMs / TOPUP_SLA_MS };
}

/** Open credit_topup decisions with no credits request behind them: resolving them moves no balance. */
export function orphanTopupDecisions(
  decisions: readonly DecisionCardView[],
  requests: readonly CreditTopupRequest[],
): DecisionCardView[] {
  const linked = new Set(requests.map((r) => r.decisionId));
  return decisions.filter((d) => d.kind === 'credit_topup' && d.status === 'open' && d.subjectType !== 'credit_account' && !linked.has(d.id));
}

export interface GrantRow {
  key: string;
  userId: string;
  userName: string | null;
  kind: 'auto' | 'topup';
  amountUsd: number;
  at: string;
  approverId: string | null;
  sessionId: string | null;
  taskId: string | null;
  decisionId: string | null;
  balanceBefore: number;
  balanceAfter: number;
}

/** Every grant and top-up across the accounts shown, newest first. */
export function grantTrail(accounts: readonly CreditAccount[]): GrantRow[] {
  return accounts
    .flatMap((a) =>
      a.grants.map((g, i) => ({
        key: `${a.userId}:${g.at}:${i}`,
        userId: a.userId,
        userName: a.userName,
        kind: g.kind,
        amountUsd: g.amountUsd,
        at: g.at,
        approverId: g.approverId,
        sessionId: g.sessionId,
        taskId: g.taskId,
        decisionId: g.decisionId,
        balanceBefore: g.balanceBefore,
        balanceAfter: g.balanceAfter,
      })),
    )
    .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
}

export interface TeamForecast {
  allocatedUsd: number;
  grantedUsd: number;
  usedUsd: number;
  projectedUsd: number;
  /** Accounts the pace takes to their cap before the period ends (capacity planning, alphabetical). */
  capBeforeEnd: CreditAccount[];
  capped: CreditAccount[];
}

export function teamForecast(accounts: readonly CreditAccount[], clock: PeriodClock): TeamForecast {
  const capBeforeEnd: CreditAccount[] = [];
  const capped: CreditAccount[] = [];
  let projectedUsd = 0;
  for (const a of accounts) {
    const f = forecast(a, clock);
    projectedUsd += f.projectedUsd;
    if (f.status === 'cap_before_end') capBeforeEnd.push(a);
    if (f.status === 'capped') capped.push(a);
  }
  const byName = (x: CreditAccount, y: CreditAccount) => (x.userName ?? x.userId).localeCompare(y.userName ?? y.userId);
  return {
    allocatedUsd: accounts.reduce((s, a) => s + a.allocationUsd, 0),
    grantedUsd: accounts.reduce((s, a) => s + a.grantedUsd, 0),
    usedUsd: accounts.reduce((s, a) => s + a.usedUsd, 0),
    projectedUsd,
    capBeforeEnd: capBeforeEnd.sort(byName),
    capped: capped.sort(byName),
  };
}
