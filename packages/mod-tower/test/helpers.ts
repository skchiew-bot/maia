import type {
  Actor,
  DecisionKind,
  DecisionTest,
  LivenessState,
  MeteringService,
  ServiceMap,
  Severity,
  TaskSize,
  TowerSnapshot,
} from '@aoc/contracts';
import { TASK_SIZE_WEIGHT } from '@aoc/contracts';
import {
  createTestRuntime,
  type AocModule,
  type NewEvent,
  type TestRuntime,
  type TestUser,
} from '@aoc/kernel';
import { createTowerModule } from '../src';

export const NOW = '2026-10-09T06:00:00.000Z'; // 14:00 in Kuala Lumpur
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

const SYS: Actor = { kind: 'system', id: 'test' };

export interface Harness {
  t: TestRuntime;
  approver: TestUser;
  /** Append an event at `at` (ISO or epoch ms; default: the harness clock). The clock is restored afterwards. */
  emit<T extends NewEvent>(e: T, at?: string | number): void;
  snap(query?: string, user?: TestUser): Promise<TowerSnapshot>;
  close(): Promise<void>;
}

export async function setup(
  opts: { services?: Partial<ServiceMap>; now?: string; timezone?: string; modules?: AocModule[] } = {},
): Promise<Harness> {
  const t = await createTestRuntime({
    modules: [createTowerModule(), ...(opts.modules ?? [])],
    services: opts.services,
    now: opts.now ?? NOW,
    config: opts.timezone ? { timezone: opts.timezone } : undefined,
  });
  const approver = t.user('approver', 'Approver');
  return {
    t,
    approver,
    emit(e, at) {
      if (at === undefined) {
        t.rt.store.append(e);
        return;
      }
      const keep = t.clock.now();
      t.clock.set(at);
      try {
        t.rt.store.append(e);
      } finally {
        t.clock.set(keep);
      }
    },
    snap: (query = '', user = approver) =>
      t.json<TowerSnapshot>('GET', `/api/tower${query}`, { headers: user.headers }),
    close: () => t.close(),
  };
}

/** Epoch ms `ms` before the harness "now". */
export const ago = (h: Harness, ms: number) => h.t.clock.now() - ms;

// ── event builders ───────────────────────────────────────────────────────────

export function launch(
  h: Harness,
  sessionId: string,
  o: {
    at?: number;
    projectId?: string;
    owner?: string | null;
    processType?: string;
    model?: string;
    ticketId?: string | null;
    threadId?: string;
    readOnly?: boolean;
  } = {},
): void {
  const projectId = o.projectId ?? 'prj_a';
  h.emit(
    {
      type: 'session.launch_requested',
      actor: o.owner ? { kind: 'human', id: o.owner } : SYS,
      scope: { sessionId, projectId },
      meta: {
        sessionId,
        projectId,
        threadId: o.threadId ?? `thr_${sessionId}`,
        processType: o.processType ?? 'feature',
        model: o.model ?? 'claude-opus-5-5',
        readOnly: o.readOnly ?? false,
        credentialProfile: null,
        ticketId: o.ticketId ?? null,
        parentSessionId: null,
        phaseId: null,
      },
      payload: { prompt: 'secret prompt text', cwd: '/tmp/repo' },
      source: 'supervisor',
    },
    o.at,
  );
  h.emit(
    {
      type: 'session.lifecycle_changed',
      actor: SYS,
      scope: { sessionId },
      meta: { sessionId, from: 'launching', to: 'running', reason: 'launched' },
      source: 'supervisor',
    },
    o.at,
  );
}

const lastState = new WeakMap<Harness, Map<string, LivenessState | null>>();
export function live(h: Harness, sessionId: string, to: LivenessState | null, at?: number): void {
  const states = lastState.get(h) ?? new Map<string, LivenessState | null>();
  lastState.set(h, states);
  const from = states.get(sessionId) ?? null;
  states.set(sessionId, to);
  h.emit(
    {
      type: 'session.liveness_changed',
      actor: SYS,
      scope: { sessionId },
      meta: { sessionId, from, to, reason: 'test' },
      source: 'system',
    },
    at,
  );
}

export function end(h: Harness, sessionId: string, at?: number): void {
  live(h, sessionId, null, at);
  h.emit(
    {
      type: 'session.ended',
      actor: SYS,
      scope: { sessionId },
      meta: { sessionId, outcome: 'completed' },
      source: 'supervisor',
    },
    at,
  );
}

