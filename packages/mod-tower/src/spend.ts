/** Spend: notional API-equivalent cost (metering rate card), RM via FX, model mix, distillation savings, cap forecast. */
import { modelTierOf, type TowerSpend } from '@aoc/contracts';
import { addDays } from '@aoc/kernel';
import {
  USAGE_SUMS,
  all,
  costOf,
  inProject,
  iso,
  localDays,
  projectName,
  type ReadCtx,
  type UsageSums,
} from './read';
import { classifyRuns, runsLaunched } from './runs';
import { round1, round2, round4 } from './stats';
import { DAY, localPeriodBounds } from './zoned';

const AVG_DAYS = 7;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/** Every usage row is costed with the rate card of its own local day (rate changes never restate closed days, R12). */
export function buildSpend(r: ReadCtx): TowerSpend {
  const [sw, sa] = inProject(r, 's.project_id');

  const today = localDays(r, r.today, 1);
  let usdToday = 0;
  const byProject = new Map<string, number>();
  const byTier = new Map<string, number>();
  for (const row of all<UsageSums & { project_id: string | null }>(
    r,
    `SELECT ${USAGE_SUMS}, s.project_id AS project_id FROM twr_usage u LEFT JOIN twr_sessions s ON s.session_id = u.session_id
     WHERE u.bucket_ms >= ? AND u.bucket_ms < ?${sw} GROUP BY u.model, s.project_id`,
    today.start,
    today.end,
    ...sa,
  )) {
    const usd = costOf(r, row, r.today);
    usdToday += usd;
    if (row.project_id) byProject.set(row.project_id, (byProject.get(row.project_id) ?? 0) + usd);
    const tier = modelTierOf(row.model);
    byTier.set(tier, (byTier.get(tier) ?? 0) + usd);
  }

  const week = localDays(r, addDays(r.today, -AVG_DAYS), AVG_DAYS);
  let pastUsd = 0;
  for (const row of all<UsageSums & { d: number }>(
    r,
    `SELECT ${week.dayCase} AS d, ${USAGE_SUMS} FROM twr_usage u LEFT JOIN twr_sessions s ON s.session_id = u.session_id
     WHERE u.bucket_ms >= ? AND u.bucket_ms < ?${sw} GROUP BY d, u.model`,
    ...week.dayArgs,
    week.start,
    week.end,
    ...sa,
  )) {
    pastUsd += costOf(r, row, week.dates[row.d]!);
  }

  // Runs launched in the last 7 days, costed over their whole life (which fits in the last 9 local days).
  const runs = runsLaunched(r, r.now - AVG_DAYS * DAY);
  const verdicts = classifyRuns(r, runs);
  const span = localDays(r, addDays(r.today, -(AVG_DAYS + 1)), AVG_DAYS + 2);
  const runCost = new Map<string, number>();
  for (const row of all<UsageSums & { session_id: string; d: number }>(
    r,
    `SELECT u.session_id AS session_id, ${span.dayCase} AS d, ${USAGE_SUMS} FROM twr_usage u JOIN twr_sessions s ON s.session_id = u.session_id
     WHERE s.mode = 'managed' AND s.launched_ms >= ? AND s.launched_ms <= ? AND u.bucket_ms >= ? AND u.bucket_ms < ?${sw}
     GROUP BY u.session_id, d, u.model`,
    ...span.dayArgs,
    r.now - AVG_DAYS * DAY,
    r.now,
    span.start,
    span.end,
    ...sa,
  )) {
    runCost.set(row.session_id, (runCost.get(row.session_id) ?? 0) + costOf(r, row, span.dates[row.d]!));
  }
  const tally = { discovery: { runs: 0, usd: 0 }, execution: { runs: 0, usd: 0 } };
  for (const run of runs) {
    const cls = verdicts.get(run.session_id)?.cls;
    if (!cls) continue;
    tally[cls].runs++;
    tally[cls].usd += runCost.get(run.session_id) ?? 0;
  }
  const perDiscovery = tally.discovery.runs ? tally.discovery.usd / tally.discovery.runs : 0;
  const perExecution = tally.execution.runs ? tally.execution.usd / tally.execution.runs : null;

  const fx = r.svc.fxRate(r.today);
  return {
    notionalUsdToday: round4(usdToday),
    notionalRmToday: fx === null ? null : round2(usdToday * fx),
    avg7dUsd: round4(pastUsd / AVG_DAYS),
    byProject: [...byProject]
      .map(([projectId, usd]) => ({
        projectId,
        name: projectName(r, projectId) ?? projectId,
        usdToday: round4(usd),
      }))
      .sort((a, b) => b.usdToday - a.usdToday || a.projectId.localeCompare(b.projectId)),
    modelMix: [...byTier]
      .map(([tier, usd]) => ({
        tier,
        usdToday: round4(usd),
        pct: usdToday > 0 ? round1((usd / usdToday) * 100) : 0,
      }))
      .sort((a, b) => b.usdToday - a.usdToday || a.tier.localeCompare(b.tier)),
    discoveryRuns7d: tally.discovery.runs,
    executionRuns7d: tally.execution.runs,
    savingsPct:
      perExecution !== null && perDiscovery > 0 ? round1((1 - perExecution / perDiscovery) * 100) : null,
    capForecast: capForecast(r),
  };
}

