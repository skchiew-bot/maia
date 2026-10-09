import { z } from 'zod';
import {
  CHANGE_SCOPES,
  DECISION_KINDS,
  DECISION_TEST_INFO,
  DECISION_TESTS,
  ROLES,
  hasPermission,
  idKindOf,
  newId,
  requiredRoleFor,
  requiresPasskey,
  roleSatisfies,
  type Actor,
  type DecisionBlockReason,
  type DecisionCard,
  type DecisionCardView,
  type DecisionKind,
  type DecisionListFilter,
  type DecisionOption,
  type DecisionRequestInput,
  type DecisionResolveInput,
  type DecisionService,
  type DecisionSummary,
  type EventSource,
  type RequestDecisionInput,
  type Role,
  type Scope,
  type SessionInfo,
  type User,
} from '@aoc/contracts';
import { HttpError, localPeriod, type ModuleContext } from '@aoc/kernel';
import { DecisionReadModel, type DecisionRecord } from './projection';

/** Domain error that doubles as an HTTP error, so callers in any module's routes surface the right status. */
export class DecisionError extends HttpError {
  constructor(status: 403 | 404 | 409 | 422, code: string, message: string, details?: unknown) {
    super(status, code, message, details);
    this.name = 'DecisionError';
  }
}

const ID_RE = /^[A-Za-z0-9._:-]+$/;
const LABEL_RE = /^[a-z0-9_.:/-]+$/i;
const isLabel = (s: string) => s.length >= 1 && s.length <= 80 && LABEL_RE.test(s);
const zRef = z.string().min(1).max(64);
// Option ids are chained in clear (decision.requested meta), so they must be machine ids, never prose.
const zOptionId = zRef.regex(ID_RE, 'option ids may contain letters, digits, . _ : -');
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => s.trim().length > 0, 'must not be blank');

const RequestSchema = z
  .object({
    kind: z.enum(DECISION_KINDS),
    test: z.enum(DECISION_TESTS).nullish(),
    changeScope: z.enum(CHANGE_SCOPES).nullish(),
    title: text(300),
    question: text(20_000),
    options: z
      .array(z.object({ id: zOptionId, label: text(300), description: z.string().max(4000).optional() }))
      .min(1)
      .max(12),
    recommendation: z.object({ optionId: zOptionId, rationale: z.string().max(8000) }).nullish(),
    context: z.string().max(100_000).nullish(),
    subjectType: z.string().min(1).max(80).regex(LABEL_RE, 'subjectType must be a machine label'),
    subjectId: zRef,
    sessionId: zRef.nullish(),
    projectId: zRef.nullish(),
    requesterId: zRef,
    excludedApproverIds: z.array(zRef).max(100).optional(),
    eligibleUserIds: z.array(zRef).min(1).max(100).nullish(),
    dueAt: z
      .string()
      .min(10)
      .max(40)
      .refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO-8601 timestamp')
      .nullish(),
    requiredRole: z.enum(ROLES).optional(),
  })
  .superRefine((v, ctx) => {
    const ids = v.options.map((o) => o.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: 'custom', path: ['options'], message: 'option ids must be unique' });
    if (v.recommendation && !ids.includes(v.recommendation.optionId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendation', 'optionId'],
        message: 'recommendation must name one of the options',
      });
    }
  });

const ROLE_RANK: Record<Role, number> = { requester: 0, builder: 1, approver: 2 };

/** An override may raise the computed role, never lower it; requester-only UAT sign-off is never re-routed. */
function effectiveRole(computed: Role, override: Role | undefined): Role {
  if (!override || computed === 'requester' || override === 'requester') return computed;
  return ROLE_RANK[override] > ROLE_RANK[computed] ? override : computed;
}

const unique = (xs: string[]) => [...new Set(xs)];
const isTicketSubject = (c: Pick<DecisionCard, 'subjectType' | 'subjectId'>) =>
  c.subjectType === 'ticket' || idKindOf(c.subjectId) === 'ticket';

