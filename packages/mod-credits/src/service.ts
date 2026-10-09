import {
  newId,
  type Actor,
  type BoundaryInstruction,
  type CreditAccount,
  type CreditAccountsResponse,
  type CreditAllocationInput,
  type CreditBalance,
  type CreditService,
  type CreditTopupRequest,
  type CreditTopupRequestInput,
  type CreditTopupStatus,
  type MeteringService,
  type MetaOf,
  type Scope,
  type SessionInfo,
  type StoredEvent,
  type User,
} from '@aoc/contracts';
import { HttpError, localPeriod, type ModuleContext } from '@aoc/kernel';
import type { CreditRepo, GrantRow, TopupRow, UsageGroup } from './projection';
import {
  autoGrantAmount,
  balanceOf,
  boundaryVerdict,
  capInstruction,
  isCapped,
  roundCents,
  roundUsd,
} from './rules';

const APPROVE = 'approve';
const DENY = 'deny';
/** The AI-approved auto grant is a credit_topup decision resolved by this policy actor. */
const POLICY_ACTOR: Actor = { kind: 'system', id: 'credits:auto-grant' };
const MODULE_ACTOR: Actor = { kind: 'system', id: 'credits' };

interface AccountState {
  userId: string;
  period: string;
  allocationUsd: number;
  allocationSource: 'default' | 'allocated';
  grants: GrantRow[];
  grantedUsd: number;
  usedUsd: number;
  balanceUsd: number;
  autoGrantUsed: boolean;
  /** What the auto grant would add at the next cap (0 once used). */
  autoGrantUsd: number;
  exempt: boolean;
}

const usd = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
/** Exactly one terminal event (granted / denied / withdrawn) per top-up request. */
const resolutionKey = (requestId: string) => `crd:topup-resolved:${requestId}`;
const metaOf = <T extends 'decision.resolved' | 'decision.withdrawn'>(e: StoredEvent, _type: T) =>
  e.meta as unknown as MetaOf<T>;

/**
 * Credit accounts per user per local period: allocation (config default unless credit.allocated) +
 * grants − notional cost of usage in sessions the user owns. Enforced only via checkBoundary, which
 * callers invoke at task boundaries; nothing here reacts to usage mid-task (R7) or touches the model (R8).
 */
export class CreditsEngine implements CreditService {
  private warnedNoMetering = false;

  constructor(
    private readonly ctx: ModuleContext,
    private readonly repo: CreditRepo,
  ) {}

  currentPeriod(): string {
    return localPeriod(this.ctx.clock.now(), this.ctx.config.timezone);
  }

  // ── CreditService ─────────────────────────────────────────────────────────
  checkBoundary(sessionId: string, taskId: string | null, actor: Actor): BoundaryInstruction {
    const session = this.ctx.services.maybe('sessions')?.get(sessionId) ?? null;
    // Unattributed sessions (unknown / observed without a mapped user) have no account to cap.
    if (!session?.ownerId) return { continue: true };
    const s = this.state(session.ownerId, this.currentPeriod());
    const verdict = boundaryVerdict(s);
    if (verdict.action === 'continue') return { continue: true };

    const cap = this.recordCap(s, session, taskId, actor);
    if (verdict.action === 'auto_grant') {
      const decisionId = this.recordPolicyDecision(s, session, verdict.amountUsd);
      this.ctx.store.append({
        type: 'credit.auto_granted',
        actor: POLICY_ACTOR,
        scope: { ...this.sessionScope(s.userId, session, taskId), decisionId: decisionId ?? undefined },
        meta: {
          userId: s.userId,
          period: s.period,
          amountUsd: verdict.amountUsd,
          balanceBefore: s.balanceUsd,
          balanceAfter: verdict.balanceAfter,
          sessionId,
          taskId,
          allocationUsd: s.allocationUsd,
          decisionId,
        },
        source: 'system',
        idempotencyKey: `crd:auto:${JSON.stringify([s.userId, s.period])}`,
        causationId: cap.event.id,
      });
      if (verdict.balanceAfter > 0) return { continue: true };
    }
    if (cap.fresh) {
      this.ctx.notify({
        kind: 'session.attention',
        title: 'Credit cap reached: top-up needed',
        audience: ['builder', 'approver'],
        severity: 'warn',
        refs: { sessionId, userId: s.userId },
      });
    }
    return capInstruction(s.period);
  }

