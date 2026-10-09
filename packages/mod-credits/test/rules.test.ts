import { describe, expect, it } from 'vitest';
import {
  autoGrantAmount,
  balanceOf,
  boundaryVerdict,
  capInstruction,
  isCapped,
  roundCents,
  roundUsd,
} from '../src/rules';

describe('credit rules', () => {
  it('rounds money without float noise or negative zero', () => {
    expect(roundUsd(0.1 + 0.2)).toBe(0.3);
    expect(roundUsd(-0.00001)).toBe(0);
    expect(Object.is(roundUsd(-0.00001), 0)).toBe(true);
    expect(roundCents(83.3325)).toBe(83.33);
    expect(balanceOf({ allocationUsd: 100, grantedUsd: 25, usedUsd: 130.123441 })).toBe(-5.1234);
  });

  it('auto grant is a percentage of the original allocation only', () => {
    expect(autoGrantAmount(300, 25)).toBe(75);
    expect(autoGrantAmount(333.33, 25)).toBe(83.33);
    expect(autoGrantAmount(100, 0)).toBe(0);
    expect(autoGrantAmount(0, 25)).toBe(0);
  });

  it('boundary verdict: continue above zero, auto grant once at/below zero, then cap', () => {
    const base = { exempt: false, autoGrantUsed: false, autoGrantUsd: 25 };
    expect(boundaryVerdict({ ...base, balanceUsd: 0.01 })).toEqual({ action: 'continue' });
    expect(boundaryVerdict({ ...base, balanceUsd: 0 })).toEqual({
      action: 'auto_grant',
      amountUsd: 25,
      balanceAfter: 25,
    });
    expect(boundaryVerdict({ ...base, balanceUsd: -3 })).toEqual({
      action: 'auto_grant',
      amountUsd: 25,
      balanceAfter: 22,
    });
    expect(boundaryVerdict({ ...base, balanceUsd: -3, autoGrantUsed: true, autoGrantUsd: 0 })).toEqual({
      action: 'cap',
    });
    expect(boundaryVerdict({ ...base, balanceUsd: -3, autoGrantUsd: 0 })).toEqual({ action: 'cap' });
    expect(boundaryVerdict({ ...base, balanceUsd: -1000, exempt: true })).toEqual({ action: 'continue' });
  });

  it('capped means the next boundary stops work', () => {
    const base = { exempt: false, autoGrantUsed: false, autoGrantUsd: 25 };
    expect(isCapped({ ...base, balanceUsd: 0 })).toBe(false);
    expect(isCapped({ ...base, balanceUsd: -30 })).toBe(true);
    expect(isCapped({ ...base, balanceUsd: -1, autoGrantUsed: true, autoGrantUsd: 0 })).toBe(true);
    expect(isCapped({ ...base, balanceUsd: -1, exempt: true })).toBe(false);
  });

  it('cap instruction tells the agent to end its turn and never mentions a model', () => {
    const i = capInstruction('2026-10');
    expect(i).toEqual({
      continue: false,
      reason: 'credit_cap',
      instruction:
        'Credit cap reached for 2026-10. Finish nothing new: end your turn now. Work resumes automatically after a top-up is approved.',
    });
    expect(JSON.stringify(i)).not.toMatch(/model|opus|sonnet|haiku|fable/i);
  });
});
