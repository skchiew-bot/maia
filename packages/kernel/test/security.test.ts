import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EventStore, EventValidationError, FakeClock, silentLogger } from '../src';

const mk = (dataDir = ':memory:', key = randomBytes(32)) =>
  new EventStore({ dataDir, clock: new FakeClock(), log: silentLogger, masterKey: key });

const nudge = (sessionId: string, text: string) => ({
  type: 'session.nudged' as const,
  actor: { kind: 'human' as const, id: 'usr_1' },
  scope: { sessionId },
  meta: { sessionId },
  payload: { text },
  source: 'api' as const,
});

describe('chained header fields are bounded like meta', () => {
  it('rejects a sourceTs that is not a timestamp (free text would be chained in clear, forever)', () => {
    const s = mk();
    const pii = 'Nur Aisyah binti Ahmad, NRIC 850101-14-5555, +60 12-345 6789';
    expect(() => s.append({ ...nudge('ses_a', 'x'), sourceTs: pii })).toThrow(EventValidationError);
    expect(() => s.append({ ...nudge('ses_a', 'x'), sourceTs: `2026-10-09T02:00:00.000Z${'x'.repeat(1_000_000)}` })).toThrow(EventValidationError);
    expect(s.head().seq).toBe(0);
    expect(s.append({ ...nudge('ses_a', 'x'), sourceTs: '2026-10-09T02:00:00.000Z' }).sourceTs).toBe('2026-10-09T02:00:00.000Z');
  });

  it('rejects oversized or control-character idempotency keys', () => {
    const s = mk();
    expect(() => s.append({ ...nudge('ses_a', 'x'), idempotencyKey: 'k'.repeat(100_000) })).toThrow(EventValidationError);
    expect(() => s.append({ ...nudge('ses_a', 'x'), idempotencyKey: 'key\nwith-newline' })).toThrow(EventValidationError);
    expect(s.head().seq).toBe(0);
    expect(s.append({ ...nudge('ses_a', 'x'), idempotencyKey: 'crd:cap:["2026-10","ses_a",null,0]' }).idempotencyKey).toBe('crd:cap:["2026-10","ses_a",null,0]');
  });
});