  balance(userId: string, period: string = this.currentPeriod()): CreditBalance {
    const s = this.state(userId, period);
    return {
      userId,
      period,
      allocationUsd: s.allocationUsd,
      grantedUsd: s.grantedUsd,
      usedUsd: s.usedUsd,
      balanceUsd: s.balanceUsd,
      autoGrantUsed: s.autoGrantUsed,
      pendingTopupRequestId: this.pendingFor(userId, period)?.requestId ?? null,
      exempt: s.exempt,
    };
  }

  // ── read models ───────────────────────────────────────────────────────────
  account(userId: string, period: string = this.currentPeriod()): CreditAccount {
    return this.accountOf(this.state(userId, period));
  }

  accounts(period: string = this.currentPeriod()): CreditAccountsResponse {
    const used = this.usageByOwner(period);
    const ids = new Set([...used.keys(), ...this.repo.userIdsWithActivity(period)]);
    for (const u of this.ctx.services.maybe('identity')?.listUsers() ?? [])
      if (u.active && u.role !== 'requester') ids.add(u.id);
    const accounts = [...ids].map((id) => this.accountOf(this.state(id, period, used.get(id) ?? 0)));
    accounts.sort(
      (a, b) =>
        (a.userName ?? a.userId).localeCompare(b.userName ?? b.userId) || a.userId.localeCompare(b.userId),
    );
    return { period, accounts };
  }

  private accountOf(s: AccountState): CreditAccount {
    const pending = this.pendingFor(s.userId, s.period);
    return {
      userId: s.userId,
      userName: this.userName(s.userId),
      period: s.period,
      allocationUsd: s.allocationUsd,
      allocationSource: s.allocationSource,
      usedUsd: s.usedUsd,
      grantedUsd: s.grantedUsd,
      balanceUsd: s.balanceUsd,
      autoGrantUsed: s.autoGrantUsed,
      autoGrantAvailableUsd: s.exempt ? 0 : s.autoGrantUsd,
      capped: isCapped(s),
      exempt: s.exempt,
      pendingTopup: pending
        ? {
            requestId: pending.requestId,
            decisionId: pending.decisionId,
            amountUsd: pending.amountUsd,
            createdAt: pending.createdAt,
            ageMs: this.ageMs(pending),
          }
        : null,
      grants: s.grants,
    };
  }

  topups(filter: { userId?: string; status?: CreditTopupStatus }): CreditTopupRequest[] {
    return this.repo.topups(filter).map((r) => this.topupDto(r));
  }