export function project(h: Harness, projectId: string, name: string): void {
  h.emit({
    type: 'project.created',
    actor: SYS,
    scope: { projectId },
    meta: { projectId, slug: projectId.replace('_', '-') },
    payload: { name },
    source: 'api',
  });
}

export function decide(
  h: Harness,
  decisionId: string,
  kind: DecisionKind,
  o: {
    at?: number;
    test?: DecisionTest | null;
    projectId?: string | null;
    sessionId?: string | null;
    subjectType?: string;
    subjectId?: string;
    requesterId?: string;
    title?: string;
  } = {},
): void {
  h.emit(
    {
      type: 'decision.requested',
      actor: SYS,
      scope: { decisionId },
      meta: {
        decisionId,
        kind,
        test: o.test ?? null,
        requiredRole: 'approver',
        requiresPasskey: kind === 'go_live' || kind === 'rollback' || kind === 'break_glass',
        subjectType: o.subjectType ?? 'session',
        subjectId: o.subjectId ?? 'sub_1',
        sessionId: o.sessionId ?? null,
        projectId: o.projectId === undefined ? 'prj_a' : o.projectId,
        optionIds: ['approve', 'reject'],
        recommendedOptionId: null,
        requesterId: o.requesterId ?? 'usr_requester',
        excludedApproverIds: [],
        eligibleUserIds: null,
        dueAt: null,
      },
      payload: {
        title: o.title ?? `${kind} decision`,
        question: 'Proceed?',
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
      },
      source: 'api',
    },
    o.at,
  );
}

export function resolveDecision(
  h: Harness,
  decisionId: string,
  kind: DecisionKind,
  at?: number,
  method: 'button' | 'passkey' | 'policy' = 'button',
): void {
  h.emit(
    {
      type: 'decision.resolved',
      actor: { kind: 'human', id: 'usr_approver' },
      scope: { decisionId },
      meta: {
        decisionId,
        kind,
        optionId: 'approve',
        resolvedBy: 'usr_approver',
        method,
        passkeyVerified: method === 'passkey',
        selfApproved: false,
        ageMs: 0,
      },
      payload: {},
      source: 'api',
    },
    at,
  );
}

/** Declare a manifest; tasks are `t1…tN` unless `ids` names them (rollover successors re-declare carried ids). */
export function plan(
  h: Harness,
  sessionId: string,
  sizes: TaskSize[],
  o: { at?: number; projectId?: string; threadId?: string | null; ids?: string[]; carriedOver?: number } = {},
): void {
  const projectId = o.projectId ?? 'prj_a';
  h.emit(
    {
      type: 'plan.declared',
      actor: { kind: 'agent', id: sessionId },
      scope: { sessionId, projectId },
      meta: {
        sessionId,
        projectId,
        threadId: o.threadId === undefined ? `thr_${sessionId}` : o.threadId,
        manifestVersion: 1,
        phaseCount: 1,
        taskCount: sizes.length,
        totalWeight: sizes.reduce((w, s) => w + TASK_SIZE_WEIGHT[s], 0),
        ...(o.carriedOver !== undefined ? { carriedOver: o.carriedOver } : {}),
      },
      payload: {
        phases: [
          {
            id: 'p1',
            name: 'Build',
            tasks: sizes.map((size, i) => ({ id: o.ids?.[i] ?? `t${i + 1}`, title: `Task ${i + 1}`, size })),
          },
        ],
      },
      source: 'mcp',
    },
    o.at,
  );
}

export function amend(
  h: Harness,
  sessionId: string,
  o: {
    prev: number;
    next: number;
    add?: { id: string; size: TaskSize }[];
    at?: number;
    projectId?: string;
    version?: number;
  },
): void {
  const projectId = o.projectId ?? 'prj_a';
  const add = o.add ?? [];
  h.emit(
    {
      type: 'plan.amended',
      actor: { kind: 'agent', id: sessionId },
      scope: { sessionId, projectId },
      meta: {
        sessionId,
        projectId,
        manifestVersion: o.version ?? 2,
        added: add.length,
        removed: 0,
        resized: 0,
        prevTotalWeight: o.prev,
        newTotalWeight: o.next,
      },
      payload: {
        reason: 'scope grew',
        add: add.map((t) => ({ ...t, title: `Task ${t.id}`, phaseId: 'p1' })),
      },
      source: 'mcp',
    },
    o.at,
  );
}

