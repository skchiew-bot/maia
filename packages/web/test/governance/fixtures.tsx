/**
 * Shared fixtures for the governance pages (changes, rollbacks, audit, compliance): the demo team, its projects,
 * and DTO factories shaped like the daemon's responses. Values mirror the seeded demo data.
 */
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import type {
  AnchorListDTO,
  AuditEventHeaderDTO,
  AuditHealthDTO,
  BreakglassDTO,
  ChangeField,
  ChangeFieldDTO,
  ChangeRequestDTO,
  ComplianceMappingDTO,
  ComplianceMappingRowDTO,
  DecisionCardView,
  DirectoryDto,
  EvidencePackSummaryDTO,
  PinListDTO,
  ProjectSummary,
  PromotionDTO,
  RollbackDTO,
  VerifyReportDTO,
} from '@aoc/contracts';
import { AuthProvider, EventStreamProvider, type AuthUser } from '../../src/api';
import { ClockProvider, ToastProvider, fixedClock } from '../../src/components';
import { FakeEventSourceCtor, jsonResponse, mockFetch } from '../helpers';

export const NOW = Date.parse('2026-10-09T07:05:00.000Z');
export const MIN = 60_000;
export const HOUR = 3_600_000;
/** ISO time `ms` before NOW. */
export const ago = (ms: number) => new Date(NOW - ms).toISOString();
/** ISO time `ms` after NOW. */
export const ahead = (ms: number) => new Date(NOW + ms).toISOString();

export const CEO: AuthUser = {
  id: 'usr_01M3BBS3809E8859HVM0PYZMGW',
  name: 'Chiew Sin Kwang',
  role: 'approver',
  flags: {},
};
export const AISYAH: AuthUser = {
  id: 'usr_01M3BBS380QYAXTTQATY7EA382',
  name: 'Aisyah Rahman',
  role: 'builder',
  flags: {},
};
export const WEIJIE: AuthUser = {
  id: 'usr_01M3BBS3807306KBV4AFB76QKC',
  name: 'Tan Wei Jie',
  role: 'builder',
  flags: {},
};
export const PRIYA: AuthUser = {
  id: 'usr_01M3BBS38008G3Q416BPFS7V5A',
  name: 'Priya Nair',
  role: 'builder',
  flags: { complianceLead: true },
};

export const DIRECTORY: DirectoryDto = {
  people: [CEO, AISYAH, WEIJIE, PRIYA].map((u) => ({
    id: u.id,
    name: u.name,
    role: u.role === 'approver' ? 'approver' : 'builder',
    active: true,
    complianceLead: u.flags.complianceLead === true,
  })),
};

const progress = {
  doneTasks: 0,
  totalTasks: 0,
  doneWeight: 0,
  totalWeight: 0,
  pct: 0,
  flaggedTasks: 0,
  etaMs: null,
  etaHiddenReason: null,
};

export const PROJECTS: ProjectSummary[] = [
  ['prj_aoc', 'AOC Platform', 'aoc-platform'],
  ['prj_claims', 'Claims Intake Bot', 'claims-intake-bot'],
  ['prj_cxcopilot', 'CX Copilot', 'cx-copilot'],
].map(([projectId, name, slug]) => ({
  projectId: projectId!,
  name: name!,
  slug: slug!,
  repoPath: `/srv/repos/${slug}`,
  progress,
  activeSessions: 0,
  openDecisions: 0,
  lastActivityAt: null,
}));

export const SHA_A = 'c5e8cadc95f52e8a745cf83bdc414138649f7f6b';
export const SHA_B = '8cbb928d9dfee596ef86749ae5917f72544c11cb';
export const SHA_C = '53679a2c0d1e2f3a4b5c6d7e8f90123456789abc';

export function field(
  name: ChangeField,
  value: string | null,
  over: Partial<ChangeFieldDTO> = {},
  by: AuthUser = WEIJIE,
): ChangeFieldDTO {
  const affirmed = value !== null;
  return {
    field: name,
    draft: '',
    value,
    affirmed,
    edited: affirmed ? true : null,
    editRatio: affirmed ? 1 : null,
    dwellMs: affirmed ? 20_000 : null,
    blind: false,
    affirmedBy: affirmed ? by.id : null,
    affirmedAt: affirmed ? ago(3 * HOUR) : null,
    ...over,
  };
}

