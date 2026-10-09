import { afterEach, describe, expect, it } from 'vitest';
import type { AuditHealthDTO } from '@aoc/contracts';
import { auditRuntime, forgeChain, nudge, type AuditTest } from './helpers';

let a: AuditTest | null = null;
afterEach(async () => {
  await a?.t.close();
  a = null;
});

describe('the audit service (ServiceMap.audit)', () => {
  it('is provided by mod-audit: verify (recorded only on request), lastAnchor and health', async () => {
    a = await auditRuntime();
    const { t } = a;
    const audit = t.rt.services.get('audit');
    expect(audit).toBe(a.mod.service());
    nudge(t, 'ses_a', 'x');
    expect(audit.lastAnchor()).toBeNull();

    const head = t.rt.store.head().seq;
    const quiet = await audit.verify();
    expect(quiet).toMatchObject({ ok: true, eventSeq: null, headSeq: head });
    expect(t.rt.store.head().seq).toBe(head);

    const anchored = await a.mod.service().anchorNow({ kind: 'system', id: 'test' }, 'system');
    expect(anchored.ok).toBe(true);
    expect(audit.lastAnchor()).toMatchObject({ provider: 'git', seq: head });

    const recorded = await audit.verify({ actor: { kind: 'human', id: a.approver.user.id }, source: 'api' });
    expect(recorded.ok).toBe(true);
    expect(t.rt.store.get(recorded.eventSeq!)).toMatchObject({
      type: 'chain.verified',
      actor: { kind: 'human', id: a.approver.user.id },
      meta: { ok: true, anchorsChecked: 1, anchorsMatched: 1 },
    });
    const viaRoute = await t.json<AuditHealthDTO>('GET', '/api/audit/health', { headers: a.builder.headers });
    expect(audit.health()).toEqual(viaRoute);
    expect(audit.health().lastVerification).toMatchObject({ ok: true, eventSeq: recorded.eventSeq });
  });

  it('serialises verify with anchoring, so it never sees an anchor committed off-host but not yet recorded', async () => {
    a = await auditRuntime();
    nudge(a.t, 'ses_a', 'x');
    const anchoring = a.mod.service().anchorNow({ kind: 'system', id: 'test' }, 'system');
    const report = await a.t.rt.services.get('audit').verify();
    expect((await anchoring).ok).toBe(true);
    expect(report).toMatchObject({ ok: true, problems: [] });
    expect(report.anchors).toHaveLength(1);
  });

  it('a failed recorded verify raises an audit.integrity notification', async () => {
    a = await auditRuntime();
    const { t } = a;
    const victim = nudge(t, 'ses_a', 'x');
    nudge(t, 'ses_a', 'y');
    await a.mod.service().anchorNow({ kind: 'system', id: 'test' }, 'system');
    forgeChain(t.dataDir, { seq: victim.seq, mutate: (m) => ({ ...m, sessionId: 'ses_forged' }) });
    const report = await t.rt.services.get('audit').verify({ actor: { kind: 'system', id: 'test' }, source: 'system' });
    expect(report.ok).toBe(false);
    expect(a.notes).toContainEqual(
      expect.objectContaining({
        kind: 'audit.integrity',
        severity: 'danger',
        audience: ['approver', 'builder'],
        link: '/audit',
        refs: { firstBadSeq: String(report.firstBadSeq), eventSeq: String(report.eventSeq) },
      }),
    );
  });
});
