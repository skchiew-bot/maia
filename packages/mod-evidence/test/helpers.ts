import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import type { EventType, StoredEvent } from '@aoc/contracts';
import type { NewEvent, TestRuntime, TestUser } from '@aoc/kernel';

export const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** Range used by the pack tests: 2026-10-03..2026-10-05 in Asia/Kuala_Lumpur (UTC+8). */
export const RANGE = { from: '2026-10-03', to: '2026-10-05' } as const;
export const RANGE_START = '2026-10-02T16:00:00.000Z';
export const RANGE_END_EXCL = '2026-10-05T16:00:00.000Z';
export const NOW = '2026-10-09T02:00:00.000Z';

/** Every payload below carries one of these; none may appear anywhere in a pack. */
export const SECRET = 'SECRET-';

export function append<T extends EventType>(t: TestRuntime, at: string, input: NewEvent<T>): StoredEvent {
  t.clock.set(at);
  return t.rt.store.append(input);
}

export function anchorHead(t: TestRuntime, at: string, anchorId: string, hash?: string): StoredEvent {
  const head = t.rt.store.head();
  return append(t, at, {
    type: 'anchor.created',
    actor: { kind: 'system', id: 'audit' },
    meta: {
      anchorId,
      seq: head.seq,
      hash: hash ?? head.hash,
      provider: 'git',
      proofRef: `anchor-repo@${anchorId}`,
    },
    source: 'scheduler',
  });
}

export function unzip(bytes: Uint8Array): Record<string, string> {
  return Object.fromEntries(Object.entries(unzipSync(bytes)).map(([k, v]) => [k, strFromU8(v)]));
}

export interface Seeded {
  builder: TestUser;
  approver: TestUser;
  requester: TestUser;
  boundary: { beforeStart: string; atStart: string; atEnd: string; afterEnd: string };
  anchors: { before: StoredEvent; during: StoredEvent; after: StoredEvent };
  goLiveRequest: StoredEvent;
}

const nudge = (sessionId: string, text: string): NewEvent<'session.nudged'> => ({
  type: 'session.nudged',
  actor: { kind: 'human', id: 'usr_operator' },
  scope: { sessionId },
  meta: { sessionId },
  payload: { text },
  source: 'api',
});

/**
 * Seed a realistic spread of events before, inside and after RANGE. The runtime should start at
 * 2026-10-01 so module start-up events (mapping.published) land before the range.
 */