const FULL: Record<ChangeField, string> = {
  impact: 'Claims submission API: retries carry an idempotency key.',
  mitigation: 'Index created concurrently; duplicate-claim rate monitored for 48 h.',
  rollbackPlan: 'Revert the merge commit and drop the new index.',
  acceptanceTest: 'npm test --silent passes, including api/claims.dedupe.test.ts.',
};

export function fourFields(by: AuthUser = WEIJIE): ChangeFieldDTO[] {
  return (Object.keys(FULL) as ChangeField[]).map((f) => field(f, FULL[f], {}, by));
}

export function change(over: Partial<ChangeRequestDTO> = {}): ChangeRequestDTO {
  return {
    changeId: 'chg_01M4FDBZYA4VBEQ8CKEK7FP42E',
    projectId: 'prj_claims',
    scope: 'main',
    status: 'draft',
    title: 'Merge the retry-dedupe fix to main',
    draftedBy: 'human',
    createdBy: WEIJIE.id,
    ownerId: WEIJIE.id,
    createdAt: ago(3 * HOUR),
    sessionId: null,
    breakglassId: null,
    dueAt: null,
    overdue: false,
    fields: (Object.keys(FULL) as ChangeField[]).map((f) => field(f, null)),
    affirmedCount: 0,
    rollbackRef: null,
    rollbackSha: null,
    submittedBy: null,
    submittedAt: null,
    selfApprovable: null,
    decisionId: null,
    approval: null,
    rejection: null,
    sessions: [],
    completedAt: null,
    pinnedSha: null,
    pinnedTag: null,
    erased: false,
    ...over,
  };
}

/** The demo's change records across every stage of the pipeline. */
export function demoChanges(): ChangeRequestDTO[] {
  const submitted = (by: AuthUser, minutesAgo: number) => ({
    submittedBy: by.id,
    submittedAt: ago(minutesAgo * MIN),
  });
  return [
    change({
      changeId: 'chg_01M4FDC07HMXFE4S0WPXMJRXKA',
      scope: 'production',
      title: 'Release Claims Intake Bot v1.3 to production',
      createdBy: AISYAH.id,
      ownerId: AISYAH.id,
      fields: [
        field('impact', 'Production release of v1.3.', {}, AISYAH),
        field('mitigation', 'Canary to 10% of intake traffic for 2 hours.', {}, AISYAH),
        field('rollbackPlan', null),
        field('acceptanceTest', null),
      ],
      affirmedCount: 2,
    }),
    change({
      changeId: 'chg_01M4FDC0CVARB5BHJ5HX4BB3RC',
      projectId: 'prj_aoc',
      scope: 'production',
      status: 'submitted',
      title: 'Enable RFC 3161 timestamping for production anchors',
      createdBy: CEO.id,
      ownerId: CEO.id,
      fields: fourFields(CEO),
      affirmedCount: 4,
      rollbackRef: SHA_B,
      rollbackSha: SHA_B,
      ...submitted(CEO, 170),
      selfApprovable: false,
      decisionId: 'dec_01M4FDC0G7A075WMX4VQXXKQK8',
    }),
    change({
      changeId: 'chg_01M4FDC03285TWYF5SKPHNSW4W',
      projectId: 'prj_cxcopilot',
      scope: 'data',
      status: 'submitted',
      title: 'Partition interaction history by month',
      createdBy: PRIYA.id,
      ownerId: PRIYA.id,
      fields: fourFields(PRIYA),
      affirmedCount: 4,
      rollbackRef: SHA_C,
      rollbackSha: SHA_C,
      ...submitted(PRIYA, 30),
      selfApprovable: false,
      decisionId: 'dec_01M4FDC078KJQ7CNPHK89YA4AK',
    }),
    change({
      status: 'in_progress',
      fields: fourFields(),
      affirmedCount: 4,
      rollbackRef: SHA_A,
      rollbackSha: SHA_A,
      ...submitted(WEIJIE, 175),
      selfApprovable: false,
      decisionId: 'dec_01M4FDC0245CT00W8D9EA7YSWT',
      approval: { approverId: CEO.id, selfApproved: false, at: ago(174 * MIN) },
      sessions: [
        { sessionId: 'ses_01M4FAFKJ0HS6W702V2VZ0N2MV', startedAt: ago(170 * MIN), inheritedFrom: null },
      ],
    }),
    change({
      changeId: 'chg_01M4FDC0GE1J2VRDD8CTSK96TF',
      projectId: 'prj_aoc',
      scope: 'reversible_off_main',
      status: 'approved',
      title: 'Show the anchor age in the console header',
      createdBy: PRIYA.id,
      ownerId: PRIYA.id,
      fields: fourFields(PRIYA),
      affirmedCount: 4,
      rollbackRef: SHA_B,
      rollbackSha: SHA_B,
      ...submitted(PRIYA, 120),
      selfApprovable: true,
      approval: { approverId: PRIYA.id, selfApproved: true, at: ago(120 * MIN) },
    }),
    change({
      changeId: 'chg_01M4FDBZQ07K5AFQRTGWSKHCF0',
      projectId: 'prj_cxcopilot',
      scope: 'reversible_off_main',
      status: 'completed',
      title: 'Feature-flag the supervisor whisper suggestions',
      createdBy: AISYAH.id,
      ownerId: AISYAH.id,
      fields: fourFields(AISYAH),
      affirmedCount: 4,
      rollbackRef: SHA_C,
      rollbackSha: SHA_C,
      ...submitted(AISYAH, 180),
      selfApprovable: true,
      approval: { approverId: AISYAH.id, selfApproved: true, at: ago(180 * MIN) },
      completedAt: ago(150 * MIN),
      pinnedSha: SHA_C,
      pinnedTag: 'aoc/change/chg_01M4FDBZQ07K5AFQRTGWSKHCF0',
    }),
    change({
      changeId: 'chg_01M4FDC08RBE0KC0AE9KVK2BX3',
      projectId: 'prj_aoc',
      status: 'rejected',
      title: 'Raise the anchor cadence to hourly',
      fields: fourFields(),
      affirmedCount: 4,
      rollbackRef: SHA_B,
      rollbackSha: SHA_B,
      ...submitted(WEIJIE, 160),
      decisionId: 'dec_01M4FDC0CFG34MVJ2ZR1TGJNEW',
      rejection: { approverId: CEO.id, at: ago(150 * MIN), comment: 'Daily is enough for now.' },
    }),
    change({
      changeId: 'chg_01M4FDC18EMAEAWC4PNK5594KQ',
      scope: 'production',
      title: 'Post-incident review for break-glass brk_01M4FDC17SR530WMYBDYVHJW16',
      breakglassId: 'brk_01M4FDC17SR530WMYBDYVHJW16',
      dueAt: ahead(21 * HOUR),
    }),
  ];
}