  // ── commands (HTTP) ───────────────────────────────────────────────────────
  /** Button-raised by the developer: a credit_topup decision for an approver other than the requester. */
  requestTopup(user: User, input: CreditTopupRequestInput): CreditTopupRequest {
    const decisions = this.ctx.services.maybe('decisions');
    if (!decisions)
      throw new HttpError(503, 'decisions_unavailable', 'The decision service is not available');
    if (this.ctx.config.credits.exemptUserIds.includes(user.id))
      throw new HttpError(409, 'exempt', 'You are exempt from the credit cap');
    const pending = this.repo.pendingTopup(user.id);
    if (pending)
      throw new HttpError(409, 'topup_pending', 'A top-up request is already waiting for approval', {
        requestId: pending.requestId,
      });
    const session = input.sessionId ? this.ownSession(user, input.sessionId) : null;
    const sessionId = input.sessionId ?? null;
    const period = this.currentPeriod();
    const s = this.state(user.id, period);
    const amountUsd = roundCents(input.amountUsd);
    const requestId = newId('topup', this.ctx.clock.now());
    const taskId = sessionId ? this.repo.lastCapTaskId(sessionId, period) : null;
    const actor: Actor = { kind: 'human', id: user.id };
    const card = decisions.request(
      {
        kind: 'credit_topup',
        title: 'Credit top-up request',
        question: `Approve a ${usd(amountUsd)} credit top-up for ${user.name}?`,
        options: [
          { id: APPROVE, label: 'Approve top-up' },
          { id: DENY, label: 'Deny' },
        ],
        context: `Reason: ${input.reason}\nBalance for ${period}: ${usd(s.balanceUsd)} (allocation ${usd(s.allocationUsd)} + granted ${usd(s.grantedUsd)} − used ${usd(s.usedUsd)}).`,
        subjectType: 'credit_topup',
        subjectId: requestId,
        sessionId,
        projectId: session?.projectId ?? null,
        // Separation of duties (§6): the requester never resolves their own top-up, escalated or not.
        requesterId: user.id,
        excludedApproverIds: [user.id],
        requiredRole: 'approver',
      },
      actor,
    );
    this.ctx.store.append({
      type: 'credit.topup_requested',
      actor,
      scope: {
        userId: user.id,
        sessionId: sessionId ?? undefined,
        taskId: taskId ?? undefined,
        projectId: session?.projectId ?? undefined,
        decisionId: card.id,
      },
      meta: { requestId, userId: user.id, period, amountUsd, sessionId, taskId, decisionId: card.id },
      payload: { reason: input.reason },
      source: 'api',
    });
    this.ctx.notify({
      kind: 'credit.topup',
      title: 'Credit top-up requested',
      audience: ['approver'],
      severity: 'info',
      refs: { requestId, decisionId: card.id, userId: user.id },
    });
    return this.topupDto(this.repo.topup(requestId)!);
  }

  allocate(by: User, input: CreditAllocationInput): CreditAccount {
    const current = this.currentPeriod();
    // Otherwise an approver could fund themselves around the top-up separation of duties.
    if (input.userId === by.id)
      throw new HttpError(403, 'separation_of_duties', 'Your own allocation must be set by another approver');
    if (input.period < current)
      throw new HttpError(
        422,
        'period_closed',
        `Period ${input.period} is closed (current period ${current})`,
      );
    const identity = this.ctx.services.maybe('identity');
    if (identity && !identity.getUser(input.userId))
      throw new HttpError(404, 'user_not_found', 'Unknown user');
    this.ctx.store.append({
      type: 'credit.allocated',
      actor: { kind: 'human', id: by.id },
      scope: { userId: input.userId },
      meta: {
        userId: input.userId,
        period: input.period,
        amountUsd: roundCents(input.amountUsd),
        allocatedBy: by.id,
      },
      source: 'api',
    });
    return this.account(input.userId, input.period);
  }

  // ── reactor handlers (idempotent: status check + one terminal idempotency key per request) ──
  onDecisionResolved(e: StoredEvent): void {
    const m = metaOf(e, 'decision.resolved');
    // Policy resolutions are the auto grant, already applied by checkBoundary.
    if (m.kind !== 'credit_topup' || m.method === 'policy') return;
    const req = this.repo.topupByDecision(m.decisionId);
    if (!req || req.status !== 'pending') return;
    // Defence in depth for separation of duties: a self-resolved top-up is never honoured.
    const approved = m.optionId === APPROVE && !m.selfApproved && m.resolvedBy !== req.userId;
    if (!approved) {
      this.ctx.store.append({
        type: 'credit.topup_denied',
        actor: MODULE_ACTOR,
        scope: requestScope(req),
        meta: {
          requestId: req.requestId,
          userId: req.userId,
          approverId: m.resolvedBy,
          decisionId: req.decisionId,
        },
        source: 'system',
        idempotencyKey: resolutionKey(req.requestId),
        causationId: e.id,
      });
      return;
    }
    // The top-up lands in the period of the approval, where the resumed work is metered.
    const period = localPeriod(Date.parse(e.ts), this.ctx.config.timezone);
    const before = this.state(req.userId, period).balanceUsd;
    this.ctx.store.append({
      type: 'credit.topup_granted',
      actor: MODULE_ACTOR,
      scope: requestScope(req),
      meta: {
        requestId: req.requestId,
        userId: req.userId,
        amountUsd: req.amountUsd,
        approverId: m.resolvedBy,
        balanceBefore: before,
        balanceAfter: roundUsd(before + req.amountUsd),
        decisionId: req.decisionId,
        period,
        sessionId: req.sessionId,
        taskId: req.taskId,
      },
      source: 'system',
      idempotencyKey: resolutionKey(req.requestId),
      causationId: e.id,
    });
  }

