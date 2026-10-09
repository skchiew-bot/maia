import type { AuditEventHeaderDTO, InternalTicket, TicketDiagnosisDTO } from '@aoc/contracts';

export const NOW = Date.parse('2026-10-09T12:00:00.000Z');
export const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

export function diagnosis(sessionId: string, over: Partial<TicketDiagnosisDTO> = {}): TicketDiagnosisDTO {
  return {
    sessionId,
    status: 'reported',
    confidence: 0.82,
    rootCauseClass: 'unit-mismatch',
    rootCause: 'The session-expiry check compares a seconds timestamp with Date.now() milliseconds.',
    fixPlan: 'Normalise both values to milliseconds in auth/session.ts and add a regression test.',
    tokens: 10_951,
    reportedAt: iso(NOW - 34 * MIN),
    ...over,
  };
}

/** Shaped exactly like `GET /api/tickets` (InternalTicket). */
export function ticket(over: Partial<InternalTicket> & { ticketId: string }): InternalTicket {
  return {
    projectId: 'prj_cxcopilot',
    requesterId: 'usr_daniel',
    requesterName: 'Daniel Lim',
    title: 'Agent desktop logs me out right after login',
    description: 'Since this morning the agent desktop signs me out within a few seconds of logging in.',
    comment: 'Started after the 09:00 release.',
    severity: 'high',
    stage: 'fix_plan_gate',
    publicStatus: 'being_worked_on',
    submittedAt: iso(NOW - 40 * MIN),
    updatedAt: iso(NOW - 35 * MIN),
    attachments: [],
    diagnoses: [diagnosis('ses_tri_a'), diagnosis('ses_tri_b')],
    buildSessionId: null,
    uatRef: null,
    openDecisionIds: ['dec_fix'],
    resolution: null,
    ...over,
  };
}

export function ticketList(): InternalTicket[] {
  return [
    ticket({ ticketId: 'tkt_01M4FC3GS5VXC370PY64VM0XE8' }),
    ticket({
      ticketId: 'tkt_01M4FC4Z5R3DH27RWWMNACGQ0J',
      title: 'Duplicate claims created when the submit button is double-clicked',
      severity: 'critical',
      projectId: 'prj_claims',
      stage: 'uat',
      publicStatus: 'ready_for_testing',
      buildSessionId: 'ses_build',
      uatRef: 'uat/tkt_01M4FC4Z5R3DH27RWWMNACGQ0J',
      openDecisionIds: [],
      updatedAt: iso(NOW - 20 * MIN),
    }),
    ticket({
      ticketId: 'tkt_01M4FC4Y919TG4RT1229ATHF09',
      title: 'Claim photos upload twice on slow connections',
      severity: 'medium',
      requesterName: 'Nur Hidayah',
      stage: 'awaiting_human',
      diagnoses: [
        diagnosis('ses_low_a', { confidence: 0.35, rootCauseClass: 'unknown' }),
        diagnosis('ses_low_b', { confidence: 0.35, rootCauseClass: 'unknown' }),
      ],
      openDecisionIds: ['dec_low'],
      updatedAt: iso(NOW - 30 * MIN),
    }),
    ticket({
      ticketId: 'tkt_01M4FC4YCH6VWQK3H7CWQAZGFX',
      title: 'Export to PDF button does nothing',
      severity: 'low',
      stage: 'closed',
      publicStatus: 'closed',
      diagnoses: [
        diagnosis('ses_np_a', {
          status: 'stopped',
          confidence: null,
          rootCauseClass: null,
          rootCause: null,
          fixPlan: null,
        }),
      ],
      openDecisionIds: [],
      resolution: 'cannot_reproduce',
    }),
  ];
}

let seq = 100;
export function event(
  type: string,
  ts: number,
  meta: Record<string, unknown>,
  scope: Record<string, string> = {},
): AuditEventHeaderDTO {
  seq += 1;
  return {
    seq,
    id: `evt_${seq}`,
    ts: iso(ts),
    type,
    actor: { kind: 'system', id: 'intake' },
    scope: { ticketId: 'tkt_01M4FC3GS5VXC370PY64VM0XE8', ...scope },
    meta: meta as AuditEventHeaderDTO['meta'],
    source: 'intake',
    hasBody: false,
    payloadHashPrefix: null,
    hash: 'h',
    prevHash: 'p',
  };
}

/** A ticket's own history, as `/api/audit/events?ticketId=…` returns it. */
export function history(): AuditEventHeaderDTO[] {
  const t = 'tkt_01M4FC3GS5VXC370PY64VM0XE8';
  return [
    event('intake.submitted', NOW - 40 * MIN, {
      ticketId: t,
      requesterId: 'usr_daniel',
      severity: 'high',
      attachmentCount: 0,
      attachmentHashes: [],
    }),
    event('session.launch_requested', NOW - 40 * MIN, { sessionId: 'ses_tri_a' }),
    event('ticket.triage_started', NOW - 40 * MIN, {
      ticketId: t,
      sessionIds: ['ses_tri_a', 'ses_tri_b'],
      budgetTokens: 400_000,
      budgetMinutes: 30,
    }),
    event('ticket.diagnosis_reported', NOW - 35 * MIN, {
      ticketId: t,
      sessionId: 'ses_tri_a',
      confidence: 0.82,
      rootCauseClass: 'unit-mismatch',
    }),
    event('decision.requested', NOW - 35 * MIN, { decisionId: 'dec_fix', kind: 'fix_plan' }),
    event('ticket.fix_plan_submitted', NOW - 35 * MIN, {
      ticketId: t,
      decisionId: 'dec_fix',
      sourceSessionId: 'ses_tri_a',
    }),
  ];
}