export function decisionCard(over: Partial<DecisionCardView> = {}): DecisionCardView {
  return {
    id: 'dec_01M4FDC0245CT00W8D9EA7YSWT',
    kind: 'change_request',
    status: 'resolved',
    test: null,
    title: 'Change request: Merge the retry-dedupe fix to main',
    question: 'Approve change chg_01M4FDBZYA4VBEQ8CKEK7FP42E (main) in prj_claims?',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'reject', label: 'Reject' },
    ],
    recommendation: null,
    context: null,
    requiredRole: 'approver',
    requiresPasskey: false,
    requesterId: WEIJIE.id,
    excludedApproverIds: [WEIJIE.id],
    eligibleUserIds: null,
    subjectType: 'change',
    subjectId: 'chg_01M4FDBZYA4VBEQ8CKEK7FP42E',
    sessionId: null,
    projectId: 'prj_claims',
    createdAt: ago(175 * MIN),
    dueAt: null,
    resolution: {
      optionId: 'approve',
      resolvedBy: CEO.id,
      resolvedAt: ago(174 * MIN),
      method: 'button',
      passkeyVerified: false,
      selfApproved: false,
      comment: 'Approved — merge after green CI.',
    },
    ageMs: 60_000,
    overdue: false,
    closedAt: ago(174 * MIN),
    erased: false,
    escalation: null,
    withdrawal: null,
    viewer: { canResolve: false, reason: 'not_open', canWithdraw: false, canEscalate: false },
    ...over,
  };
}

