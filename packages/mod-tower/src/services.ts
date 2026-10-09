/**
 * Optional cross-module services, used only where another module's logic is required (rate card, FX, credit
 * balances, ledger progress, decision titles, the sessions directory, the registry). Every call degrades to a
 * neutral value when the service is absent or fails, so the tower never throws because a module is missing.
 */
import type { CreditBalance, ProcessType, ServiceMap, UsageTotals } from '@aoc/contracts';
import type { ModuleContext } from '@aoc/kernel';

/** Built per snapshot (registry lookups are memoised for one read); `warned` is shared so failures log once. */
export class TowerServices {
  private readonly types = new Map<string, ProcessType | null>();

  constructor(
    private readonly ctx: ModuleContext,
    private readonly warned: Set<string>,
  ) {}

  private call<K extends keyof ServiceMap, T>(name: K, fn: (svc: ServiceMap[K]) => T, fallback: T): T {
    const svc = this.ctx.services.maybe(name);
    if (!svc) return fallback;
    try {
      return fn(svc);
    } catch (err) {
      if (!this.warned.has(name)) {
        this.warned.add(name);
        this.ctx.log.warn('tower: service call failed; degrading', { service: name, err: String(err) });
      }
      return fallback;
    }
  }

  /** Notional API-equivalent USD (0 without metering). */
  costUsd(model: string, usage: UsageTotals, date: string): number {
    return this.call('metering', (m) => m.notionalCostUsd(model, usage, date), 0);
  }

  fxRate(date: string): number | null {
    return this.call('metering', (m) => m.fxRate(date)?.rate ?? null, null);
  }

  decisionTitle(decisionId: string): string | null {
    return this.call('decisions', (d) => d.get(decisionId)?.title ?? null, null);
  }

  projectProgressPct(projectId: string): number | null {
    return this.call('ledger', (l) => l.projectProgress(projectId)?.pct ?? null, null);
  }

  creditBalance(userId: string): CreditBalance | null {
    return this.call('credits', (c) => c.balance(userId), null);
  }

  get hasCredits(): boolean {
    return this.ctx.services.has('credits');
  }

  userName(userId: string): string | null {
    return this.call('identity', (i) => i.getUser(userId)?.name ?? null, null);
  }

  /** Owner from the sessions directory, for sessions the tower's own projection could not attribute. */
  sessionOwner(sessionId: string): string | null {
    return this.call('sessions', (s) => s.get(sessionId)?.ownerId ?? null, null);
  }

  processType(id: string): ProcessType | null {
    if (!this.types.has(id))
      this.types.set(
        id,
        this.call('registry', (r) => r.getType(id), null),
      );
    return this.types.get(id)!;
  }
}