export function seed(t: TestRuntime): Seeded {
  t.clock.set('2026-10-01T01:00:00.000Z');
  const builder = t.user('builder', `${SECRET}NAME-Bea Builder`);
  const approver = t.user('approver', `${SECRET}NAME-Ann Approver`);
  const requester = t.user('requester', `${SECRET}NAME-Rex Requester`);
  const b = builder.user.id;
  const a = approver.user.id;
  const human = (id: string) => ({ kind: 'human' as const, id });

  // ── before the range ───────────────────────────────────────────────────────
  append(t, '2026-10-01T02:00:00.000Z', {
    type: 'ratecard.published',
    actor: { kind: 'system', id: 'metering' },
    meta: { version: 1, effectiveFrom: '2026-10-01', rateCount: 1 },
    payload: {
      rates: [
        {
          model: 'claude-opus-5-5',
          inputPerMTok: 4,
          outputPerMTok: 20,
          cacheReadPerMTok: 0.2,
          cacheWrite5mPerMTok: 5,
          cacheWrite1hPerMTok: 8,
        },
      ],
    },
    source: 'system',
  });
  append(t, '2026-10-02T04:30:00.000Z', {
    type: 'fx.rate_recorded',
    actor: { kind: 'system', id: 'scheduler:fx' },
    meta: {
      date: '2026-10-02',
      pair: 'USD/MYR',
      rate: 4.19,
      status: 'live',
      sourceDate: '2026-10-02',
      extractor: 'haiku',
      validation: 'pass',
      reason: 'fetched',
    },
    payload: { notes: `${SECRET}FX-NOTE` },
    source: 'scheduler',
  });
  append(t, '2026-10-02T05:00:00.000Z', {
    type: 'change.drafted',
    actor: human(b),
    scope: { changeId: 'chg_A', projectId: 'prj_1' },
    meta: {
      changeId: 'chg_A',
      projectId: 'prj_1',
      scope: 'main',
      draftedBy: 'ai',
      sessionId: null,
      breakglassId: null,
    },
    payload: {
      title: `${SECRET}TITLE`,
      impact: `${SECRET}IMPACT-55d1`,
      mitigation: 'feature flag',
      rollbackPlan: 'revert',
      rollbackRef: 'v1.0.0',
      acceptanceTest: 'e2e',
    },
    source: 'api',
  });
  const goLiveRequest = append(t, '2026-10-02T06:00:00.000Z', {
    type: 'decision.requested',
    actor: human(b),
    scope: { decisionId: 'dec_golive', projectId: 'prj_1' },
    meta: {
      decisionId: 'dec_golive',
      kind: 'go_live',
      test: null,
      requiredRole: 'approver',
      requiresPasskey: true,
      subjectType: 'promotion',
      subjectId: 'prm_1',
      sessionId: null,
      projectId: 'prj_1',
      optionIds: ['approve', 'reject'],
      recommendedOptionId: null,
      requesterId: b,
      excludedApproverIds: [b],
      eligibleUserIds: null,
      dueAt: null,
    },
    payload: {
      title: `${SECRET}GATE-TITLE`,
      question: 'Ship?',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
    },
    source: 'api',
  });
  const anchorBefore = anchorHead(t, '2026-10-02T07:00:00.000Z', 'anc_before');
  const beforeStart = append(t, '2026-10-02T15:59:59.999Z', nudge('ses_1', `${SECRET}NUDGE-before`)).id;

  // ── inside the range (local 2026-10-03 00:00 .. 2026-10-05 23:59:59.999) ─────
  const atStart = append(t, RANGE_START, nudge('ses_1', `${SECRET}NUDGE-7f3a`)).id;
  append(t, '2026-10-03T01:00:00.000Z', {
    type: 'prompt.submitted',
    actor: human(b),
    scope: { sessionId: 'ses_1' },
    meta: { sessionId: 'ses_1', origin: 'operator' },
    payload: { text: `${SECRET}PROMPT-91c2` },
    source: 'api',
  });
  append(t, '2026-10-03T01:10:00.000Z', {
    type: 'session.liveness_changed',
    actor: { kind: 'system', id: 'sessions' },
    scope: { sessionId: 'ses_1' },
    meta: { sessionId: 'ses_1', from: 'working', to: 'thinking', reason: 'no_tool_activity' },
    source: 'system',
  });
  append(t, '2026-10-03T01:20:00.000Z', {
    type: 'usage.recorded',
    actor: { kind: 'agent', id: 'ses_1' },
    scope: { sessionId: 'ses_1' },
    meta: {
      sessionId: 'ses_1',
      model: 'claude-opus-5-5',
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWrite5mTokens: 0,
      cacheWrite1hTokens: 0,
      messages: 1,
      contextTokens: 5000,
      firstAt: '2026-10-03T01:00:00.000Z',
      lastAt: '2026-10-03T01:19:00.000Z',
    },
    payload: { messageIds: ['msg_1'] },
    source: 'sidecar',
  });
  append(t, '2026-10-03T02:00:00.000Z', {
    type: 'task.done',
    actor: { kind: 'agent', id: 'ses_1' },
    scope: { sessionId: 'ses_1', projectId: 'prj_1', taskId: 't1' },
    meta: {
      sessionId: 'ses_1',
      projectId: 'prj_1',
      taskId: 't1',
      phaseId: 'p1',
      weight: 3,
      evidenceKind: 'test',
      evidenceVerified: true,
      flag: null,
      fileChangesSinceLast: 2,
    },
    payload: { evidence: { kind: 'test', ref: 'pkg/foo.test.ts > adds', detail: `${SECRET}EVIDENCE-e2e2` } },
    source: 'mcp',
  });
  append(t, '2026-10-03T03:00:00.000Z', {
    type: 'change.field_affirmed',
    actor: human(b),
    scope: { changeId: 'chg_A' },
    meta: { changeId: 'chg_A', field: 'impact', edited: false, editRatio: 0, dwellMs: 900 },
    payload: { value: `${SECRET}IMPACT-55d1` },
    source: 'api',
  });
  append(t, '2026-10-03T03:05:00.000Z', {
    type: 'change.field_affirmed',
    actor: human(b),
    scope: { changeId: 'chg_A' },
    meta: { changeId: 'chg_A', field: 'mitigation', edited: true, editRatio: 0.4, dwellMs: 30_000 },
    payload: { value: `${SECRET}MITIGATION` },
    source: 'api',
  });
  append(t, '2026-10-03T03:10:00.000Z', {
    type: 'decision.requested',
    actor: human(b),
    scope: { decisionId: 'dec_chg', changeId: 'chg_A' },
    meta: {
      decisionId: 'dec_chg',
      kind: 'change_request',
      test: 'main',
      requiredRole: 'approver',
      requiresPasskey: false,
      subjectType: 'change',
      subjectId: 'chg_A',
      sessionId: null,
      projectId: 'prj_1',
      optionIds: ['approve', 'reject'],
      recommendedOptionId: 'approve',
      requesterId: b,
      excludedApproverIds: [b],
      eligibleUserIds: null,
      dueAt: null,
    },
    payload: {
      title: `${SECRET}CHANGE-GATE`,
      question: 'Approve?',
      options: [{ id: 'approve', label: 'Approve' }],
    },
    source: 'api',
  });
  append(t, '2026-10-03T03:20:00.000Z', {
    type: 'change.submitted',
    actor: human(b),
    scope: { changeId: 'chg_A' },
    meta: {
      changeId: 'chg_A',
      scope: 'main',
      selfApprovable: false,
      decisionId: 'dec_chg',
      rollbackSha: 'abc1234',
    },
    source: 'api',
  });
  append(t, '2026-10-03T04:00:00.000Z', {
    type: 'decision.resolved',
    actor: human(a),
    scope: { decisionId: 'dec_chg' },
    meta: {
      decisionId: 'dec_chg',
      kind: 'change_request',
      optionId: 'approve',
      resolvedBy: a,
      method: 'button',
      passkeyVerified: false,
      selfApproved: false,
      ageMs: 3_000_000,
    },
    payload: { comment: `${SECRET}COMMENT-0b9e` },
    source: 'api',
  });
  append(t, '2026-10-03T04:01:00.000Z', {
    type: 'change.approved',
    actor: human(a),
    scope: { changeId: 'chg_A' },
    meta: { changeId: 'chg_A', decisionId: 'dec_chg', approverId: a, selfApproved: false },
    source: 'api',
  });
  const anchorDuring = anchorHead(t, '2026-10-03T05:00:00.000Z', 'anc_during');
  append(t, '2026-10-03T06:00:00.000Z', {
    type: 'fx.rate_recorded',
    actor: { kind: 'system', id: 'scheduler:fx' },
    meta: {
      date: '2026-10-03',
      pair: 'USD/MYR',
      rate: 4.2,
      status: 'live',
      sourceDate: '2026-10-03',
      extractor: 'haiku',
      validation: 'pass',
      reason: 'fetched',
    },
    payload: { rawExcerpt: `${SECRET}FX-RAW` },
    source: 'scheduler',
  });
  append(t, '2026-10-03T07:00:00.000Z', {
    type: 'intake.submitted',
    actor: human(requester.user.id),
    scope: { ticketId: 'tkt_1' },
    meta: {
      ticketId: 'tkt_1',
      requesterId: requester.user.id,
      severity: 'high',
      attachmentCount: 1,
      attachmentHashes: [sha256('png')],
    },
    payload: {
      title: `${SECRET}INTAKE-TITLE`,
      description: `${SECRET}INTAKE-alice@example.com cannot log in`,
    },
    source: 'intake',
  });
  append(t, '2026-10-03T07:01:00.000Z', {
    type: 'intake.attachment_stored',
    actor: human(requester.user.id),
    scope: { ticketId: 'tkt_1' },
    meta: {
      ticketId: 'tkt_1',
      attachmentId: 'att_1',
      sha256: sha256('png'),
      mime: 'image/png',
      bytes: 1024,
      scan: 'clean',
      scanner: 'builtin',
    },
    payload: { fileName: `${SECRET}FILE-passport.png` },
    source: 'intake',
  });
  append(t, '2026-10-03T07:30:00.000Z', {
    type: 'ticket.public_status_changed',
    actor: { kind: 'system', id: 'intake' },
    scope: { ticketId: 'tkt_1' },
    meta: { ticketId: 'tkt_1', publicStatus: 'being_worked_on' },
    source: 'system',
  });
  append(t, '2026-10-03T16:15:00.000Z', {
    type: 'rollup.closed',
    actor: { kind: 'system', id: 'scheduler:metering' },
    meta: {
      date: '2026-10-03',
      usdNotional: 1.5,
      rmNotional: 6.3,
      fxRate: 4.2,
      fxStatus: 'live',
      rateCardVersion: 1,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      throttleIdleMs: 0,
      closedAt: '2026-10-03T16:15:00.000Z',
    },
    payload: { byActor: [], byProject: [], byModel: [] },
    source: 'scheduler',
  });
  append(t, '2026-10-04T01:00:00.000Z', {
    type: 'fx.rate_recorded',
    actor: { kind: 'system', id: 'scheduler:fx' },
    meta: {
      date: '2026-10-04',
      pair: 'USD/MYR',
      rate: 4.2,
      status: 'inherited',
      sourceDate: '2026-10-03',
      extractor: 'none',
      validation: 'not_applicable',
      reason: 'weekend_or_holiday',
    },
    payload: {},
    source: 'scheduler',
  });
  append(t, '2026-10-04T01:05:00.000Z', {
    type: 'fx.carry_forward_alert',
    actor: { kind: 'system', id: 'scheduler:fx' },
    meta: { consecutiveDays: 1, since: '2026-10-04' },
    source: 'scheduler',
  });
  append(t, '2026-10-04T02:00:00.000Z', {
    type: 'ratecard.published',
    actor: human(a),
    meta: { version: 2, effectiveFrom: '2026-10-05', rateCount: 1 },
    payload: {
      rates: [
        {
          model: 'claude-opus-5-5',
          inputPerMTok: 4,
          outputPerMTok: 20,
          cacheReadPerMTok: 0.2,
          cacheWrite5mPerMTok: 5,
          cacheWrite1hPerMTok: 8,
        },
      ],
      note: `${SECRET}RATE-NOTE`,
    },
    source: 'api',
  });
  append(t, '2026-10-04T03:00:00.000Z', {
    type: 'decision.resolved',
    actor: human(a),
    scope: { decisionId: 'dec_golive' },
    meta: {
      decisionId: 'dec_golive',
      kind: 'go_live',
      optionId: 'approve',
      resolvedBy: a,
      method: 'passkey',
      passkeyVerified: true,
      selfApproved: false,
      ageMs: 162_000_000,
    },
    payload: { comment: `${SECRET}COMMENT-golive` },
    source: 'api',
  });
  append(t, '2026-10-04T03:05:00.000Z', {
    type: 'promotion.completed',
    actor: { kind: 'system', id: 'supervisor' },
    meta: {
      promotionId: 'prm_1',
      mainShaBefore: 'aaa1111',
      mainShaAfter: 'abc1234',
      breakglass: false,
      decisionId: 'dec_golive',
    },
    source: 'supervisor',
  });
  append(t, '2026-10-04T04:00:00.000Z', {
    type: 'rollback.requested',
    actor: human(b),
    meta: {
      rollbackId: 'rbk_1',
      projectId: 'prj_1',
      targetRef: 'phase-1',
      targetSha: 'abc1234',
      changeId: null,
    },
    payload: { reason: `${SECRET}ROLLBACK-REASON` },
    source: 'api',
  });
  append(t, '2026-10-04T04:30:00.000Z', {
    type: 'rollback.verified',
    actor: { kind: 'system', id: 'supervisor' },
    meta: {
      rollbackId: 'rbk_1',
      branch: 'rollback/rbk_1',
      testsPassed: 12,
      testsFailed: 0,
      clean: true,
      decisionId: 'dec_rbk',
    },
    payload: { report: `${SECRET}ROLLBACK-REPORT` },
    source: 'supervisor',
  });
  append(t, '2026-10-04T05:00:00.000Z', {
    type: 'rollback.approved',
    actor: human(a),
    meta: { rollbackId: 'rbk_1', decisionId: 'dec_rbk', approverId: a, passkeyVerified: true },
    source: 'api',
  });
  append(t, '2026-10-04T05:10:00.000Z', {
    type: 'rollback.executed',
    actor: { kind: 'system', id: 'supervisor' },
    meta: { rollbackId: 'rbk_1', mainShaBefore: 'abc1234', mainShaAfter: 'def5678' },
    source: 'supervisor',
  });
  append(t, '2026-10-04T06:00:00.000Z', {
    type: 'breakglass.invoked',
    actor: human(b),
    meta: {
      breakglassId: 'brk_1',
      projectId: 'prj_1',
      invokedBy: b,
      ref: 'hotfix',
      sha: 'fff0000',
      decisionId: 'dec_brk',
    },
    payload: { justification: `${SECRET}BREAKGLASS-WHY` },
    source: 'api',
  });
  append(t, '2026-10-04T06:10:00.000Z', {
    type: 'breakglass.approved',
    actor: human(a),
    meta: {
      breakglassId: 'brk_1',
      decisionId: 'dec_brk',
      approverId: a,
      passkeyVerified: true,
      postIncidentChangeId: 'chg_PI',
      dueAt: '2026-10-05T06:10:00.000Z',
    },
    source: 'api',
  });
  append(t, '2026-10-04T07:00:00.000Z', {
    type: 'credit.auto_granted',
    actor: { kind: 'system', id: 'credits' },
    meta: {
      userId: b,
      period: '2026-10',
      amountUsd: 75,
      balanceBefore: 0,
      balanceAfter: 75,
      sessionId: 'ses_1',
      taskId: null,
    },
    source: 'system',
  });
  append(t, '2026-10-04T08:00:00.000Z', {
    type: 'credit.topup_requested',
    actor: human(b),
    meta: {
      requestId: 'tpu_1',
      userId: b,
      period: '2026-10',
      amountUsd: 100,
      sessionId: null,
      taskId: null,
      decisionId: 'dec_tpu',
    },
    payload: { reason: `${SECRET}TOPUP-REASON` },
    source: 'api',
  });
  append(t, '2026-10-04T09:00:00.000Z', {
    type: 'credit.topup_granted',
    actor: human(a),
    meta: {
      requestId: 'tpu_1',
      userId: b,
      amountUsd: 100,
      approverId: a,
      balanceBefore: 0,
      balanceAfter: 100,
      decisionId: 'dec_tpu',
    },
    source: 'api',
  });
  append(t, '2026-10-05T02:00:00.000Z', {
    type: 'ratecard.published',
    actor: human(a),
    meta: { version: 3, effectiveFrom: '2026-10-06', rateCount: 1 },
    payload: {
      rates: [
        {
          model: 'claude-opus-5-5',
          inputPerMTok: 5,
          outputPerMTok: 25,
          cacheReadPerMTok: 0.5,
          cacheWrite5mPerMTok: 6.25,
          cacheWrite1hPerMTok: 10,
        },
      ],
    },
    source: 'api',
  });
  const atEnd = append(t, '2026-10-05T15:59:59.999Z', nudge('ses_1', `${SECRET}NUDGE-last`)).id;

  // ── after the range ────────────────────────────────────────────────────────
  const afterEnd = append(t, RANGE_END_EXCL, nudge('ses_1', `${SECRET}NUDGE-after`)).id;
  append(t, '2026-10-06T01:00:00.000Z', {
    type: 'change.completed',
    actor: { kind: 'system', id: 'change' },
    meta: { changeId: 'chg_PI', pinnedSha: 'fff0000', pinnedTag: 'post-incident-1' },
    source: 'system',
  });
  const anchorAfter = anchorHead(t, '2026-10-06T18:00:00.000Z', 'anc_after');
  append(t, '2026-10-07T01:00:00.000Z', nudge('ses_2', `${SECRET}NUDGE-tail`));
  t.clock.set(NOW);
  return {
    builder,
    approver,
    requester,
    boundary: { beforeStart, atStart, atEnd, afterEnd },
    anchors: { before: anchorBefore, during: anchorDuring, after: anchorAfter },
    goLiveRequest,
  };
}
