/** HTTP API. Org-wide views need audit.view or credit.view_all; anyone who can launch sessions may see their own (?mine=1). */
import { z } from 'zod';
import { hasPermission, METERING_GROUP_BYS, type MeteringScope, type User } from '@aoc/contracts';
import {
  addDays,
  HttpError,
  parseQuery,
  readJson,
  requirePermission,
  requireUser,
  type App,
  type Ctx,
} from '@aoc/kernel';
import { checkForwardOnly, dayCount, earliestEffectiveFrom, maxDate } from './dates';
import { MIGRATION_DEFAULTS, migrationProblems, type MigrationAssumptionInput } from './migration';
import { type MeteringModel } from './model';
import { RateCardUpdateSchema, rateCardProblems, SubscriptionUpdateSchema, zDate } from './ratecard-file';
import {
  buildCostPerOutcome,
  buildDaily,
  buildMigration,
  buildRateCard,
  buildRateCardVersions,
  buildSession,
  buildSubscription,
  buildSummary,
  buildThrottle,
  migrationData,
  rateCardVersion,
} from './views';

const MAX_RANGE_DAYS = 400;
/** Rate edits further out than this are almost certainly typos. */
const MAX_SCHEDULE_DAYS = 730;

// parseQuery needs schemas whose input and output types match: no transforms or defaults here.
const RangeQuery = z.object({
  from: zDate.optional(),
  to: zDate.optional(),
  mine: z.enum(['1', 'true', '0', 'false']).optional(),
});
const SummaryQuery = RangeQuery.extend({ groupBy: z.enum(METERING_GROUP_BYS).optional() });
const isMine = (q: { mine?: string }) => q.mine === '1' || q.mine === 'true';
const zAmount = z.coerce.number().finite().min(0);
// Strict: a misspelt assumption must fail loudly rather than silently fall back to its default.
const MigrationQuery = z
  .object(
    Object.fromEntries(
      [...Object.keys(MIGRATION_DEFAULTS), 'seats'].map((k) => [k, zAmount.optional()]),
    ) as Record<keyof MigrationAssumptionInput, z.ZodOptional<typeof zAmount>>,
  )
  .strict();

const canViewOrg = (u: User) =>
  hasPermission(u.role, 'audit.view', u.flags) || hasPermission(u.role, 'credit.view_all', u.flags);
const canOwnSessions = (u: User) =>
  hasPermission(u.role, 'session.launch', u.flags) || hasPermission(u.role, 'session.drive_own', u.flags);

function viewer(c: Ctx, mine: boolean): { user: User; scope: MeteringScope; ownerId: string | null } {
  const { user } = requireUser(c);
  if (mine) {
    if (!canViewOrg(user) && !canOwnSessions(user))
      throw new HttpError(403, 'forbidden', 'Missing permission session.launch');
    return { user, scope: 'mine', ownerId: user.id };
  }
  if (!canViewOrg(user))
    throw new HttpError(
      403,
      'forbidden',
      'Org-wide metering needs audit.view or credit.view_all (use ?mine=1 for your own usage)',
    );
  return { user, scope: 'org', ownerId: null };
}

function range(m: MeteringModel, q: { from?: string; to?: string }): { from: string; to: string } {
  const to = q.to ?? m.today();
  const from = q.from ?? addDays(to, -29);
  if (from > to) throw new HttpError(422, 'invalid', '`from` must not be after `to`');
  if (dayCount(from, to) > MAX_RANGE_DAYS)
    throw new HttpError(422, 'invalid', `Range is limited to ${MAX_RANGE_DAYS} days`);
  return { from, to };
}

