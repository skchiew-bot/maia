import { z } from 'zod';
import {
  CREDIT_TOPUP_STATUSES,
  CreditAllocationInput,
  CreditPeriodQuery,
  CreditTopupRequestInput,
  hasPermission,
  type CreditTopupRequestList,
} from '@aoc/contracts';
import { HttpError, parseQuery, readJson, requirePermission, requireUser, type App } from '@aoc/kernel';
import type { CreditsEngine } from './service';

const TopupListQuery = z.object({ status: z.enum(CREDIT_TOPUP_STATUSES).optional() });

export function registerCreditRoutes(app: App, engine: () => CreditsEngine): void {
  app.get('/api/credits/me', (c) => {
    const auth = requirePermission(c, 'credit.topup_request');
    const q = parseQuery(c, CreditPeriodQuery);
    return c.json(engine().account(auth.user.id, q.period));
  });

  app.get('/api/credits/accounts', (c) => {
    requirePermission(c, 'credit.view_all');
    const q = parseQuery(c, CreditPeriodQuery);
    return c.json(engine().accounts(q.period));
  });

  app.post('/api/credits/allocations', async (c) => {
    const auth = requirePermission(c, 'credit.allocate');
    const body = await readJson(c, CreditAllocationInput);
    return c.json(engine().allocate(auth.user, body), 201);
  });

  app.post('/api/credits/topup-requests', async (c) => {
    const auth = requirePermission(c, 'credit.topup_request');
    const body = await readJson(c, CreditTopupRequestInput);
    return c.json(engine().requestTopup(auth.user, body), 201);
  });

  /** Approvers see every request; builders see their own. */
  app.get('/api/credits/topup-requests', (c) => {
    const { user } = requireUser(c);
    const seesAll = hasPermission(user.role, 'credit.topup_approve', user.flags);
    if (!seesAll && !hasPermission(user.role, 'credit.topup_request', user.flags)) {
      throw new HttpError(403, 'forbidden', 'Missing permission credit.topup_request');
    }
    const q = parseQuery(c, TopupListQuery);
    const body: CreditTopupRequestList = {
      requests: engine().topups({ userId: seesAll ? undefined : user.id, status: q.status }),
    };
    return c.json(body);
  });
}