export function pins(projectId = 'prj_claims'): PinListDTO {
  return {
    projectId,
    defaultBranch: 'main',
    head: SHA_B,
    pins: [
      {
        tag: null,
        sha: SHA_A,
        pinnedBy: [
          {
            source: 'change.submitted',
            sourceId: 'chg_01M4FDBZYA4VBEQ8CKEK7FP42E',
            at: ago(HOUR),
            seq: 3185,
          },
        ],
        resolvedSha: SHA_A,
        problem: null,
      },
      {
        tag: 'aoc/phase/claims-v1.2',
        sha: '1111111111111111111111111111111111111111',
        pinnedBy: [{ source: 'phase.completed', sourceId: 'ph_claims_v12', at: ago(48 * HOUR), seq: 812 }],
        resolvedSha: null,
        problem: 'tag_missing',
      },
    ],
  };
}

export function rollback(over: Partial<RollbackDTO> = {}): RollbackDTO {
  return {
    rollbackId: 'rbk_01M4FDCDR1W0X0TMM5X1TV555D',
    projectId: 'prj_claims',
    targetRef: SHA_A,
    targetSha: SHA_A,
    changeId: 'chg_01M4FDBZYA4VBEQ8CKEK7FP42E',
    reason: 'Duplicate-claim rate rose after the dedupe merge.',
    status: 'awaiting_approval',
    requestedBy: AISYAH.id,
    requestedAt: ago(170 * MIN),
    verification: {
      branch: 'aoc/rollback/rbk_01M4FDCDR1W0X0TMM5X1TV555D',
      testsPassed: 42,
      testsFailed: 0,
      clean: true,
      report: 'Command: npm test --silent\nResult: CLEAN',
      at: ago(169 * MIN),
    },
    decisionId: 'dec_01M4FDCDZ1BZDND5KCFB727KXV',
    approval: null,
    rejection: null,
    execution: null,
    failure: null,
    erased: false,
    ...over,
  };
}

export function promotion(over: Partial<PromotionDTO> = {}): PromotionDTO {
  return {
    promotionId: 'prm_01M4FDC1F2EN1VGDKJMEFMKABY',
    projectId: 'prj_aoc',
    fromRef: null,
    fromSha: '05a4753e48b3cdaec87e42920606890f04c062d6',
    targetBranch: null,
    ticketId: null,
    changeId: 'chg_01M4FDC0GE1J2VRDD8CTSK96TF',
    breakglassId: null,
    breakglass: false,
    status: 'refused',
    requestedBy: PRIYA.id,
    requestedAt: ago(170 * MIN),
    decisionId: null,
    refusal: {
      reason: 'provenance_gap',
      orphanShas: ['05a4753e48b3cdaec87e42920606890f04c062d6', 'c89cc8dd39af53d2bec9c1ce3c9cc60d09586c3b'],
      at: ago(170 * MIN),
    },
    rejection: null,
    failure: null,
    completion: null,
    ...over,
  };
}

export function breakglass(over: Partial<BreakglassDTO> = {}): BreakglassDTO {
  return {
    breakglassId: 'brk_01M4FDC1BTHD9F8QYHC2GF1T7W',
    projectId: 'prj_aoc',
    ref: '568a65ba83595686678a29974da711db8d7cea3a',
    sha: '568a65ba83595686678a29974da711db8d7cea3a',
    invokedBy: AISYAH.id,
    invokedAt: ago(170 * MIN),
    justification: 'Console stream reconnects in a tight loop; operators cannot see decisions.',
    decisionId: 'dec_01M4FDC1BVXFHE7CQD8676950V',
    status: 'pending',
    approval: null,
    rejection: null,
    postIncidentChangeId: null,
    postIncidentStatus: null,
    dueAt: null,
    overdue: false,
    overdueFlaggedAt: null,
    promotion: null,
    erased: false,
    ...over,
  };
}

export function auditEvent(
  seq: number,
  type: string,
  over: Partial<AuditEventHeaderDTO> = {},
): AuditEventHeaderDTO {
  const hex = (n: number) => (n * 2654435761).toString(16).padStart(64, '0');
  return {
    seq,
    id: `evt_${String(seq).padStart(6, '0')}`,
    ts: ago((4000 - seq) * 1000),
    type,
    actor: { kind: 'human', id: WEIJIE.id },
    scope: { projectId: 'prj_claims' },
    meta: {},
    source: 'api',
    hasBody: false,
    payloadHashPrefix: null,
    hash: hex(seq),
    prevHash: hex(seq - 1),
    ...over,
  };
}