/**
 * Credit runway for builders with usage this period: burn/day = this period's notional spend in sessions they own
 * ÷ elapsed days (≥ 1); projectedCapAt is set when balance ÷ burn runs out before the period ends (null: lasts the
 * period). Capacity planning, never a spend league table (§14). Person-level by nature: ignores the project filter.
 */
function capForecast(r: ReadCtx): TowerSpend['capForecast'] {
  if (!r.svc.hasCredits) return [];
  const period = localPeriodBounds(r.now, r.tz);
  const first = `${period.period}-01`;
  const days = localDays(r, first, daysBetween(first, r.today) + 1);
  const spend = new Map<string, number>();
  // Sessions the tower could not attribute (e.g. observed ones) keep their id so the sessions directory is asked once each.
  const owners = new Map<string, string | null>();
  for (const row of all<UsageSums & { owner_id: string | null; orphan: string | null; d: number }>(
    r,
    `SELECT s.owner_id AS owner_id, CASE WHEN s.owner_id IS NULL THEN u.session_id END AS orphan, ${days.dayCase} AS d, ${USAGE_SUMS}
     FROM twr_usage u LEFT JOIN twr_sessions s ON s.session_id = u.session_id
     WHERE u.bucket_ms >= ? AND u.bucket_ms < ? GROUP BY owner_id, orphan, d, u.model`,
    ...days.dayArgs,
    days.start,
    days.end,
  )) {
    if (row.orphan && !owners.has(row.orphan)) owners.set(row.orphan, r.svc.sessionOwner(row.orphan));
    const owner = row.owner_id ?? (row.orphan ? owners.get(row.orphan) : null);
    if (owner) spend.set(owner, (spend.get(owner) ?? 0) + costOf(r, row, days.dates[row.d]!));
  }
  const elapsedDays = Math.max(1, (r.now - period.start) / DAY);
  const out: TowerSpend['capForecast'] = [];
  for (const [userId, usd] of spend) {
    const balance = r.svc.creditBalance(userId);
    if (!balance || balance.exempt) continue;
    const burn = usd / elapsedDays;
    if (burn <= 0) continue;
    const capAt = balance.balanceUsd <= 0 ? r.now : r.now + (balance.balanceUsd / burn) * DAY;
    out.push({
      userId,
      name: r.svc.userName(userId),
      balanceUsd: round2(balance.balanceUsd),
      burnPerDayUsd: round2(burn),
      projectedCapAt: capAt < period.end ? iso(Math.round(capAt)) : null,
    });
  }
  // Runway order (soonest cap first, then the smallest balance among those who last) — never by spend.
  const capMs = (x: (typeof out)[number]) => (x.projectedCapAt ? Date.parse(x.projectedCapAt) : Infinity);
  return out.sort(
    (a, b) => capMs(a) - capMs(b) || a.balanceUsd - b.balanceUsd || a.userId.localeCompare(b.userId),
  );
}
