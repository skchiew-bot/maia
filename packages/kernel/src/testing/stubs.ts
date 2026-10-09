import {
  newId,
  requiredRoleFor,
  requiresPasskey,
  roleSatisfies,
  type Actor,
  type DecisionCard,
  type DecisionListFilter,
  type DecisionRequestInput,
  type DecisionResolveInput,
  type DecisionService,
  type IdentityService,
  type SessionDirectory,
  type SessionInfo,
  type User,
} from '@aoc/contracts';
import type { EventStore } from '../store/event-store';
import type { Clock } from '../clock';

/**
 * Minimal DecisionService for module tests (the real one is mod-decisions). Appends REAL
 * decision.requested / decision.resolved events with the catalog shapes, enforces role, SoD,
 * eligibility and passkey — so reactors in other modules can be tested end to end.
 */
export class SimpleDecisionService implements DecisionService {
  readonly cards = new Map<string, DecisionCard>();

  constructor(
    private readonly store: EventStore,
    private readonly clock: Clock,
    private readonly identity: () => IdentityService | null,
  ) {}

  request(input: DecisionRequestInput, actor: Actor): DecisionCard {
    const id = newId('decision', this.clock.now());
    const requiredRole = input.requiredRole ?? requiredRoleFor({ kind: input.kind, test: input.test, changeScope: input.changeScope });
    const excluded = [...new Set([input.requesterId, ...(input.excludedApproverIds ?? [])])];
    const card: DecisionCard = {
      id,
      kind: input.kind,
      status: 'open',
      test: input.test ?? null,
      title: input.title,
      question: input.question,
      options: input.options,
      recommendation: input.recommendation ?? null,
      context: input.context ?? null,
      requiredRole,
      requiresPasskey: requiresPasskey(input.kind),
      requesterId: input.requesterId,
      excludedApproverIds: input.kind === 'uat_signoff' ? (input.excludedApproverIds ?? []) : excluded,
      eligibleUserIds: input.eligibleUserIds ?? null,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      sessionId: input.sessionId ?? null,
      projectId: input.projectId ?? null,
      createdAt: this.clock.iso(),
      dueAt: input.dueAt ?? null,
      resolution: null,
    };
    this.store.append({
      type: 'decision.requested',
      actor,
      scope: { decisionId: id, sessionId: card.sessionId ?? undefined, projectId: card.projectId ?? undefined },
      meta: {
        decisionId: id,
        kind: card.kind,
        test: card.test,
        requiredRole,
        requiresPasskey: card.requiresPasskey,
        subjectType: card.subjectType,
        subjectId: card.subjectId,
        sessionId: card.sessionId,
        projectId: card.projectId,
        optionIds: card.options.map((o) => o.id),
        recommendedOptionId: card.recommendation?.optionId ?? null,
        requesterId: card.requesterId,
        excludedApproverIds: card.excludedApproverIds,
        eligibleUserIds: card.eligibleUserIds,
        dueAt: card.dueAt,
      },
      payload: {
        title: card.title,
        question: card.question,
        options: card.options,
        ...(card.recommendation ? { recommendation: card.recommendation } : {}),
        ...(card.context ? { context: card.context } : {}),
      },
      source: 'api',
    });
    this.cards.set(id, card);
    return card;
  }

  canResolve(card: DecisionCard, user: User): { ok: boolean; reason: string | null } {
    if (card.status !== 'open') return { ok: false, reason: 'not_open' };
    if (card.eligibleUserIds && !card.eligibleUserIds.includes(user.id)) return { ok: false, reason: 'not_eligible' };
    if (card.excludedApproverIds.includes(user.id)) return { ok: false, reason: 'separation_of_duties' };
    if (!roleSatisfies(user.role, card.requiredRole)) return { ok: false, reason: 'role' };
    return { ok: true, reason: null };
  }

  async resolve(id: string, input: DecisionResolveInput, user: User): Promise<DecisionCard> {
    const card = this.cards.get(id);
    if (!card) throw new Error('decision not found');
    const can = this.canResolve(card, user);
    if (!can.ok) throw new Error(`cannot resolve: ${can.reason}`);
    if (!card.options.some((o) => o.id === input.optionId)) throw new Error('unknown option');
    let passkeyVerified = false;
    if (card.requiresPasskey) {
      passkeyVerified = (await this.identity()?.verifyDecisionPasskey({ userId: user.id, decisionId: id, optionId: input.optionId, assertion: input.passkeyAssertion })) ?? false;
      if (!passkeyVerified) throw new Error('passkey required');
    }
    return this.finish(card, input.optionId, { kind: 'human', id: user.id }, passkeyVerified ? 'passkey' : 'button', passkeyVerified, input.comment ?? null, card.requesterId === user.id);
  }

  resolveByPolicy(id: string, optionId: string, actor: Actor, comment?: string): DecisionCard {
    const card = this.cards.get(id);
    if (!card || card.status !== 'open') throw new Error('decision not open');
    return this.finish(card, optionId, actor, 'policy', false, comment ?? null, false);
  }

