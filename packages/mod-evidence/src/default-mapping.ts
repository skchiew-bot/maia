import type { MappingFile } from './mapping';

/**
 * Built-in default ISO/IEC 42001:2023 mapping. Used when config/iso42001-mapping.json is absent or invalid.
 * Clause numbers follow the AOC-SPEC-003 §13 corrections; every row stays provisional until the compliance
 * lead stamps the mapping hash (R3). Event types must exist in the contracts catalog (validated on load).
 */
export const BUILTIN_MAPPING: MappingFile = {
  version: 'builtin-2026.10.1',
  standard: 'ISO/IEC 42001:2023',
  status: 'provisional',
  stampedBy: null,
  stampedAt: null,
  notes:
    'Built-in default shipped with mod-evidence. Applies the AOC-SPEC-003 §13 corrections to the AOC-SPEC-002 table ' +
    '(event logging A.6.2.8, technical documentation A.6.2.7, roles A.3.2, incident communication A.8.4, resource use A.4). ' +
    'PROVISIONAL: the compliance lead must confirm every row against ISO/IEC 42001:2023 before it is cited (R3).',
  rows: [
    {
      id: 'aoc.event-log',
      aocControl: 'Event logging',
      aocFeature:
        'Append-only, hash-chained event log with a single writer; only payload hashes are chained; nightly off-host anchor; Verify tests the chain against every anchor',
      clause: 'A.6.2.8',
      clauseTitle: 'AI system recording of event logs',
      evidence: [
        'Whole-chain hash verification (verification.json)',
        'Off-host anchors of the chain head (signed git commit or RFC 3161 timestamp)',
        'Verify runs recomputing the chain against every anchor',
        'Crypto-shred erasures that leave the chain valid',
      ],
      eventTypes: ['anchor.created', 'anchor.failed', 'chain.verified', 'body.erased'],
      status: 'provisional',
      correctionNote:
        'AOC-SPEC-002 cited A.6.2.6 for event logging; A.6.2.6 is operation and monitoring. Recording of event logs is A.6.2.8 (§13).',
    },
    {
      id: 'aoc.technical-documentation',
      aocControl: 'Technical documentation',
      aocFeature:
        'Fixed process-type registry (model, permissions and credential profile per type, hash-tracked) and approved playbooks',
      clause: 'A.6.2.7',
      clauseTitle: 'AI system technical documentation',
      evidence: [
        'Registry versions, audited when the file changes',
        'Playbooks proposed, approved, rejected and retired',
      ],
      eventTypes: [
        'registry.changed',
        'playbook.proposed',
        'playbook.approved',
        'playbook.rejected',
        'playbook.retired',
      ],
      status: 'provisional',
      correctionNote:
        'AOC-SPEC-002 cited A.6.2.7 for change management; A.6.2.7 is AI system technical documentation. Change management is clause 6.3 / 8.1 (§13).',
    },
    {
      id: 'aoc.roles',
      aocControl: 'Roles, identity and separation of duties',
      aocFeature:
        'Three-role model (Approver, Builder, Requester) on per-person identity; per-decision passkeys; repeat or escalated requests never route back to the requester',
      clause: 'A.3.2',
      clauseTitle: 'AI roles and responsibilities',
      evidence: [
        'Users created with a role; role and flag changes',
        'Tokens issued and revoked; passkeys registered and removed',
        'Decision escalations to a role',
      ],
      eventTypes: [
        'user.created',
        'user.updated',
        'token.issued',
        'token.revoked',
        'passkey.registered',
        'passkey.removed',
        'decision.escalated',
      ],
      status: 'provisional',
      correctionNote:
        'AOC-SPEC-002 cited A.5 for roles; A.5 is assessing impacts of AI systems. Roles and responsibilities are A.3.2 (§13).',
    },
    {
      id: 'aoc.incident-communication',
      aocControl: 'Break-glass incident path',
      aocFeature:
        'Emergency promotion while production is down: the most heavily audited event, routed straight to the Approver with a passkey, auto-raising a post-incident change record due within 24h',
      clause: 'A.8.4',
      clauseTitle: 'Communication of incidents',
      evidence: [
        'Break-glass invocations and passkey approvals',
        'Mandatory post-incident change records and overdue alerts (breakglass.json)',
      ],
      eventTypes: ['breakglass.invoked', 'breakglass.approved', 'breakglass.post_incident_overdue'],
      status: 'provisional',
      correctionNote:
        'AOC-SPEC-002 cited A.8.3 for incident communication; A.8.3 is external reporting. Communication of incidents is A.8.4 (§13).',
    },
    {
      id: 'aoc.resources',
      aocControl: 'Token and resource metering',
      aocFeature:
        'Per actor, task, project and model token metering with notional API-equivalent cost; frozen daily USD/RM rollups; plan-limit throttle idle time; credit caps and grants',
      clause: 'A.4.5',
      clauseTitle: 'System and computing resources',
      relatedClauses: ['A.4.2'],
      evidence: [
        'Token usage batches per session and model',
        'Daily rollups frozen with the rate-card version and FX status used',
        'Throttle hits and idle time',
        'Credit allocations, cap hits, auto-grants and human top-ups (credits.json)',
      ],
      eventTypes: [
        'usage.recorded',
        'rollup.closed',
        'throttle.hit',
        'throttle.cleared',
        'ratecard.published',
        'subscription.updated',
        'credit.allocated',
        'credit.cap_reached',
        'credit.auto_granted',
        'credit.topup_requested',
        'credit.topup_granted',
        'credit.topup_denied',
      ],
      status: 'provisional',
      correctionNote:
        'AOC-SPEC-002 cited A.7 for token and resource use; A.7 is data for AI systems. Resources are A.4 (§13).',
    },
    {
      id: 'aoc.change-management',
      aocControl: 'Change control',
      aocFeature:
        'Every post-MVP change is a change request with impact analysis, mitigation plan, rollback plan (exact commit or tag) and acceptance test; the developer edits or affirms each AI-drafted field; scope-routed approval; completion pins an immutable tag',
      clause: '6.3',
      clauseTitle: 'Planning of changes',
      relatedClauses: ['8.1'],
      evidence: [
        'Change requests drafted, affirmed field by field, submitted, approved or rejected',
        'Change work started and completed with pinned refs (changes.json)',
      ],
      eventTypes: [
        'change.drafted',
        'change.field_affirmed',
        'change.submitted',
        'change.approved',
        'change.rejected',
        'change.started',
        'change.completed',
        'git.ref_pinned',
      ],
      status: 'provisional',
      correctionNote: 'Change management is clause 6.3 with operational control in 8.1, not A.6.2.7 (§13).',
    },
    {
      id: 'aoc.impact-assessment',
      aocControl: 'Change impact analysis',
      aocFeature:
        'Mandatory impact analysis on every change request, AI-drafted and human-affirmed; blind affirm-without-edit is tracked',
      clause: 'A.5.2',
      clauseTitle: 'AI system impact assessment process',
      relatedClauses: ['6.1.4', '8.4'],
      evidence: [
        'Change requests carrying an impact analysis',
        'Impact field edited or affirmed by the developer',
      ],
      eventTypes: ['change.drafted', 'change.field_affirmed'],
      metaFilters: { 'change.field_affirmed': { field: ['impact'] } },
      status: 'provisional',
      correctionNote:
        'Impact assessment is A.5 (with 6.1.4 and 8.4). Confirm whether change-level impact analysis satisfies the A.5.2 process or only feeds it.',
    },
    {
      id: 'aoc.monitoring',
      aocControl: 'Liveness and operation monitoring',
      aocFeature:
        'Liveness state changes derived from instrumented events (never raw heartbeats), lifecycle changes, guard blocks, drift marks and operator interventions (nudge, restart, stop)',
      clause: 'A.6.2.6',
      clauseTitle: 'AI system operation and monitoring',
      evidence: [
        'Liveness and lifecycle state changes per session',
        'Blocked sessions and detected drift',
        'Operator nudges, restarts and stop requests',
      ],
      eventTypes: [
        'session.liveness_changed',
        'session.lifecycle_changed',
        'session.blocked',
        'drift.detected',
        'session.nudged',
        'session.restarted',
        'session.stop_requested',
      ],
      status: 'provisional',
      correctionNote:
        'A.6.2.6 covers operation and monitoring; it is not the event-logging control (A.6.2.8, §13).',
    },
    {
      id: 'aoc.verification-validation',
      aocControl: 'Verification and validation',
      aocFeature:
        'Task completion requires evidence (test id, commit or diff); rollbacks are verified by running the target state’s acceptance tests; requesters sign off on UAT',
      clause: 'A.6.2.4',
      clauseTitle: 'AI system verification and validation',
      evidence: [
        'Tasks closed with evidence',
        'Rollback verification results',
        'UAT pass/fail by the requester',
      ],
      eventTypes: ['task.done', 'rollback.verified', 'ticket.uat_result'],
      status: 'provisional',
    },
    {
      id: 'aoc.deployment',
      aocControl: 'Gated deployment and provenance',
      aocFeature:
        'Promotion to main only through a passkey go-live gate with provenance (every commit traces to an approved change, a UAT sign-off and a gate); break-glass is the sole exception',
      clause: 'A.6.2.5',
      clauseTitle: 'AI system deployment',
      evidence: [
        'Promotions requested, refused (provenance gaps) and completed',
        'Go-live decisions resolved (gates.json)',
      ],
      eventTypes: ['promotion.requested', 'promotion.refused', 'promotion.completed', 'decision.resolved'],
      metaFilters: { 'decision.resolved': { kind: ['go_live'] } },
      status: 'provisional',
    },
    {
      id: 'aoc.rollback',
      aocControl: 'Gated rollback',
      aocFeature:
        'Rollback is a human-required, passkey-approved decision executed only after the target tag is verified clean on a new branch',
      clause: '8.1',
      clauseTitle: 'Operational planning and control',
      relatedClauses: ['A.6.2.5'],
      evidence: ['Rollbacks requested, verified, approved or rejected, and executed (rollbacks.json)'],
      eventTypes: [
        'rollback.requested',
        'rollback.verification_started',
        'rollback.verified',
        'rollback.approved',
        'rollback.rejected',
        'rollback.executed',
      ],
      status: 'provisional',
    },
    {
      id: 'aoc.information-for-users',
      aocControl: 'Requester status information',
      aocFeature:
        'Requesters see abstracted status only (received, being worked on, ready for your testing, completed), never gate names, approver identity, queue depth or timelines',
      clause: 'A.8.2',
      clauseTitle: 'System documentation and information for users',
      evidence: ['Public ticket status changes', 'UAT-ready notices to the requester'],
      eventTypes: ['ticket.public_status_changed', 'ticket.uat_ready'],
      status: 'provisional',
    },
    {
      id: 'aoc.external-reporting',
      aocControl: 'End-user intake portal',
      aocFeature:
        'Requesters report problems (description, video, image, severity) through the intake portal; low-confidence diagnoses and triage disagreements bounce to a human',
      clause: 'A.8.3',
      clauseTitle: 'External reporting',
      evidence: ['Intakes filed by requesters', 'Triage, human escalation and ticket closure'],
      eventTypes: ['intake.submitted', 'ticket.triage_started', 'ticket.escalated_to_human', 'ticket.closed'],
      status: 'provisional',
      correctionNote: 'A.8.3 is external reporting; communication of incidents is A.8.4 (§13).',
    },
    {
      id: 'aoc.data',
      aocControl: 'Intake data handling',
      aocFeature:
        'Uploads size- and type-checked, malware-scanned and encrypted in the body store with only SHA-256 hashes chained; crypto-shred erasure (PDPA)',
      clause: 'A.7.5',
      clauseTitle: 'Data provenance',
      relatedClauses: ['A.7.4'],
      evidence: ['Attachment hashes, type, size and scan result', 'Body-store erasures'],
      eventTypes: ['intake.attachment_stored', 'intake.submitted', 'body.erased'],
      status: 'provisional',
      correctionNote:
        'Data handling is A.7 (data for AI systems); token and resource use is A.4, not A.7 (§13).',
    },
    {
      id: 'aoc.fx-data-quality',
      aocControl: 'FX data quality',
      aocFeature:
        'Daily BNM rate extraction is sanity-bounded and self-validated, carried forward (flagged) on failure; confirmed mismatches raise a human-reviewed discrepancy decision',
      clause: 'A.7.4',
      clauseTitle: 'Quality of data for AI systems',
      evidence: [
        'Daily rates stamped live or inherited (fx.json)',
        'Discrepancies raised and resolved; carry-forward alerts',
      ],
      eventTypes: [
        'fx.rate_recorded',
        'fx.discrepancy_raised',
        'fx.discrepancy_resolved',
        'fx.carry_forward_alert',
      ],
      status: 'provisional',
    },
    {
      id: 'aoc.suppliers',
      aocControl: 'AI model supplier governance',
      aocFeature:
        'The model is fixed at launch from the registry (agents cannot choose their own); supplier subscription and list prices recorded',
      clause: 'A.10.3',
      clauseTitle: 'Suppliers',
      evidence: ['Model per session launch', 'Registry changes', 'Subscription and rate-card versions'],
      eventTypes: [
        'session.launch_requested',
        'registry.changed',
        'subscription.updated',
        'ratecard.published',
      ],
      status: 'provisional',
    },
    {
      id: 'aoc.corrective-action',
      aocControl: 'Repeat-offence detection and lessons',
      aocFeature:
        'Root-cause classes (never per-person blame); repeat offences tracked from detected to verified closed; distilled lessons bound only by a human decision and retired when unused',
      clause: '10.2',
      clauseTitle: 'Nonconformity and corrective action',
      relatedClauses: ['10.1'],
      evidence: [
        'Errors attributed to root-cause classes',
        'Offence lifecycle transitions',
        'Lessons proposed, bound, applied and retired',
      ],
      eventTypes: [
        'error.observed',
        'rootcause.class_defined',
        'rootcause.assigned',
        'offence.transitioned',
        'lesson.proposed',
        'lesson.bound',
        'lesson.rejected',
        'lesson.applied',
        'lesson.retired',
      ],
      status: 'provisional',
    },
    {
      id: 'aoc.decision-gates',
      aocControl: 'Human-required decision gates and guardrails',
      aocFeature:
        'Protected operations (main, production, data) become decision cards; per-kind role routing, separation of duties and passkeys for go-live, rollback and break-glass; self-modification boundary',
      clause: 'A.9.2',
      clauseTitle: 'Processes for responsible use of AI systems',
      evidence: [
        'Decisions requested, resolved, withdrawn and escalated (gates.json)',
        'Tool calls denied by guards',
        'Blocked self-modification attempts',
      ],
      eventTypes: [
        'decision.requested',
        'decision.resolved',
        'decision.withdrawn',
        'decision.escalated',
        'tool.denied',
        'selfmod.blocked',
      ],
      status: 'provisional',
    },
    {
      id: 'aoc.design-documentation',
      aocControl: 'Plan manifest and master timeline',
      aocFeature:
        'A plan manifest is declared at session start (sessions without one are blocked); amendments are audited; phase completion pins a git tag; handoff briefs at rollover',
      clause: 'A.6.2.3',
      clauseTitle: 'Documentation of AI system design and development',
      evidence: [
        'Plans declared and amended',
        'Phases completed with pinned refs',
        'Enhancements and rollover handoffs',
      ],
      eventTypes: [
        'plan.declared',
        'plan.amended',
        'phase.completed',
        'enhancement.recorded',
        'session.rollover_started',
        'session.rollover_completed',
      ],
      status: 'provisional',
    },
    {
      id: 'aoc.documented-information',
      aocControl: 'Compliance mapping and evidence packs',
      aocFeature:
        'Versioned ISO 42001 mapping (provisional until stamped by the compliance lead), frozen hash-verified evidence packs, hash-tracked governed configuration',
      clause: '7.5.3',
      clauseTitle: 'Control of documented information',
      evidence: [
        'Mapping versions published and stamped',
        'Evidence packs generated and integrity failures',
        'Governed configuration changes',
      ],
      eventTypes: [
        'mapping.published',
        'mapping.stamped',
        'evidence_pack.generated',
        'evidence_pack.integrity_failed',
        'config.changed',
      ],
      status: 'provisional',
    },
  ],
};
