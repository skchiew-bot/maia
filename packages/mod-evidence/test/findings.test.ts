import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  EvidenceBreakglassFile,
  EvidenceCredits,
  EvidenceFx,
  EvidenceGates,
  EvidencePackDetailDTO,
  EvidenceRollbacks,
} from '@aoc/contracts';
import { createTestRuntime, type TestRuntime } from '@aoc/kernel';
import { createEvidenceModule } from '../src';
import { append, unzip } from './helpers';

let t: TestRuntime;
afterEach(async () => {
  await t?.close();
});

const sys = { kind: 'system' as const, id: 'test' };
const human = (id: string) => ({ kind: 'human' as const, id });

describe('governance findings in a pack', () => {
  it('flags gates, rollbacks, break-glass and credit anomalies, and reconciles FX discrepancies', async () => {
    t = await createTestRuntime({
      modules: [createEvidenceModule({ mappingFile: null })],
      onDisk: true,
      now: '2026-10-01T00:00:00.000Z',
    });
    const builder = t.user('builder');
    const b = builder.user.id;
    const requestGate = (
      at: string,
      decisionId: string,
      kind: 'go_live' | 'change_request',
      requiresPasskey: boolean,
    ) =>
      append(t, at, {
        type: 'decision.requested',
        actor: human(b),
        meta: {
          decisionId,
          kind,
          test: null,
          requiredRole: 'approver',
          requiresPasskey,
          subjectType: 'test',
          subjectId: decisionId,
          sessionId: null,
          projectId: null,
          optionIds: ['approve'],
          recommendedOptionId: null,
          requesterId: b,
          excludedApproverIds: [],
          eligibleUserIds: null,
          dueAt: null,
        },
        payload: { title: 't', question: 'q', options: [{ id: 'approve', label: 'Approve' }] },
        source: 'api',
      });
    const resolve = (
      at: string,
      decisionId: string,
      kind: 'go_live' | 'change_request',
      o: { passkeyVerified: boolean; selfApproved: boolean },
    ) =>
      append(t, at, {
        type: 'decision.resolved',
        actor: human(b),
        meta: { decisionId, kind, optionId: 'approve', resolvedBy: b, method: 'button', ageMs: 1000, ...o },
        payload: {},
        source: 'api',
      });

    requestGate('2026-10-03T01:00:00.000Z', 'dec_nopk', 'go_live', true);
    resolve('2026-10-03T01:01:00.000Z', 'dec_nopk', 'go_live', {
      passkeyVerified: false,
      selfApproved: false,
    });
    requestGate('2026-10-03T01:02:00.000Z', 'dec_self', 'change_request', false);
    resolve('2026-10-03T01:03:00.000Z', 'dec_self', 'change_request', {
      passkeyVerified: false,
      selfApproved: true,
    });
    resolve('2026-10-03T01:04:00.000Z', 'dec_orphan', 'change_request', {
      passkeyVerified: false,
      selfApproved: false,
    });

    append(t, '2026-10-03T02:00:00.000Z', {
      type: 'rollback.requested',
      actor: human(b),
      meta: {
        rollbackId: 'rbk_bad',
        projectId: 'prj_1',
        targetRef: 'v1',
        targetSha: 'abc1234',
        changeId: null,
      },
      payload: { reason: 'r' },
      source: 'api',
    });
    append(t, '2026-10-03T02:10:00.000Z', {
      type: 'rollback.verified',
      actor: sys,
      meta: {
        rollbackId: 'rbk_bad',
        branch: 'rb',
        testsPassed: 3,
        testsFailed: 2,
        clean: false,
        decisionId: null,
      },
      payload: { report: 'r' },
      source: 'supervisor',
    });
    append(t, '2026-10-03T02:20:00.000Z', {
      type: 'rollback.approved',
      actor: human(b),
      meta: { rollbackId: 'rbk_bad', decisionId: 'dec_rbk', approverId: b, passkeyVerified: false },
      source: 'api',
    });
    append(t, '2026-10-03T02:30:00.000Z', {
      type: 'rollback.executed',
      actor: sys,
      meta: { rollbackId: 'rbk_bad', mainShaBefore: 'abc1234', mainShaAfter: 'def5678' },
      source: 'supervisor',
    });
    append(t, '2026-10-03T02:40:00.000Z', {
      type: 'rollback.requested',
      actor: human(b),
      meta: {
        rollbackId: 'rbk_fail',
        projectId: 'prj_1',
        targetRef: 'v2',
        targetSha: 'bcd2345',
        changeId: null,
      },
      payload: { reason: 'r' },
      source: 'api',
    });
    append(t, '2026-10-03T02:45:00.000Z', {
      type: 'rollback.approved',
      actor: human(b),
      meta: { rollbackId: 'rbk_fail', decisionId: 'dec_rbk2', approverId: b, passkeyVerified: true },
      source: 'api',
    });
    append(t, '2026-10-03T02:50:00.000Z', {
      type: 'rollback.failed',
      actor: sys,
      meta: { rollbackId: 'rbk_fail', reason: 'push_rejected' },
      payload: { detail: 'remote rejected the push' },
      source: 'supervisor',
    });

    append(t, '2026-10-03T03:00:00.000Z', {
      type: 'breakglass.invoked',
      actor: human(b),
      meta: {
        breakglassId: 'brk_x',
        projectId: 'prj_1',
        invokedBy: b,
        ref: 'hotfix',
        sha: 'fff0000',
        decisionId: 'dec_brk',
      },
      payload: { justification: 'j' },
      source: 'api',
    });
    append(t, '2026-10-03T03:05:00.000Z', {
      type: 'breakglass.approved',
      actor: human(b),
      meta: {
        breakglassId: 'brk_x',
        decisionId: 'dec_brk',
        approverId: b,
        passkeyVerified: false,
        postIncidentChangeId: 'chg_never',
        dueAt: '2026-10-04T03:05:00.000Z',
      },
      source: 'api',
    });
    append(t, '2026-10-03T03:10:00.000Z', {
      type: 'promotion.completed',
      actor: sys,
      meta: {
        promotionId: 'prm_bg',
        mainShaBefore: 'aaa1111',
        mainShaAfter: 'fff0000',
        breakglass: true,
        decisionId: 'dec_brk',
      },
      source: 'supervisor',
    });

    for (const at of ['2026-10-03T04:00:00.000Z', '2026-10-03T05:00:00.000Z']) {
      append(t, at, {
        type: 'credit.auto_granted',
        actor: sys,
        meta: {
          userId: b,
          period: '2026-10',
          amountUsd: 10,
          balanceBefore: 0,
          balanceAfter: 10,
          sessionId: null,
          taskId: null,
        },
        source: 'system',
      });
    }
    const selfTopup = append(t, '2026-10-03T06:00:00.000Z', {
      type: 'credit.topup_granted',
      actor: human(b),
      meta: {
        requestId: 'tpu_self',
        userId: b,
        amountUsd: 50,
        approverId: b,
        balanceBefore: 0,
        balanceAfter: 50,
        decisionId: 'dec_tpu',
      },
      source: 'api',
    });

    append(t, '2026-10-03T07:00:00.000Z', {
      type: 'fx.discrepancy_raised',
      actor: sys,
      meta: { date: '2026-10-03', scraped: 4.1, official: 4.15, decisionId: 'dec_fx' },
      payload: {},
      source: 'scheduler',
    });
    append(t, '2026-10-03T08:00:00.000Z', {
      type: 'fx.discrepancy_resolved',
      actor: human(b),
      meta: { date: '2026-10-03', chosenRate: 4.15, decisionId: 'dec_fx' },
      source: 'api',
    });

    t.clock.set('2026-10-09T02:00:00.000Z');
    const detail = await t.json<EvidencePackDetailDTO>('POST', '/api/evidence/packs', {
      headers: builder.headers,
      body: { from: '2026-10-03', to: '2026-10-03' },
      expect: 201,
    });
    const files = unzip(readFileSync(join(t.dataDir, 'evidence', `${detail.packId}.zip`)));
    const json = <T>(name: string) => JSON.parse(files[name]!) as T;

    const gates = json<EvidenceGates>('gates.json');
    expect(Object.fromEntries(gates.gates.map((g) => [g.decisionId, g.flags]))).toEqual({
      dec_nopk: ['passkey_not_verified'],
      dec_self: ['self_approved_approver_gate'],
      dec_orphan: ['request_not_found'],
    });
    expect(gates).toMatchObject({ flagged: 3, selfApproved: 1 });

    const rollbacks = json<EvidenceRollbacks>('rollbacks.json');
    expect(rollbacks.rollbacks[0]).toMatchObject({
      status: 'executed',
      clean: false,
      testsFailed: 2,
      flags: ['executed_without_clean_verification', 'approved_without_passkey'],
    });
    // An approved rollback that could not be executed is reported as failed, never as still approved.
    expect(rollbacks.rollbacks[1]).toMatchObject({ rollbackId: 'rbk_fail', status: 'failed', flags: [] });
    expect(rollbacks).toMatchObject({ count: 2, executed: 1, flagged: 1 });

    const bg = json<EvidenceBreakglassFile>('breakglass.json');
    expect(bg.incidents[0]).toMatchObject({
      breakglassId: 'brk_x',
      postIncident: { changeId: 'chg_never', completedAt: null, completedWithinDue: null },
      flags: ['approved_without_passkey', 'post_incident_overdue', 'post_incident_open'],
    });
    expect(bg.breakglassPromotions.map((p) => p.meta.promotionId)).toEqual(['prm_bg']);

    const credits = json<EvidenceCredits>('credits.json');
    expect(credits.flags.map((f) => f.flag)).toEqual(['self_granted_topup', 'repeat_auto_grant_in_period']);
    expect(credits.flags[0]!.eventId).toBe(selfTopup.id);
    expect(credits.totals.autoGrantedUsd).toBe(20);

    const fx = json<EvidenceFx>('fx.json');
    expect(fx.discrepancies).toEqual([
      expect.objectContaining({
        date: '2026-10-03',
        scraped: 4.1,
        official: 4.15,
        decisionId: 'dec_fx',
        resolution: expect.objectContaining({ chosenRate: 4.15 }),
      }),
    ]);
    expect(fx.summary).toMatchObject({ discrepanciesRaised: 1, discrepanciesResolved: 1, missing: 1 });

    const html = files['index.html']!;
    expect(html).toContain('<td>Gate</td><td>dec_nopk (go_live)</td><td>passkey_not_verified</td>');
    expect(html).toContain(
      '<td>Rollback</td><td>rbk_bad</td><td>executed_without_clean_verification, approved_without_passkey</td>',
    );
    expect(html).toContain(`<td>Credits</td><td>${selfTopup.id}</td><td>self_granted_topup</td>`);
  });
});