function scopeOf(c: DecisionCard): Scope {
  return {
    decisionId: c.id,
    sessionId: c.sessionId ?? undefined,
    projectId: c.projectId ?? undefined,
    ticketId: isTicketSubject(c) ? c.subjectId : undefined,
    changeId: idKindOf(c.subjectId) === 'change' ? c.subjectId : undefined,
  };
}

/**
 * Cards about a ticket keep their text in the ticket's body scope, so a PDPA erasure of the ticket also
 * shreds decision text quoting it. Everything else uses the store default (session → project → global).
 */
const bodyScopeFor = (c: DecisionCard) => (isTicketSubject(c) ? c.subjectId : undefined);

const closeKey = (id: string) => `decision:${id}:closed`;

function normalizeComment(comment: unknown): string | null {
  return typeof comment === 'string' && comment.trim() ? comment.trim().slice(0, 4000) : null;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface RaiseOptions {
  source?: EventSource;
  causationId?: string;
}

export interface EscalateInput {
  /** Only `approver` is accepted: escalation never routes a decision back to the requester. */
  toRole?: Role;
  /** Machine label. */
  reason?: string;
}

type Resolution = NonNullable<DecisionCard['resolution']>;

/**
 * The unified human-required decision engine (§2.3, §6, §8, §10, §11). State changes only through
 * decision.* events; reads come from the `decisions` projection.
 */
export class DecisionEngine implements DecisionService {
  readonly read: DecisionReadModel;

  /**
   * Kinds an explicit platform policy may resolve without a person (method 'policy'). Every other kind —
   * gates, change records, lesson binding — needs a human. Credit top-ups: the 25%-once auto-grant, at most
   * once per requester per period; any further need goes to a human approver (§10, no AI repeat grants).
   */
  private readonly policies: Partial<Record<DecisionKind, (card: DecisionCard) => void>> = {
    credit_topup: (card) => {
      const tz = this.ctx.config.timezone;
      const period = localPeriod(this.ctx.clock.now(), tz);
      const used = this.read
        .policyResolutionTimes('credit_topup', card.requesterId)
        .some((at) => localPeriod(Date.parse(at), tz) === period);
      if (used) {
        throw new DecisionError(
          409,
          'policy_exhausted',
          'The credit auto-grant was already used this period; a human approver must decide',
        );
      }
    },
  };

  constructor(private readonly ctx: ModuleContext) {
    this.read = new DecisionReadModel(ctx.db);
  }

  // ── raise ─────────────────────────────────────────────────────────────────
  request(input: DecisionRequestInput, actor: Actor): DecisionCard {
    return this.raise(input, actor);
  }

  raise(input: DecisionRequestInput, actor: Actor, opts: RaiseOptions = {}): DecisionCard {
    const parsed = RequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new DecisionError(
        422,
        'invalid',
        'Invalid decision request',
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    const i = parsed.data;
    const uat = i.kind === 'uat_signoff';
    const requiredRole = effectiveRole(
      requiredRoleFor({ kind: i.kind, test: i.test, changeScope: i.changeScope }),
      i.requiredRole,
    );
    // Separation of duties (§6): the requester never resolves their own decision — except UAT, which is their own test.
    const excluded = unique(
      uat ? (i.excludedApproverIds ?? []) : [i.requesterId, ...(i.excludedApproverIds ?? [])],
    );
    // UAT sign-off belongs to the ticket's requester, never to any requester-role user.
    const eligible = i.eligibleUserIds ? unique(i.eligibleUserIds) : uat ? [i.requesterId] : null;
    if (eligible && eligible.every((u) => excluded.includes(u))) {
      throw new DecisionError(
        422,
        'no_eligible_resolver',
        'Every eligible user is excluded by separation of duties',
      );
    }
    const id = newId('decision', this.ctx.clock.now());
    const options: DecisionOption[] = i.options.map((o) =>
      o.description === undefined
        ? { id: o.id, label: o.label }
        : { id: o.id, label: o.label, description: o.description },
    );
    const card: DecisionCard = {
      id,
      kind: i.kind,
      status: 'open',
      test: i.test ?? null,
      title: i.title,
      question: i.question,
      options,
      recommendation: i.recommendation
        ? { optionId: i.recommendation.optionId, rationale: i.recommendation.rationale }
        : null,
      context: i.context ?? null,
      requiredRole,
      requiresPasskey: requiresPasskey(i.kind),
      requesterId: i.requesterId,
      excludedApproverIds: excluded,
      eligibleUserIds: eligible,
      subjectType: i.subjectType,
      subjectId: i.subjectId,
      sessionId: i.sessionId ?? null,
      projectId: i.projectId ?? null,
      createdAt: this.ctx.clock.iso(),
      dueAt: i.dueAt ?? null,
      resolution: null,
    };
    this.ctx.store.append({
      type: 'decision.requested',
      actor,
      scope: scopeOf(card),
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
        optionIds: options.map((o) => o.id),
        recommendedOptionId: card.recommendation?.optionId ?? null,
        requesterId: card.requesterId,
        excludedApproverIds: excluded,
        eligibleUserIds: eligible,
        dueAt: card.dueAt,
      },
      payload: {
        title: card.title,
        question: card.question,
        options,
        ...(card.recommendation ? { recommendation: card.recommendation } : {}),
        ...(card.context !== null ? { context: card.context } : {}),
      },
      source: opts.source ?? (actor.kind === 'system' ? 'system' : 'api'),
      causationId: opts.causationId,
      bodyScope: bodyScopeFor(card),
    });
    return this.get(id) ?? card;
  }

  /**
   * request_decision from a managed session (§2.3): the session owner is the requester (SoD). An identical
   * open card from the same session is returned instead of a duplicate, so client retries are harmless.
   */
  requestFromAgent(session: SessionInfo, input: RequestDecisionInput): DecisionCard {
    const options: DecisionOption[] = input.options.map((o) =>
      o.description === undefined
        ? { id: o.id, label: o.label }
        : { id: o.id, label: o.label, description: o.description },
    );
    const recommendation = {
      optionId: input.recommendation.option_id,
      rationale: input.recommendation.rationale,
    };
    const context = input.context ?? null;
    const duplicate = this.list({
      sessionId: session.sessionId,
      kind: ['agent_decision'],
      status: ['open'],
    }).find(
      (c) =>
        c.test === input.test &&
        c.question === input.question &&
        c.context === context &&
        sameJson(c.options, options) &&
        sameJson(c.recommendation, recommendation),
    );
    if (duplicate) return duplicate;
    return this.raise(
      {
        kind: 'agent_decision',
        test: input.test,
        title: DECISION_TEST_INFO[input.test].label,
        question: input.question,
        options,
        recommendation,
        context,
        subjectType: 'session',
        subjectId: session.sessionId,
        sessionId: session.sessionId,
        projectId: session.projectId,
        requesterId: `session:${session.sessionId}`,
      },
      { kind: 'agent', id: session.sessionId },
      { source: 'mcp' },
    );
  }

  // ── policy ────────────────────────────────────────────────────────────────
  canResolve(card: DecisionCard, user: User): { ok: boolean; reason: DecisionBlockReason | null } {
    const no = (reason: DecisionBlockReason) => ({ ok: false, reason });
    if (card.status !== 'open') return no('not_open');
    if (!user.active) return no('inactive');
    if (card.eligibleUserIds && !card.eligibleUserIds.includes(user.id)) return no('not_eligible');
    // The requester check also covers cards whose exclusion list was written without them.
    if (
      card.excludedApproverIds.includes(user.id) ||
      (card.kind !== 'uat_signoff' && card.requesterId === user.id)
    ) {
      // Optional sole-Approver fallback (decisions.soleApproverFallback, off by default): the only active Approver
      // may resolve their own request, recorded selfApproved — never a credit top-up, which never goes to the requester.
      const fallback =
        this.ctx.config.decisions.soleApproverFallback &&
        card.requesterId === user.id &&
        card.kind !== 'credit_topup' &&
        this.isSoleApprover(user);
      if (!fallback) {
        return no('separation_of_duties');
      }
    }
    if (!roleSatisfies(user.role, card.requiredRole)) return no('role');
    return { ok: true, reason: null };
  }

  private isSoleApprover(user: User): boolean {
    if (user.role !== 'approver') return false;
    const identity = this.ctx.services.maybe('identity');
    if (!identity) return false;
    return !identity.listUsers().some((u) => u.id !== user.id && u.active && u.role === 'approver');
  }

  /** An owner approving their own session's gate is self-approval even though the agent raised the card. */
  private isSelfApproval(card: DecisionCard, user: User): boolean {
    if (card.requesterId === user.id) return true;
    if (!card.sessionId) return false;
    return this.ctx.services.maybe('sessions')?.get(card.sessionId)?.ownerId === user.id;
  }

  mayWithdraw(card: DecisionCard, user: User): boolean {
    return user.role === 'approver' || card.requesterId === user.id;
  }

  // ── close ─────────────────────────────────────────────────────────────────
  async resolve(id: string, input: DecisionResolveInput, user: User): Promise<DecisionCard> {
    let rec = this.assertResolvable(id, input.optionId, user);
    let passkeyVerified = false;
    if (rec.card.requiresPasskey) {
      if (input.passkeyAssertion === undefined || input.passkeyAssertion === null) {
        throw new DecisionError(
          403,
          'passkey_required',
          'passkey required: this decision must be signed with a passkey',
        );
      }
      passkeyVerified = await this.verifyPasskey(user, id, input.optionId, input.passkeyAssertion);
      if (!passkeyVerified)
        throw new DecisionError(403, 'passkey_invalid', 'passkey required: the assertion was not verified');
      // Another resolution may have landed while the assertion was being verified.
      rec = this.assertResolvable(id, input.optionId, user);
    }
    return this.close(rec, {
      optionId: input.optionId,
      actor: { kind: 'human', id: user.id },
      method: passkeyVerified ? 'passkey' : 'button',
      passkeyVerified,
      selfApproved: this.isSelfApproval(rec.card, user),
      comment: normalizeComment(input.comment),
    });
  }

  resolveByPolicy(id: string, optionId: string, actor: Actor, comment?: string): DecisionCard {
    const rec = this.require(id);
    const card = rec.card;
    if (card.status !== 'open')
      throw new DecisionError(409, 'not_open', `decision not open (${card.status})`);
    const policy = this.policies[card.kind];
    if (!policy)
      throw new DecisionError(
        403,
        'policy_not_allowed',
        `${card.kind} decisions need a human; no policy may resolve them`,
      );
    if (actor.kind !== 'system')
      throw new DecisionError(
        403,
        'policy_actor',
        'Only a platform policy (system actor) may resolve by policy',
      );
    if (!card.options.some((o) => o.id === optionId))
      throw new DecisionError(422, 'unknown_option', 'unknown option');
    policy(card);
    return this.close(rec, {
      optionId,
      actor,
      method: 'policy',
      passkeyVerified: false,
      selfApproved: false,
      comment: normalizeComment(comment),
    });
  }

  /**
   * `reason` goes to the chain as a machine label; free text is kept as an encrypted note instead. The label
   * `expired` closes the card as expired (decision.expired, no note).
   */
  withdraw(id: string, reason: string, actor: Actor, note?: string | null): DecisionCard {
    const rec = this.require(id);
    if (rec.card.status !== 'open')
      throw new DecisionError(409, 'not_open', `cannot withdraw: not_open (${rec.card.status})`);
    const trimmed = reason.trim();
    const label = isLabel(trimmed) ? trimmed : 'other';
    if (label === 'expired') return this.expire(id, actor);
    const noteText = normalizeComment(note) ?? (label === trimmed ? null : normalizeComment(trimmed));
    this.claimClose(id);
    this.ctx.store.append({
      type: 'decision.withdrawn',
      actor,
      scope: scopeOf(rec.card),
      meta: { decisionId: id, reason: label },
      payload: noteText ? { note: noteText } : {},
      source: actor.kind === 'system' ? 'system' : 'api',
      idempotencyKey: closeKey(id),
      bodyScope: rec.bodyScope ?? undefined,
    });
    return this.get(id) ?? { ...rec.card, status: 'withdrawn' };
  }

  /** Close an open card unanswered (its deadline passed): decision.expired with the card's age. */
  expire(id: string, actor: Actor): DecisionCard {
    const rec = this.require(id);
    if (rec.card.status !== 'open')
      throw new DecisionError(409, 'not_open', `cannot expire: not_open (${rec.card.status})`);
    this.claimClose(id);
    this.ctx.store.append({
      type: 'decision.expired',
      actor,
      scope: scopeOf(rec.card),
      meta: { decisionId: id, ageMs: Math.max(0, this.ctx.clock.now() - Date.parse(rec.card.createdAt)) },
      source: actor.kind === 'system' ? 'system' : 'api',
      idempotencyKey: closeKey(id),
    });
    return this.get(id) ?? { ...rec.card, status: 'expired' };
  }

  /** Raise an open Builder-level card to the Approver. The requester stays excluded (§6). */
  escalate(id: string, input: EscalateInput, actor: Actor): DecisionCard {
    const rec = this.require(id);
    const card = rec.card;
    if (card.status !== 'open')
      throw new DecisionError(409, 'not_open', `cannot escalate: not_open (${card.status})`);
    if ((input.toRole ?? 'approver') !== 'approver') {
      throw new DecisionError(
        422,
        'invalid_role',
        'Decisions escalate to the Approver only, never back to the requester',
      );
    }
    if (card.requiredRole === 'requester') {
      throw new DecisionError(
        409,
        'not_escalatable',
        'UAT sign-off belongs to the requester and is never re-routed',
      );
    }
    if (card.requiredRole === 'approver')
      throw new DecisionError(409, 'already_approver', 'Decision already routes to the Approver');
    this.ctx.store.append({
      type: 'decision.escalated',
      actor,
      scope: scopeOf(card),
      meta: {
        decisionId: id,
        toRole: 'approver',
        reason: input.reason && isLabel(input.reason) ? input.reason : 'other',
      },
      source: actor.kind === 'system' ? 'system' : 'api',
    });
    return this.get(id) ?? { ...card, requiredRole: 'approver', eligibleUserIds: null };
  }

  private assertResolvable(id: string, optionId: string, user: User): DecisionRecord {
    const rec = this.require(id);
    const { card } = rec;
    if (card.status !== 'open') {
      throw new DecisionError(
        409,
        card.status === 'resolved' ? 'already_resolved' : 'not_open',
        `cannot resolve: not_open (${card.status})`,
      );
    }
    const can = this.canResolve(card, user);
    if (!can.ok) throw new DecisionError(403, can.reason ?? 'forbidden', `cannot resolve: ${can.reason}`);
    if (!card.options.some((o) => o.id === optionId))
      throw new DecisionError(422, 'unknown_option', 'unknown option');
    return rec;
  }

  private async verifyPasskey(
    user: User,
    decisionId: string,
    optionId: string,
    assertion: unknown,
  ): Promise<boolean> {
    const identity = this.ctx.services.maybe('identity');
    if (!identity) return false;
    try {
      return (
        (await identity.verifyDecisionPasskey({ userId: user.id, decisionId, optionId, assertion })) === true
      );
    } catch (err) {
      this.ctx.log.warn('decision passkey verification failed', {
        decisionId,
        err: String(err).slice(0, 200),
      });
      return false;
    }
  }

  /** A decision closes once: the store's idempotency key backs up the status check. */
  private claimClose(id: string): void {
    if (this.ctx.store.findByIdempotencyKey(closeKey(id)))
      throw new DecisionError(409, 'not_open', 'decision already closed');
  }

  private close(
    rec: DecisionRecord,
    r: Omit<Resolution, 'resolvedBy' | 'resolvedAt'> & { actor: Actor },
  ): DecisionCard {
    const { card } = rec;
    this.claimClose(card.id);
    this.ctx.store.append({
      type: 'decision.resolved',
      actor: r.actor,
      scope: scopeOf(card),
      meta: {
        decisionId: card.id,
        kind: card.kind,
        optionId: r.optionId,
        resolvedBy: r.actor.id,
        method: r.method,
        passkeyVerified: r.passkeyVerified,
        selfApproved: r.selfApproved,
        ageMs: Math.max(0, this.ctx.clock.now() - Date.parse(card.createdAt)),
      },
      payload: r.comment ? { comment: r.comment } : {},
      source: r.actor.kind === 'system' ? 'system' : 'api',
      idempotencyKey: closeKey(card.id),
      bodyScope: rec.bodyScope ?? undefined,
    });
    const resolution: Resolution = {
      optionId: r.optionId,
      resolvedBy: r.actor.id,
      resolvedAt: this.ctx.clock.iso(),
      method: r.method,
      passkeyVerified: r.passkeyVerified,
      selfApproved: r.selfApproved,
      comment: r.comment,
    };
    return this.get(card.id) ?? { ...card, status: 'resolved', resolution };
  }

  // ── reads ─────────────────────────────────────────────────────────────────
  get(id: string): DecisionCard | null {
    return this.read.get(id)?.card ?? null;
  }

  record(id: string): DecisionRecord | null {
    return this.read.get(id);
  }

  require(id: string): DecisionRecord {
    const rec = this.read.get(id);
    if (!rec) throw new DecisionError(404, 'not_found', 'decision not found');
    return rec;
  }

  list(filter: DecisionListFilter = {}): DecisionCard[] {
    return this.records(filter).map((r) => r.card);
  }

  /** Open cards first (oldest first), then closed cards (most recently closed first). */
  records(filter: DecisionListFilter = {}): DecisionRecord[] {
    const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 1000)), 10_000);
    const base = {
      kind: filter.kind,
      sessionId: filter.sessionId,
      projectId: filter.projectId,
      subjectId: filter.subjectId,
    };
    const user = filter.resolvableBy;
    if (!user) return this.read.list({ ...base, status: filter.status, limit });
    if (filter.status && !filter.status.includes('open')) return [];
    return this.read
      .list({ ...base, status: ['open'], limit: null })
      .filter((r) => this.canResolve(r.card, user).ok)
      .slice(0, limit);
  }

  summary(user: User): DecisionSummary {
    const open = this.read.list({ status: ['open'], limit: null }).map((r) => r.card);
    const mine = open.filter((c) => this.canResolve(c, user).ok);
    const oldest = (cards: DecisionCard[]) =>
      cards.reduce<string | null>((min, c) => (min === null || c.createdAt < min ? c.createdAt : min), null);
    const byKind: Partial<Record<DecisionKind, number>> = {};
    for (const c of open) byKind[c.kind] = (byKind[c.kind] ?? 0) + 1;
    return {
      generatedAt: this.ctx.clock.iso(),
      open: open.length,
      resolvableByMe: mine.length,
      oldestOpenAt: oldest(open),
      oldestResolvableByMeAt: oldest(mine),
      byKind,
    };
  }

  /** API view: decision age on every card (§12, R15) plus what this viewer may do with it. */
  view(rec: DecisionRecord, user: User): DecisionCardView {
    const now = this.ctx.clock.now();
    const { card } = rec;
    const open = card.status === 'open';
    const can = this.canResolve(card, user);
    return {
      ...card,
      ageMs: Math.max(0, (rec.closedAt ? Date.parse(rec.closedAt) : now) - Date.parse(card.createdAt)),
      overdue: open && card.dueAt !== null && Date.parse(card.dueAt) < now,
      closedAt: rec.closedAt,
      erased: rec.erased,
      escalation: rec.escalation,
      withdrawal: rec.withdrawal,
      viewer: {
        canResolve: can.ok,
        reason: can.reason,
        canWithdraw: open && this.mayWithdraw(card, user),
        canEscalate:
          open && card.requiredRole === 'builder' && hasPermission(user.role, 'decision.resolve', user.flags),
      },
    };
  }
}
