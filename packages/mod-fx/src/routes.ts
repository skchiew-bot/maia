import { z } from 'zod';
import { hasPermission, type AuthContext, type FxStatusDTO, type Permission } from '@aoc/contracts';
import {
  addDays,
  HttpError,
  parseQuery,
  readJson,
  requirePermission,
  requireUser,
  type App,
  type Ctx,
  type ModuleContext,
} from '@aoc/kernel';
import type { FxEngine } from './engine';
import { toDiscrepancyDTO, toRateDTO, type FxReadModel } from './read-model';
import { carryForwardStreak } from './rules';
import { rateOn } from './service';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const MAX_RANGE_DAYS = 400;
/** Reading FX history is audit data; editing it is the rate card (approver). */
const VIEW_PERMS: Permission[] = ['audit.view', 'ratecard.edit'];

export function mountFxRoutes(app: App, ctx: ModuleContext, engine: FxEngine, model: FxReadModel): void {
  app.get('/api/fx/rates', (c) => {
    requireAnyPermission(c, VIEW_PERMS);
    const q = parseQuery(c, z.object({ from: day.optional(), to: day.optional() }));
    const to = q.to ?? engine.today();
    const from = q.from ?? addDays(to, -30);
    if (from > to) throw new HttpError(422, 'invalid_range', 'from must not be after to');
    if (from < addDays(to, -MAX_RANGE_DAYS)) {
      throw new HttpError(422, 'range_too_large', `At most ${MAX_RANGE_DAYS} days per request`);
    }
    const closed = model.closedBetween(from, to);
    return c.json({ from, to, rates: model.between(from, to).map((r) => toRateDTO(r, closed.has(r.date))) });
  });

  app.get('/api/fx/status', (c) => {
    requireAnyPermission(c, VIEW_PERMS);
    const cfg = ctx.config.fx;
    const today = engine.today();
    const todayRecord = model.record(today);
    const lastLive = model.lastLive();
    const streak = carryForwardStreak(model.recordsDescFrom(today));
    const open = model.openDiscrepancies();
    const decisions = ctx.services.maybe('decisions');
    const status: FxStatusDTO = {
      today,
      enabled: cfg.enabled,
      runAtLocalTime: cfg.runAtLocalTime,
      todayRecord: todayRecord ? toRateDTO(todayRecord, model.isClosed(today)) : null,
      current: rateOn(model, today),
      lastLive: lastLive ? { date: lastLive.date, rate: lastLive.rate } : null,
      carryForward: {
        days: streak.days,
        since: streak.since,
        alertAfterDays: cfg.carryForwardAlertDays,
        alerted: streak.since ? model.hasAlert(streak.since) : false,
      },
      openDiscrepancy: open[0]
        ? toDiscrepancyDTO(open[0], decisions?.get(open[0].decisionId)?.status ?? null)
        : null,
      openDiscrepancyCount: open.length,
    };
    return c.json(status);
  });

  app.post('/api/fx/run', async (c) => {
    const auth = requirePermission(c, 'ratecard.edit');
    if (!ctx.config.fx.enabled) throw new HttpError(409, 'fx_disabled', 'FX fetching is disabled in config');
    return c.json(await engine.run({ actor: { kind: 'human', id: auth.user.id }, source: 'api' }));
  });

  app.post('/api/fx/rates/:date/override', async (c) => {
    const auth = requirePermission(c, 'ratecard.edit');
    const body = await readJson(
      c,
      z.object({ rate: z.number().finite().positive(), reason: z.string().trim().min(3).max(2000) }),
    );
    return c.json(
      await engine.override({ date: c.req.param('date'), rate: body.rate, reason: body.reason }, auth.user),
    );
  });
}

function requireAnyPermission(c: Ctx, perms: Permission[]): AuthContext {
  const auth = requireUser(c);
  if (!perms.some((p) => hasPermission(auth.user.role, p, auth.user.flags))) {
    throw new HttpError(403, 'forbidden', `Missing permission ${perms.join(' or ')}`);
  }
  return auth;
}