  private finish(card: DecisionCard, optionId: string, actor: Actor, method: 'button' | 'passkey' | 'policy', passkeyVerified: boolean, comment: string | null, selfApproved: boolean): DecisionCard {
    this.store.append({
      type: 'decision.resolved',
      actor,
      scope: { decisionId: card.id, sessionId: card.sessionId ?? undefined, projectId: card.projectId ?? undefined },
      meta: {
        decisionId: card.id,
        kind: card.kind,
        optionId,
        resolvedBy: actor.id,
        method,
        passkeyVerified,
        selfApproved,
        ageMs: Math.max(0, this.clock.now() - Date.parse(card.createdAt)),
      },
      payload: comment ? { comment } : {},
      source: 'api',
    });
    const done: DecisionCard = {
      ...card,
      status: 'resolved',
      resolution: { optionId, resolvedBy: actor.id, resolvedAt: this.clock.iso(), method, passkeyVerified, selfApproved, comment },
    };
    this.cards.set(card.id, done);
    return done;
  }

  withdraw(id: string, reason: string, actor: Actor): DecisionCard {
    const card = this.cards.get(id);
    if (!card) throw new Error('decision not found');
    this.store.append({ type: 'decision.withdrawn', actor, scope: { decisionId: id }, meta: { decisionId: id, reason }, payload: {}, source: 'api' });
    const done: DecisionCard = { ...card, status: 'withdrawn' };
    this.cards.set(id, done);
    return done;
  }

  escalate(id: string, _input: { toRole?: string; reason?: string }, actor: Actor): DecisionCard {
    const card = this.cards.get(id);
    if (!card || card.status !== 'open') throw new Error('decision not open');
    this.store.append({ type: 'decision.escalated', actor, scope: { decisionId: id }, meta: { decisionId: id, toRole: 'approver', reason: 'other' }, source: 'api' });
    const up: DecisionCard = { ...card, requiredRole: 'approver' };
    this.cards.set(id, up);
    return up;
  }

  summary(user: User): { open: number; resolvableByMe: number; oldestOpenAt: string | null; oldestResolvableByMeAt: string | null } {
    const open = [...this.cards.values()].filter((c) => c.status === 'open');
    const mine = open.filter((c) => this.canResolve(c, user).ok);
    const oldest = (xs: DecisionCard[]) => xs.map((c) => c.createdAt).sort()[0] ?? null;
    return { open: open.length, resolvableByMe: mine.length, oldestOpenAt: oldest(open), oldestResolvableByMeAt: oldest(mine) };
  }

  get(id: string): DecisionCard | null {
    return this.cards.get(id) ?? null;
  }

  list(f: DecisionListFilter = {}): DecisionCard[] {
    return [...this.cards.values()].filter(
      (c) =>
        (!f.status || f.status.includes(c.status)) &&
        (!f.kind || f.kind.includes(c.kind)) &&
        (!f.sessionId || c.sessionId === f.sessionId) &&
        (!f.projectId || c.projectId === f.projectId) &&
        (!f.subjectId || c.subjectId === f.subjectId) &&
        (!f.resolvableBy || this.canResolve(c, f.resolvableBy).ok),
    );
  }
}

/** In-memory SessionDirectory for module tests (the real one is mod-sessions). */
export class MemorySessionDirectory implements SessionDirectory {
  readonly sessions = new Map<string, SessionInfo>();
  readonly context = new Map<string, number>();

  add(partial: Partial<SessionInfo> & { sessionId: string }): SessionInfo {
    const info: SessionInfo = {
      mode: 'managed',
      claudeSessionId: null,
      ownerId: null,
      projectId: null,
      threadId: null,
      processType: 'discovery',
      model: 'claude-opus-5-5',
      readOnly: false,
      lifecycle: 'running',
      liveness: 'working',
      cwd: null,
      ticketId: null,
      startedAt: '2026-10-09T00:00:00.000Z',
      ...partial,
    };
    this.sessions.set(info.sessionId, info);
    return info;
  }
  get(id: string): SessionInfo | null {
    return this.sessions.get(id) ?? null;
  }
  byClaudeSessionId(cid: string): SessionInfo | null {
    return [...this.sessions.values()].find((s) => s.claudeSessionId === cid) ?? null;
  }
  list(f: { projectId?: string; lifecycle?: SessionInfo['lifecycle'][]; mode?: SessionInfo['mode'] } = {}): SessionInfo[] {
    return [...this.sessions.values()].filter(
      (s) => (!f.projectId || s.projectId === f.projectId) && (!f.lifecycle || f.lifecycle.includes(s.lifecycle)) && (!f.mode || s.mode === f.mode),
    );
  }
  contextTokens(id: string): number {
    return this.context.get(id) ?? 0;
  }
}
