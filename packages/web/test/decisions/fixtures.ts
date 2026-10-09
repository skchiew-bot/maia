import type { DecisionCardView } from '@aoc/contracts';

/** Fixed "now" for every decisions test: Fri 9 Oct 2026, 12:00 UTC. */
export const NOW = Date.parse('2026-10-09T12:00:00.000Z');
export const MIN = 60_000;
export const HOUR = 60 * MIN;

export const CEO = { id: 'usr_ceo', name: 'Chiew Sin Kwang', role: 'approver' as const, flags: {} };
export const AISYAH = { id: 'usr_aisyah', name: 'Aisyah Rahman', role: 'builder' as const, flags: {} };
export const WEIJIE_ID = 'usr_weijie';

const iso = (ms: number) => new Date(ms).toISOString();

/** A decision card shaped exactly like `GET /api/decisions` returns it (DecisionCardView). */
export function card(over: Partial<DecisionCardView> & { id: string }): DecisionCardView {
  const createdAt = over.createdAt ?? iso(NOW - 20 * MIN);
  const base: DecisionCardView = {
    id: over.id,
    kind: 'agent_decision',
    status: 'open',
    test: 'main',
    title: 'Merge the retry-dedupe fix to main?',
    question: 'The fix is ready on fix/claims-dedupe. Merge to main now or hold for UAT?',
    options: [
      { id: 'merge', label: 'Merge to main' },
      { id: 'uat', label: 'Hold for UAT first' },
    ],
    recommendation: { optionId: 'uat', rationale: 'Blast radius is lower behind UAT.' },
    context: '3 files changed, regression test passing.',
    requiredRole: 'approver',
    requiresPasskey: false,
    requesterId: 'session:ses_01M4F96VD3NYBS33ZTK8K67GHD',
    excludedApproverIds: ['session:ses_01M4F96VD3NYBS33ZTK8K67GHD'],
    eligibleUserIds: null,
    subjectType: 'session',
    subjectId: 'ses_01M4F96VD3NYBS33ZTK8K67GHD',
    sessionId: 'ses_01M4F96VD3NYBS33ZTK8K67GHD',
    projectId: 'prj_claims',
    createdAt,
    dueAt: null,
    resolution: null,
    ageMs: NOW - Date.parse(createdAt),
    overdue: false,
    closedAt: null,
    erased: false,
    escalation: null,
    withdrawal: null,
    viewer: { canResolve: true, reason: null, canWithdraw: true, canEscalate: false },
  };
  return { ...base, ...over, ageMs: over.ageMs ?? NOW - Date.parse(createdAt) };
}

export function resolved(
  c: DecisionCardView,
  by: string,
  method: 'button' | 'passkey',
  optionId: string,
  ageMs: number,
): DecisionCardView {
  const resolvedAt = iso(Date.parse(c.createdAt) + ageMs);
  return {
    ...c,
    status: 'resolved',
    ageMs,
    closedAt: resolvedAt,
    resolution: {
      optionId,
      resolvedBy: by,
      resolvedAt,
      method,
      passkeyVerified: method === 'passkey',
      selfApproved: false,
      comment: null,
    },
    viewer: { canResolve: false, reason: 'not_open', canWithdraw: false, canEscalate: false },
  };
}

/** The open queue used by the page tests: an over-SLA top-up, an agent decision, a passkey break-glass, and the CEO's own request. */
export function openQueue(): DecisionCardView[] {
  return [
    card({ id: 'dec_agent', createdAt: iso(NOW - 50 * MIN) }),
    card({
      id: 'dec_topup',
      kind: 'credit_topup',
      test: null,
      title: 'Top-up request: Tan Wei Jie (+US$100)',
      question: 'Approve a US$100 top-up for the CSAT overlay work?',
      options: [
        { id: 'approve', label: 'Approve US$100' },
        { id: 'deny', label: 'Deny' },
      ],
      recommendation: null,
      context: null,
      requesterId: WEIJIE_ID,
      excludedApproverIds: [WEIJIE_ID],
      subjectType: 'credit_request',
      subjectId: 'tpu_demo1',
      sessionId: null,
      projectId: null,
      createdAt: iso(NOW - 3 * HOUR),
    }),
    card({
      id: 'dec_bg',
      kind: 'break_glass',
      test: null,
      title: 'BREAK-GLASS: emergency promotion of hotfix/duplicate-claims in prj_claims',
      question: 'Production is down. Promote 1a079a3 to main, bypassing provenance?',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      recommendation: null,
      requiresPasskey: true,
      requesterId: WEIJIE_ID,
      excludedApproverIds: [WEIJIE_ID],
      subjectType: 'breakglass',
      subjectId: 'brk_01M4FDEK2MBFQXWJG2ZQSZ8062',
      sessionId: null,
      createdAt: iso(NOW - 5 * MIN),
    }),
    card({
      id: 'dec_own',
      kind: 'break_glass',
      test: null,
      title: 'BREAK-GLASS: emergency promotion of main in prj_cxcopilot',
      question: 'Production is down. Re-promote the last known good main?',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      recommendation: null,
      requiresPasskey: true,
      requesterId: CEO.id,
      excludedApproverIds: [CEO.id],
      subjectType: 'breakglass',
      subjectId: 'brk_01M4FDEK64MQFCRSSJFYKZN612',
      sessionId: null,
      projectId: 'prj_cxcopilot',
      createdAt: iso(NOW - 4 * MIN),
      viewer: { canResolve: false, reason: 'separation_of_duties', canWithdraw: true, canEscalate: false },
    }),
  ];
}

export function closedHistory(): DecisionCardView[] {
  const a = card({ id: 'dec_old1', createdAt: iso(NOW - 2 * 24 * HOUR) });
  const b = card({ id: 'dec_old2', createdAt: iso(NOW - 3 * 24 * HOUR) });
  const g = card({
    id: 'dec_golive',
    kind: 'go_live',
    test: null,
    title: 'Promote CX Copilot v1.4.0 to production?',
    requiresPasskey: true,
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ],
    recommendation: null,
    createdAt: iso(NOW - 5 * HOUR),
  });
  return [
    resolved(a, AISYAH.id, 'button', 'uat', 25 * MIN),
    resolved(b, CEO.id, 'button', 'merge', 90 * MIN),
    resolved(g, CEO.id, 'passkey', 'approve', 38 * MIN),
  ];
}