export function registerMeteringRoutes(app: App, m: MeteringModel): void {
  app.get('/api/metering/summary', (c) => {
    requireUser(c);
    const q = parseQuery(c, SummaryQuery);
    const v = viewer(c, isMine(q));
    return c.json(
      buildSummary(m, { ...range(m, q), groupBy: q.groupBy ?? 'actor', scope: v.scope, ownerId: v.ownerId }),
    );
  });

  app.get('/api/metering/daily', (c) => {
    requireUser(c);
    const q = parseQuery(c, RangeQuery);
    const v = viewer(c, isMine(q));
    return c.json(buildDaily(m, { ...range(m, q), scope: v.scope, ownerId: v.ownerId }));
  });

  app.get('/api/metering/throttle', (c) => {
    requireUser(c);
    const q = parseQuery(c, RangeQuery);
    const v = viewer(c, isMine(q));
    return c.json(buildThrottle(m, { ...range(m, q), scope: v.scope, ownerId: v.ownerId }));
  });

  app.get('/api/metering/sessions/:id', (c) => {
    const { user } = requireUser(c);
    const org = canViewOrg(user);
    if (!org && !canOwnSessions(user))
      throw new HttpError(403, 'forbidden', 'Missing permission to view metering');
    const dto = buildSession(m, c.req.param('id'));
    if (!dto) throw new HttpError(404, 'not_found', 'No metering data for this session');
    if (!org && dto.ownerId !== user.id) throw new HttpError(403, 'forbidden', 'Not your session');
    return c.json(dto);
  });

  app.get('/api/metering/cost-per-outcome', (c) => {
    viewer(c, false);
    const q = parseQuery(c, RangeQuery);
    if (isMine(q))
      throw new HttpError(
        400,
        'portfolio_only',
        'Cost-per-outcome is a portfolio lens; there is no per-person view',
      );
    return c.json(buildCostPerOutcome(m, range(m, q)));
  });

  app.get('/api/metering/migration', (c) => {
    viewer(c, false);
    const input = Object.fromEntries(
      Object.entries(parseQuery(c, MigrationQuery)).filter(([, v]) => v !== undefined),
    ) as MigrationAssumptionInput;
    const data = migrationData(m);
    const problems = migrationProblems(data, input);
    if (problems.length) throw new HttpError(422, 'invalid', 'Inconsistent assumptions', problems);
    return c.json(buildMigration(m, data, input));
  });

  app.get('/api/ratecard', (c) => {
    requireRateCardReader(c);
    return c.json(buildRateCard(m));
  });

  app.get('/api/ratecard/versions', (c) => {
    requireRateCardReader(c);
    return c.json(buildRateCardVersions(m));
  });

  app.put('/api/ratecard', async (c) => {
    const auth = requirePermission(c, 'ratecard.edit');
    const body = await readJson(c, RateCardUpdateSchema);
    const today = m.today();
    const lastClosed = m.lastClosedDay();
    const effectiveFrom = body.effectiveFrom ?? earliestEffectiveFrom(today, lastClosed);
    const check = checkForwardOnly(effectiveFrom, today, lastClosed);
    if (!check.ok) {
      throw new HttpError(
        422,
        'forward_only',
        check.reason === 'closed_day'
          ? `Rate changes never restate closed days: ${effectiveFrom} is on or before the last closed day ${lastClosed}`
          : `Rate changes apply forward only: effectiveFrom must be after today (${today})`,
        { reason: check.reason, today, lastClosedDay: lastClosed, earliestEffectiveFrom: check.earliest },
      );
    }
    if (effectiveFrom > addDays(today, MAX_SCHEDULE_DAYS))
      throw new HttpError(422, 'invalid', `effectiveFrom is more than ${MAX_SCHEDULE_DAYS} days ahead`);
    // Omitted tier fallback inherits the latest version's, minus targets this card no longer prices.
    const inherited = m.rateCards().at(-1)?.tierFallback ?? {};
    const tierFallback =
      body.tierFallback ??
      Object.fromEntries(
        Object.entries(inherited).filter(
          ([tier, model]) => !rateCardProblems(body.rates, { [tier]: model }).length,
        ),
      );
    const version = m.publishRateCard(
      { effectiveFrom, rates: body.rates, tierFallback, note: body.note },
      { kind: 'human', id: auth.user.id },
      'api',
    );
    return c.json(rateCardVersion(m, version), 201);
  });

  app.get('/api/metering/subscription', (c) => {
    viewer(c, false);
    return c.json(buildSubscription(m));
  });

  app.put('/api/metering/subscription', async (c) => {
    const auth = requirePermission(c, 'ratecard.edit');
    const body = await readJson(c, SubscriptionUpdateSchema);
    const today = m.today();
    const lastClosed = m.lastClosedDay();
    const earliest = lastClosed ? maxDate(today, addDays(lastClosed, 1)) : today;
    const effectiveFrom = body.effectiveFrom ?? earliest;
    if (effectiveFrom < earliest) {
      throw new HttpError(
        422,
        'forward_only',
        `Subscription changes apply from ${earliest} onward (closed days are never restated)`,
        {
          today,
          lastClosedDay: lastClosed,
          earliestEffectiveFrom: earliest,
        },
      );
    }
    m.updateSubscription(
      { plan: body.plan, seats: body.seats, monthlyUsdPerSeat: body.monthlyUsdPerSeat, effectiveFrom },
      { kind: 'human', id: auth.user.id },
      'api',
    );
    return c.json(buildSubscription(m), 201);
  });
}

/** The rate card is reference data for anyone working with sessions or costs (not requesters). */
function requireRateCardReader(c: Ctx): void {
  const { user } = requireUser(c);
  if (!canViewOrg(user) && !canOwnSessions(user) && !hasPermission(user.role, 'ratecard.edit', user.flags)) {
    throw new HttpError(403, 'forbidden', 'Missing permission to view the rate card');
  }
}
