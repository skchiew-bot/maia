import type { GuardResult, PolicyService, PreToolContext, PreToolGuard } from '@aoc/contracts';

/** Guard registry for PreToolUse enforcement. First deny wins (by guard order); observed sessions are never blocked. */
export class GuardPolicy implements PolicyService {
  private readonly guards: PreToolGuard[] = [];

  register(guard: PreToolGuard): void {
    if (this.guards.some((g) => g.name === guard.name)) throw new Error(`duplicate guard ${guard.name}`);
    this.guards.push(guard);
    this.guards.sort((a, b) => a.order - b.order);
  }

  evaluate(ctx: PreToolContext): GuardResult {
    for (const g of this.guards) {
      let r: GuardResult | null;
      try {
        r = g.evaluate(ctx);
      } catch (err) {
        // A broken guard fails closed for managed sessions ("fail loudly", §2).
        r = { decision: 'deny', guard: g.name, reason: `AOC guard ${g.name} failed: ${String(err)}` };
      }
      if (r && r.decision !== 'allow') {
        if (ctx.mode === 'observed') return { decision: 'allow', guard: g.name, reason: `observed: would ${r.decision} (${r.reason})` };
        return r;
      }
    }
    return { decision: 'allow', guard: 'none', reason: 'allowed' };
  }

  list(): string[] {
    return this.guards.map((g) => g.name);
  }
}
