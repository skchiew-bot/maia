import type { Actor, CreditService, MeteringService, ServiceMap, UsageTotals } from '@aoc/contracts';
import { createTestRuntime, type AocModule, type TestRuntime } from '@aoc/kernel';
import { createCreditsModule } from '../src';

export const CAP_TEXT_OCT =
  'Credit cap reached for 2026-10. Finish nothing new: end your turn now. Work resumes automatically after a top-up is approved.';

export interface CostCall {
  model: string;
  usage: UsageTotals;
  date: string;
}

/** Metering stub: 1 token = 1 cent on every model, so a test spends `usd` with `usd * 100` tokens. */
export function meteringStub(): { stub: MeteringService; calls: CostCall[] } {
  const calls: CostCall[] = [];
  const stub: MeteringService = {
    notionalCostUsd(model, usage, date) {
      calls.push({ model, usage, date });
      return (
        (usage.inputTokens +
          usage.outputTokens +
          usage.cacheReadTokens +
          usage.cacheWrite5mTokens +
          usage.cacheWrite1hTokens) /
        100
      );
    },
    fxRate: () => null,
    sessionCostUsd: () => 0,
    activeRateCardVersion: () => 1,
  };
  return { stub, calls };
}

export interface CreditsHarness {
  t: TestRuntime;
  mod: AocModule;
  credits: CreditService;
  metering: { stub: MeteringService; calls: CostCall[] };
}

/** Runtime with the credits module, a metering stub and a $100 default monthly allocation (25% auto grant). */
export async function setup(
  opts: {
    credits?: { defaultMonthlyAllocationUsd?: number; autoGrantPct?: number; exemptUserIds?: string[] };
    services?: Partial<ServiceMap>;
    now?: string;
  } = {},
): Promise<CreditsHarness> {
  const metering = meteringStub();
  const mod = createCreditsModule();
  const t = await createTestRuntime({
    modules: [mod],
    services: { metering: metering.stub, ...opts.services },
    config: { credits: { defaultMonthlyAllocationUsd: 100, ...opts.credits } },
    now: opts.now,
  });
  return { t, mod, credits: t.rt.services.get('credits'), metering };
}

let messageNo = 0;
/** Append a sidecar usage batch costing `usd` (stub rate) for a session, at `at` (default: now). */
export function spend(
  t: TestRuntime,
  sessionId: string,
  usd: number,
  opts: { at?: string; model?: string } = {},
) {
  const at = opts.at ?? t.clock.iso();
  return t.rt.store.append({
    type: 'usage.recorded',
    actor: { kind: 'system', id: 'sidecar' },
    scope: { sessionId },
    meta: {
      sessionId,
      model: opts.model ?? 'claude-opus-5-5',
      inputTokens: Math.round(usd * 100),
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      messages: 1,
      contextTokens: 1000,
      firstAt: at,
      lastAt: at,
    },
    payload: { messageIds: [`msg_${++messageNo}`] },
    source: 'sidecar',
  });
}

export const agent = (sessionId: string): Actor => ({ kind: 'agent', id: sessionId });

/** Types of every credit.* event so far, in log order. */
export const creditTypes = (t: TestRuntime) => t.rt.store.list({ typePrefix: 'credit.' }).map((e) => e.type);

export const eventsOf = (t: TestRuntime, type: string) => t.rt.store.list({ types: [type] });