export function taskDone(
  h: Harness,
  sessionId: string,
  taskId: string,
  o: {
    at?: number;
    projectId?: string;
    weight?: number;
    evidenceVerified?: boolean;
    flag?: 'no_file_change' | 'evidence_unverified' | null;
  } = {},
): void {
  const projectId = o.projectId ?? 'prj_a';
  const evidenceVerified = o.evidenceVerified ?? true;
  h.emit(
    {
      type: 'task.done',
      actor: { kind: 'agent', id: sessionId },
      scope: { sessionId, projectId, taskId },
      meta: {
        sessionId,
        projectId,
        taskId,
        phaseId: 'p1',
        weight: o.weight ?? 2,
        evidenceKind: 'test',
        evidenceVerified,
        flag: o.flag === undefined ? (evidenceVerified ? null : 'evidence_unverified') : o.flag,
        fileChangesSinceLast: o.flag === 'no_file_change' ? 0 : 1,
      },
      payload: { evidence: { kind: 'test', ref: 'pkg/a.test.ts > works' } },
      source: 'mcp',
    },
    o.at,
  );
}

let msg = 0;
export function usage(
  h: Harness,
  sessionId: string,
  tokens: number,
  o: { at?: number; model?: string; contextTokens?: number } = {},
): void {
  const at = new Date(o.at ?? h.t.clock.now()).toISOString();
  h.emit(
    {
      type: 'usage.recorded',
      actor: { kind: 'system', id: 'sidecar' },
      scope: { sessionId },
      meta: {
        sessionId,
        model: o.model ?? 'claude-opus-5-5',
        inputTokens: tokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        messages: 1,
        contextTokens: o.contextTokens ?? 1000,
        firstAt: at,
        lastAt: at,
      },
      payload: { messageIds: [`msg_${++msg}`] },
      source: 'sidecar',
    },
    o.at,
  );
}

export function ticket(
  h: Harness,
  ticketId: string,
  severity: Severity,
  o: { at?: number; projectId?: string } = {},
): void {
  h.emit(
    {
      type: 'intake.submitted',
      actor: { kind: 'human', id: 'usr_customer' },
      scope: { ticketId, projectId: o.projectId ?? 'prj_a' },
      meta: { ticketId, requesterId: 'usr_customer', severity, attachmentCount: 0, attachmentHashes: [] },
      payload: { title: 'Login broken for jane@example.com', description: 'Call me on 0123456789' },
      source: 'intake',
    },
    o.at,
  );
}

export function ticketEvent(h: Harness, e: NewEvent, at?: number): void {
  h.emit(e, at);
}

/** Metering stub: $1 per 1,000 tokens on opus, $0.20 on sonnet, $0.05 on haiku; fixed USD/MYR 4.2. */
export function meteringStub(fx: number | null = 4.2): {
  stub: MeteringService;
  calls: { model: string; date: string }[];
} {
  const calls: { model: string; date: string }[] = [];
  const perK = (model: string) => (model.includes('opus') ? 1 : model.includes('sonnet') ? 0.2 : 0.05);
  return {
    calls,
    stub: {
      notionalCostUsd(model, u, date) {
        calls.push({ model, date });
        return (
          ((u.inputTokens +
            u.outputTokens +
            u.cacheReadTokens +
            u.cacheWrite5mTokens +
            u.cacheWrite1hTokens) /
            1000) *
          perK(model)
        );
      },
      fxRate: (date) => (fx === null ? null : { rate: fx, status: 'live', sourceDate: date }),
      sessionCostUsd: () => 0,
      activeRateCardVersion: () => 1,
    },
  };
}

export const sys = SYS;
export const minutes = (n: number) => n * MIN;
export const hours = (n: number) => n * HOUR;

// ── credits, change control, audit, registry ────────────────────────────────

export function capReached(
  h: Harness,
  userId: string,
  sessionId: string,
  at?: number,
  period = '2026-10',
): void {
  h.emit(
    {
      type: 'credit.cap_reached',
      actor: SYS,
      scope: { userId, sessionId },
      meta: { userId, sessionId, taskId: null, balanceUsd: 0, period },
      source: 'system',
    },
    at,
  );
}