  /** A withdrawn or expired decision (e.g. its session ended) closes the request so the user can raise a new one. */
  onDecisionWithdrawn(e: StoredEvent): void {
    const decisionId = String(e.meta.decisionId);
    const reason = e.type === 'decision.expired' ? 'expired' : metaOf(e, 'decision.withdrawn').reason;
    const req = this.repo.topupByDecision(decisionId);
    if (!req || req.status !== 'pending') return;
    this.ctx.store.append({
      type: 'credit.topup_withdrawn',
      actor: MODULE_ACTOR,
      scope: requestScope(req),
      meta: { requestId: req.requestId, userId: req.userId, decisionId: req.decisionId, reason },
      source: 'system',
      idempotencyKey: resolutionKey(req.requestId),
      causationId: e.id,
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────
  private state(userId: string, period: string, usedUsd?: number): AccountState {
    const cfg = this.ctx.config.credits;
    const allocated = this.repo.allocation(userId, period);
    const allocationUsd = allocated ?? cfg.defaultMonthlyAllocationUsd;
    const grants = this.repo.grants(userId, period);
    const grantedUsd = roundUsd(grants.reduce((sum, g) => sum + g.amountUsd, 0));
    const used = usedUsd ?? this.usageByOwner(period, userId).get(userId) ?? 0;
    const autoGrantUsed = grants.some((g) => g.kind === 'auto');
    return {
      userId,
      period,
      allocationUsd,
      allocationSource: allocated === null ? 'default' : 'allocated',
      grants,
      grantedUsd,
      usedUsd: used,
      balanceUsd: balanceOf({ allocationUsd, grantedUsd, usedUsd: used }),
      autoGrantUsed,
      autoGrantUsd: autoGrantUsed ? 0 : autoGrantAmount(allocationUsd, cfg.autoGrantPct),
      exempt: cfg.exemptUserIds.includes(userId),
    };
  }

  /** Notional cost of the period's usage per session owner (metering's rate card for each local day). */
  private usageByOwner(period: string, onlyUserId?: string): Map<string, number> {
    const out = new Map<string, number>();
    const sessions = this.ctx.services.maybe('sessions');
    const groups = this.repo.usageGroups(period);
    if (!sessions || !groups.length) return out;
    const metering = this.metering();
    const owners = new Map<string, string | null>();
    for (const g of groups) {
      if (!owners.has(g.sessionId)) owners.set(g.sessionId, sessions.get(g.sessionId)?.ownerId ?? null);
      const owner = owners.get(g.sessionId);
      if (!owner || (onlyUserId !== undefined && owner !== onlyUserId)) continue;
      out.set(owner, (out.get(owner) ?? 0) + this.cost(metering, g));
    }
    for (const [k, v] of out) out.set(k, roundUsd(v));
    return out;
  }

  private metering(): MeteringService | null {
    const m = this.ctx.services.maybe('metering');
    if (!m && !this.warnedNoMetering) {
      this.warnedNoMetering = true;
      this.ctx.log.warn('credits: metering service unavailable; usage is costed at $0');
    }
    return m;
  }

  private cost(metering: MeteringService | null, g: UsageGroup): number {
    if (!metering) return 0;
    try {
      const c = metering.notionalCostUsd(g.model, g.totals, g.localDate);
      return Number.isFinite(c) && c > 0 ? c : 0;
    } catch (err) {
      this.ctx.log.error('credits: notional cost failed', {
        model: g.model,
        date: g.localDate,
        err: String(err),
      });
      return 0;
    }
  }

  /** Once per session/task while the funding is unchanged: after a grant, a renewed cap is a new event. */
  private recordCap(
    s: AccountState,
    session: SessionInfo,
    taskId: string | null,
    actor: Actor,
  ): { event: StoredEvent; fresh: boolean } {
    const key = `crd:cap:${JSON.stringify([s.period, session.sessionId, taskId, s.grants.length])}`;
    const existing = this.ctx.store.findByIdempotencyKey(key);
    if (existing) return { event: existing, fresh: false };
    const event = this.ctx.store.append({
      type: 'credit.cap_reached',
      actor,
      scope: this.sessionScope(s.userId, session, taskId),
      meta: {
        userId: s.userId,
        sessionId: session.sessionId,
        taskId,
        balanceUsd: s.balanceUsd,
        period: s.period,
      },
      source: 'system',
      idempotencyKey: key,
    });
    return { event, fresh: true };
  }

  /** The auto grant is recorded as a credit_topup decision resolved by policy, so every grant has the same audit trail. */
  private recordPolicyDecision(s: AccountState, session: SessionInfo, amountUsd: number): string | null {
    const decisions = this.ctx.services.maybe('decisions');
    if (!decisions) return null;
    const pct = this.ctx.config.credits.autoGrantPct;
    try {
      const card = decisions.request(
        {
          kind: 'credit_topup',
          title: 'Credit auto-grant (policy)',
          question: `First credit cap in ${s.period}: grant ${usd(amountUsd)} (${pct}% of the ${usd(s.allocationUsd)} allocation), once this period?`,
          options: [
            { id: APPROVE, label: 'Grant' },
            { id: DENY, label: 'Do not grant' },
          ],
          recommendation: {
            optionId: APPROVE,
            rationale: `Policy (§10): the first cap in a period is auto-granted ${pct}% of the original allocation, once.`,
          },
          subjectType: 'credit_account',
          subjectId: s.userId,
          sessionId: session.sessionId,
          projectId: session.projectId,
          requesterId: s.userId,
          requiredRole: 'approver',
        },
        POLICY_ACTOR,
      );
      decisions.resolveByPolicy(
        card.id,
        APPROVE,
        POLICY_ACTOR,
        'Auto-granted by policy: first cap this period.',
      );
      return card.id;
    } catch (err) {
      this.ctx.log.error('credits: auto-grant decision could not be recorded', {
        userId: s.userId,
        period: s.period,
        err: String(err),
      });
      return null;
    }
  }

  private sessionScope(userId: string, session: SessionInfo, taskId: string | null): Scope {
    return {
      userId,
      sessionId: session.sessionId,
      taskId: taskId ?? undefined,
      projectId: session.projectId ?? undefined,
    };
  }

  private ownSession(user: User, sessionId: string): SessionInfo | null {
    const dir = this.ctx.services.maybe('sessions');
    if (!dir) return null;
    const session = dir.get(sessionId);
    if (!session) throw new HttpError(404, 'session_not_found', 'Unknown session');
    if (session.ownerId !== user.id)
      throw new HttpError(403, 'forbidden', 'Top-ups can only be requested for your own sessions');
    return session;
  }

  /** A pending request lands in whichever period is current at approval, so only the current account shows it. */
  private pendingFor(userId: string, period: string): TopupRow | null {
    return period === this.currentPeriod() ? this.repo.pendingTopup(userId) : null;
  }

  private ageMs(r: TopupRow): number {
    const end = r.resolvedAt ? Date.parse(r.resolvedAt) : this.ctx.clock.now();
    return Math.max(0, end - Date.parse(r.createdAt));
  }

  private userName(userId: string): string | null {
    return this.ctx.services.maybe('identity')?.getUser(userId)?.name ?? null;
  }

  private topupDto(r: TopupRow): CreditTopupRequest {
    return { ...r, userName: this.userName(r.userId), ageMs: this.ageMs(r) };
  }
}

function requestScope(r: TopupRow): Scope {
  return {
    userId: r.userId,
    decisionId: r.decisionId,
    sessionId: r.sessionId ?? undefined,
    taskId: r.taskId ?? undefined,
  };
}
