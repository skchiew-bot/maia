import { afterEach, describe, expect, it } from 'vitest';
import type { VerifyReportDTO } from '@aoc/contracts';
import type { TestRuntime } from '@aoc/kernel';
import { auditRuntime, type AuditTest } from './helpers';

let a: AuditTest | null = null;
afterEach(async () => {
  await a?.t.close();
  a = null;
});

function fill(t: TestRuntime, n: number): void {
  for (let i = 0; i < n; i += 1000) {
    t.rt.store.appendMany(
      Array.from({ length: Math.min(1000, n - i) }, (_, j) => ({
        type: 'session.restarted' as const,
        actor: { kind: 'human' as const, id: 'usr_1' },
        scope: { sessionId: `ses_${(i + j) % 25}` },
        meta: { sessionId: `ses_${(i + j) % 25}` },
        source: 'api' as const,
      })),
    );
  }
}

/** Counts event-loop turns (macrotasks) until stopped: a synchronous chain pass would allow none. */
function turnCounter(): { stop(): number } {
  let turns = 0;
  let running = true;
  const tick = () => {
    if (!running) return;
    turns++;
    setImmediate(tick);
  };
  setImmediate(tick);
  return {
    stop() {
      running = false;
      return turns;
    },
  };
}

describe('verification never stalls the sole writer', () => {
  it('the verify route and the nightly job recompute a large chain in chunks, yielding to the event loop', async () => {
    // No anchor provider and no anchor repo: nothing else in the verify path waits on I/O.
    a = await auditRuntime({ config: { audit: { anchorProvider: 'none' } } });
    const { t } = a;
    fill(t, 12_000);

    let turns = turnCounter();
    const report = await t.json<VerifyReportDTO>('GET', '/api/audit/verify', { headers: a.builder.headers });
    expect(turns.stop()).toBeGreaterThan(10);
    expect(report).toMatchObject({ ok: true, chainOk: true, checked: report.headSeq });
    expect(report.headSeq).toBeGreaterThanOrEqual(12_000);

    turns = turnCounter();
    await t.rt.runJob('audit.anchor');
    expect(turns.stop()).toBeGreaterThan(10);
    expect(t.rt.store.list({ types: ['chain.verified'], order: 'desc', limit: 1 })[0]!.meta).toMatchObject({
      ok: true,
      checked: report.headSeq + 1,
    });
  }, 60_000);

  it('appends made while a verify runs are not reported as a head mismatch, and anchoring still anchors the verified head', async () => {
    a = await auditRuntime();
    const { t } = a;
    fill(t, 6000);
    const head = t.rt.store.head();
    const anchoring = a.mod.service().anchorNow({ kind: 'human', id: a.approver.user.id }, 'api');
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setImmediate(r));
      t.rt.store.append({
        type: 'session.restarted',
        actor: { kind: 'human', id: 'usr_1' },
        scope: { sessionId: 'ses_late' },
        meta: { sessionId: 'ses_late' },
        source: 'api',
      });
    }
    const r = await anchoring;
    expect(r).toMatchObject({ ok: true, anchor: { seq: head.seq, hash: head.hash } });
    expect((await a.mod.service().computeVerify()).ok).toBe(true);
  }, 60_000);
});