export function topupRequested(
  h: Harness,
  userId: string,
  requestId: string,
  decisionId: string,
  at?: number,
): void {
  h.emit(
    {
      type: 'credit.topup_requested',
      actor: { kind: 'human', id: userId },
      scope: { userId, decisionId },
      meta: {
        requestId,
        userId,
        period: '2026-10',
        amountUsd: 50,
        sessionId: null,
        taskId: null,
        decisionId,
      },
      payload: { reason: 'need more' },
      source: 'api',
    },
    at,
  );
}

export function topupGranted(
  h: Harness,
  userId: string,
  requestId: string,
  decisionId: string,
  at?: number,
): void {
  h.emit(
    {
      type: 'credit.topup_granted',
      actor: { kind: 'human', id: 'usr_approver' },
      scope: { userId, decisionId },
      meta: {
        requestId,
        userId,
        amountUsd: 50,
        approverId: 'usr_approver',
        balanceBefore: 0,
        balanceAfter: 50,
        decisionId,
      },
      source: 'api',
    },
    at,
  );
}

export function changeDrafted(h: Harness, changeId: string, projectId = 'prj_a', at?: number): void {
  h.emit(
    {
      type: 'change.drafted',
      actor: { kind: 'human', id: 'usr_builder' },
      scope: { changeId, projectId },
      meta: {
        changeId,
        projectId,
        scope: 'reversible_off_main',
        draftedBy: 'ai',
        sessionId: null,
        breakglassId: null,
      },
      payload: {
        title: 'Change',
        impact: 'i',
        mitigation: 'm',
        rollbackPlan: 'r',
        rollbackRef: 'abc1234',
        acceptanceTest: 't',
      },
      source: 'api',
    },
    at,
  );
}

export function affirmed(
  h: Harness,
  changeId: string,
  edited: boolean,
  dwellMs: number,
  at?: number,
  userId = 'usr_builder',
): void {
  h.emit(
    {
      type: 'change.field_affirmed',
      actor: { kind: 'human', id: userId },
      scope: { changeId, userId },
      meta: { changeId, field: 'impact', edited, editRatio: edited ? 0.4 : 0, dwellMs },
      payload: { value: 'ok' },
      source: 'api',
    },
    at,
  );
}

export function changeApproved(
  h: Harness,
  changeId: string,
  selfApproved: boolean,
  approverId = 'usr_builder',
  at?: number,
): void {
  h.emit(
    {
      type: 'change.approved',
      actor: { kind: 'human', id: approverId },
      scope: { changeId, userId: approverId },
      meta: { changeId, decisionId: null, approverId, selfApproved },
      source: 'api',
    },
    at,
  );
}

export function changeCompleted(h: Harness, changeId: string, at?: number): void {
  h.emit(
    {
      type: 'change.completed',
      actor: SYS,
      scope: { changeId },
      meta: { changeId, pinnedSha: 'abcdef1', pinnedTag: 'chg-1' },
      source: 'supervisor',
    },
    at,
  );
}

export function verified(
  h: Harness,
  ok: boolean,
  at?: number,
  firstBadSeq: number | null = ok ? null : 42,
): void {
  h.emit(
    {
      type: 'chain.verified',
      actor: SYS,
      meta: { ok, headSeq: 100, checked: 100, anchorsChecked: 1, anchorsMatched: ok ? 1 : 0, firstBadSeq },
      payload: { problems: ok ? [] : ['seq 42: hash mismatch'] },
      source: 'scheduler',
    },
    at,
  );
}

export function anchored(h: Harness, at?: number): void {
  const seq = Math.max(1, h.t.rt.store.head().seq);
  h.emit(
    {
      type: 'anchor.created',
      actor: SYS,
      meta: { anchorId: `anc_${seq}`, seq, hash: 'a'.repeat(64), provider: 'git', proofRef: 'commit:abc' },
      source: 'scheduler',
    },
    at,
  );
}

export function playbookApproved(h: Harness, playbookId: string, processType: string, at?: number): void {
  h.emit(
    {
      type: 'playbook.proposed',
      actor: SYS,
      meta: {
        playbookId,
        processType,
        sourceSessionId: null,
        version: 1,
        stepCount: 1,
        decisionId: `dec_${playbookId}`,
        method: 'fallback',
      },
      payload: { title: 'Playbook', steps: [{ id: 's1', title: 'Step' }] },
      source: 'system',
    },
    at,
  );
  h.emit(
    {
      type: 'playbook.approved',
      actor: { kind: 'human', id: 'usr_approver' },
      meta: { playbookId, decisionId: `dec_${playbookId}`, approverId: 'usr_approver' },
      source: 'api',
    },
    at,
  );
}