export function anchors(headSeq = 3368): AnchorListDTO {
  return {
    anchors: [
      {
        anchorId: 'anc_01M4FDB5802M190VM1K1J92C72',
        provider: 'git',
        seq: 3149,
        hash: '6e601fd46fcaf126bdbf31293f732046edefc26cf741ffef188e4cd2903afde7',
        proofRef: 'git:0828e4752437395aca28b7b5f8acfc610c0af6c1:anchors/2026-10-09-3149.json',
        anchoredAt: ago(3 * HOUR),
        eventSeq: 3150,
        signed: false,
        pushed: null,
      },
    ],
    provider: 'git',
    offHost: false,
    headSeq,
  };
}

export function health(over: Partial<AuditHealthDTO> = {}): AuditHealthDTO {
  return {
    generatedAt: new Date(NOW).toISOString(),
    chainId: 'cdb7fbeafd3f232cd1a700a32262c701',
    headSeq: 3368,
    provider: 'git',
    offHost: false,
    lastAnchor: {
      anchorId: 'anc_01M4FDB5802M190VM1K1J92C72',
      provider: 'git',
      seq: 3149,
      at: ago(3 * HOUR),
      ageMs: 3 * HOUR,
    },
    anchorStale: false,
    staleAfterMs: 26 * HOUR,
    unanchoredTail: 219,
    lastAnchorFailure: null,
    lastVerification: { at: ago(3 * HOUR), ok: true, firstBadSeq: null, eventSeq: 3151 },
    projections: [],
    reactorFailures: { total: 0, recent: [] },
    jobs: [
      {
        name: 'audit.anchor',
        lastRunAt: ago(3 * HOUR),
        lastLocalDate: '2026-10-09',
        lastStatus: 'ok',
        lastError: null,
      },
    ],
    selfmodBlocked: { total: 2, last24h: 1 },
    warnings: ['anchor_not_off_host'],
    ...over,
  };
}

export function verifyReport(over: Partial<VerifyReportDTO> = {}): VerifyReportDTO {
  return {
    ok: true,
    chainOk: true,
    chainId: 'cdb7fbeafd3f232cd1a700a32262c701',
    headSeq: 3368,
    headHash: 'ab'.repeat(32),
    checked: 3368,
    anchors: [
      {
        anchorId: 'anc_01M4FDB5802M190VM1K1J92C72',
        provider: 'git',
        seq: 3149,
        anchoredHash: '6e601fd46fcaf126bdbf31293f732046edefc26cf741ffef188e4cd2903afde7',
        recomputedHash: '6e601fd46fcaf126bdbf31293f732046edefc26cf741ffef188e4cd2903afde7',
        matched: true,
        proofOk: true,
        anchoredAt: ago(3 * HOUR),
        proofRef: 'git:0828e4752437395aca28b7b5f8acfc610c0af6c1:anchors/2026-10-09-3149.json',
        signed: false,
        offHost: null,
        problems: [],
      },
    ],
    firstBadSeq: null,
    unanchoredTail: 219,
    lastAnchorSeq: 3149,
    lastAnchorAt: ago(3 * HOUR),
    remoteChecked: null,
    problems: [],
    warnings: ['anchor_not_off_host'],
    verifiedAt: new Date(NOW).toISOString(),
    eventSeq: 3369,
    ...over,
  };
}

export function mappingRow(over: Partial<ComplianceMappingRowDTO> = {}): ComplianceMappingRowDTO {
  return {
    id: 'map-001',
    aocControl: 'Append-only, hash-chained audit event log with a single writer (aocd)',
    aocFeature: 'kernel EventStore: hash chain over ids/enums/hashes in clear',
    clause: 'A.6.2.8',
    clauseTitle: 'AI system recording of event logs',
    relatedClauses: [],
    evidence: ['hash-chained event log (seq, prevHash, hash per event)', 'chain.verified events'],
    eventTypes: ['chain.verified', 'body.erased'],
    metaFilters: {},
    status: 'provisional',
    correctionNote: 'Corrected per §13: AOC-SPEC-002 mapped event logging to A.6.2.6.',
    ...over,
  };
}

export function mapping(over: Partial<ComplianceMappingDTO> = {}): ComplianceMappingDTO {
  return {
    standard: 'ISO/IEC 42001:2023',
    version: '2026.10-draft',
    hash: '182d4ac88183'.padEnd(64, '0'),
    notes: 'PROVISIONAL: drafted from public secondary sources.',
    source: 'config',
    file: '/srv/aoc/config/iso42001-mapping.json',
    warnings: [],
    status: 'provisional',
    stampedBy: null,
    stampedAt: null,
    stamp: null,
    statement: 'PROVISIONAL until stamped by the compliance lead',
    banner: 'Provisional — do not cite',
    publishedAt: ago(14 * 24 * HOUR),
    rows: [
      mappingRow(),
      mappingRow({
        id: 'map-004',
        aocControl: 'Control of documented information (evidence integrity and retention)',
        aocFeature: 'hash-chained log, off-host anchor, frozen evidence packs',
        clause: '7.5',
        clauseTitle: 'Documented information',
        evidence: ['evidence_pack.generated events'],
        eventTypes: ['evidence_pack.generated'],
        correctionNote: null,
      }),
      mappingRow({
        id: 'map-008',
        aocControl: 'Planned changes to the AI management system',
        aocFeature: 'change requests as human-required decisions',
        clause: '6.3',
        clauseTitle: 'Planning of changes',
        evidence: ['change.submitted, change.approved events'],
        eventTypes: ['change.submitted', 'change.approved'],
        correctionNote: null,
      }),
    ],
    viewer: { canStamp: false, reason: 'compliance_lead_required' },
    ...over,
  };
}

export function pack(over: Partial<EvidencePackSummaryDTO> = {}): EvidencePackSummaryDTO {
  return {
    packId: 'evp_01M4FK2X5Z9W8V7T6S5R4Q3P2N',
    from: '2026-10-03',
    to: '2026-10-09',
    generatedAt: ago(10 * MIN),
    generatedBy: { kind: 'human', id: PRIYA.id },
    packHash: 'f1'.repeat(32),
    bytes: 48_213,
    eventCount: 3368,
    headSeq: 3368,
    mappingVersion: '2026.10-draft',
    mappingHash: '182d4ac88183'.padEnd(64, '0'),
    mappingStamped: false,
    rateCardVersion: 3,
    chainOk: true,
    anchorsChecked: 1,
    anchorsMatched: 1,
    downloadUrl: '/api/evidence/packs/evp_01M4FK2X5Z9W8V7T6S5R4Q3P2N/download',
    ...over,
  };
}

export interface ApiCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Handler = unknown | ((url: URL, body: unknown) => unknown);

/**
 * Routes `METHOD /path` to a JSON value (or a function of the request returning one, or a Response). Unknown
 * routes answer 404, so a page that calls something unexpected shows it in the test. Every call is recorded.
 */
export function installApi(routes: Record<string, Handler>): ApiCall[] {
  const calls: ApiCall[] = [];
  mockFetch((raw, init) => {
    const url = new URL(raw, 'http://aoc.test');
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' && init.body ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path: url.pathname, query: url.searchParams, body });
    const route = routes[`${method} ${url.pathname}`];
    if (route === undefined)
      return jsonResponse(
        { error: { code: 'not_found', message: `no fixture for ${method} ${url.pathname}` } },
        { status: 404 },
      );
    const value = typeof route === 'function' ? (route as (u: URL, b: unknown) => unknown)(url, body) : route;
    return value instanceof Response ? value : jsonResponse(value);
  });
  return calls;
}

/** The routes every governance page reads (people and project names). */
export const COMMON_ROUTES: Record<string, Handler> = {
  'GET /api/directory': DIRECTORY,
  'GET /api/projects': PROJECTS,
};

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search}</output>;
}

/** Renders a page at `path` with the console's providers, a fixed clock and a fake event stream. */
export function renderPage(
  element: ReactElement,
  { path, route, user = CEO }: { path: string; route: string; user?: AuthUser },
) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialUser={user}>
        <ToastProvider>
          <ClockProvider clock={fixedClock(NOW)}>
            <EventStreamProvider eventSource={FakeEventSourceCtor}>
              <Routes>
                <Route path={route} element={element} />
                <Route path="*" element={<p>elsewhere</p>} />
              </Routes>
              <Location />
            </EventStreamProvider>
          </ClockProvider>
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}
