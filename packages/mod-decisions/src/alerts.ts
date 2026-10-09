import {
  DECISION_KIND_LABEL,
  DECISION_TEST_INFO,
  TESTED_DECISION_KINDS,
  type DecisionCard,
  type DecisionWebhookPayload,
  type Notification,
  type Role,
} from '@aoc/contracts';
import type { ModuleContext } from '@aoc/kernel';
import type { DecisionEngine } from './engine';

const NOTICES_DDL = `CREATE TABLE IF NOT EXISTS dec_notices (
  decision_id TEXT NOT NULL,
  notice TEXT NOT NULL,
  n INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (decision_id, notice, n)
)`;

export interface AlertOptions {
  /** fetch used for the opt-in webhook (tests inject a mock). Default: global fetch. */
  fetchImpl?: typeof fetch;
  /** Webhook request timeout. Default 5000 ms. */
  webhookTimeoutMs?: number;
}

/** Internal notifications go to the roles that can act; requesters never receive them (UAT reaches them via the portal). */
function audienceFor(role: Role): Role[] {
  if (role === 'approver') return ['approver'];
  if (role === 'builder') return ['builder', 'approver'];
  return [];
}

/** Fixed labels only — notifications never carry decision text. */
function headline(card: DecisionCard): string {
  const kind = DECISION_KIND_LABEL[card.kind];
  return card.test && TESTED_DECISION_KINDS.has(card.kind) ? `${kind} — ${DECISION_TEST_INFO[card.test].label}` : kind;
}

function refsOf(card: DecisionCard): Record<string, string> {
  return {
    decisionId: card.id,
    kind: card.kind,
    ...(card.sessionId ? { sessionId: card.sessionId } : {}),
    ...(card.projectId ? { projectId: card.projectId } : {}),
  };
}

export function formatAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/**
 * In-page notifications, the opt-in webhook and aging reminders (R15). Delivery bookkeeping lives in
 * `dec_notices`, a non-chained operational table (like the kernel's job_runs): it makes the reactor
 * idempotent and survives projection rebuilds, so nobody is notified twice.
 */
export class DecisionAlerts {
  constructor(
    private readonly ctx: ModuleContext,
    private readonly engine: DecisionEngine,
    private readonly opts: AlertOptions = {},
  ) {
    ctx.db.exec(NOTICES_DDL);
  }

  /** decision.requested → decision.new for the roles that can act on it. */
  onRequested(decisionId: string): void {
    const card = this.engine.get(decisionId);
    // A card already closed when the reaction runs (e.g. a policy auto-grant) needs nobody's attention.
    if (!card || card.status !== 'open' || card.requiredRole === 'requester') return;
    if (!this.claim(card.id, 'new', 0)) return;
    this.notify(card, {
      kind: 'decision.new',
      title: `Decision needed: ${headline(card)}`,
      audience: audienceFor(card.requiredRole),
      severity: card.kind === 'break_glass' ? 'danger' : card.requiredRole === 'approver' ? 'warn' : 'info',
    });
    this.webhook('decision.new', card, 0);
  }

  /** decision.escalated → the Approvers hear about it (the requester stays excluded). */
  onEscalated(decisionId: string, seq: number): void {
    const card = this.engine.get(decisionId);
    if (!card || card.status !== 'open' || card.requiredRole === 'requester') return;
    if (!this.claim(card.id, 'escalated', seq)) return;
    this.notify(card, {
      kind: 'decision.new',
      title: `Decision escalated: ${headline(card)}`,
      audience: audienceFor(card.requiredRole),
      severity: 'warn',
    });
  }

  /** One reminder per elapsed multiple of remindAfterMinutes while a card stays open; missed multiples are not replayed. */
  remindAging(): number {
    const everyMs = this.ctx.config.decisions.remindAfterMinutes * 60_000;
    const now = this.ctx.clock.now();
    let sent = 0;
    for (const card of this.engine.list({ status: ['open'], limit: 10_000 })) {
      if (card.requiredRole === 'requester') continue;
      const ageMs = Math.max(0, now - Date.parse(card.createdAt));
      const multiple = Math.floor(ageMs / everyMs);
      if (multiple < 1 || multiple <= this.lastReminder(card.id) || !this.claim(card.id, 'aging', multiple))
        continue;
      const overdue = card.dueAt !== null && Date.parse(card.dueAt) < now;
      this.notify(card, {
        kind: 'decision.aging',
        title: `Waiting ${formatAge(ageMs)}: ${headline(card)}`,
        audience: audienceFor(card.requiredRole),
        severity: overdue || card.kind === 'break_glass' ? 'danger' : 'warn',
      });
      this.webhook('decision.aging', card, multiple, ageMs);
      sent++;
    }
    return sent;
  }

  private notify(
    card: DecisionCard,
    n: Pick<Notification, 'kind' | 'title' | 'audience' | 'severity'>,
  ): void {
    this.ctx.notify({ ...n, link: `/decisions/${card.id}`, refs: refsOf(card) });
  }

  private claim(decisionId: string, notice: string, n: number): boolean {
    const r = this.ctx.db
      .prepare('INSERT OR IGNORE INTO dec_notices (decision_id, notice, n, at) VALUES (?,?,?,?)')
      .run(decisionId, notice, n, this.ctx.clock.iso());
    return Number(r.changes) > 0;
  }

  private lastReminder(decisionId: string): number {
    const r = this.ctx.db
      .prepare("SELECT MAX(n) AS n FROM dec_notices WHERE decision_id = ? AND notice = 'aging'")
      .get(decisionId) as { n: number | null } | undefined;
    return r?.n ?? 0;
  }

  /**
   * Opt-in webhook (config.decisions.webhookUrl). The body is built field by field from ids, enums and
   * ages — never titles, questions, options or comments (PDPA). Fire-and-forget with a timeout: a slow or
   * failing receiver never blocks the reactor, the job or a request.
   */
  private webhook(
    type: DecisionWebhookPayload['type'],
    card: DecisionCard,
    reminder: number,
    ageMs?: number,
  ): void {
    const url = this.ctx.config.decisions.webhookUrl;
    if (!url) return;
    const body: DecisionWebhookPayload = {
      type,
      decisionId: card.id,
      kind: card.kind,
      requiredRole: card.requiredRole,
      requiresPasskey: card.requiresPasskey,
      sessionId: card.sessionId,
      projectId: card.projectId,
      createdAt: card.createdAt,
      ageMs: ageMs ?? Math.max(0, this.ctx.clock.now() - Date.parse(card.createdAt)),
      reminder,
      link: `${this.ctx.config.publicUrl.replace(/\/+$/, '')}/decisions/${card.id}`,
      sentAt: this.ctx.clock.iso(),
    };
    const fetchImpl = this.opts.fetchImpl ?? globalThis.fetch;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.opts.webhookTimeoutMs ?? 5000);
    timer.unref();
    const log = this.ctx.log;
    void Promise.resolve()
      .then(() =>
        fetchImpl(url, {
          method: 'POST',
          // A redirect would let the receiver point aocd at internal endpoints: a 3xx is just a failed delivery.
          redirect: 'manual',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: ac.signal,
        }),
      )
      .then(async (res) => {
        if (!res.ok) log.warn('decision webhook rejected', { decisionId: card.id, type, status: res.status });
        await res.body?.cancel();
      })
      .catch((err: unknown) => {
        const reason = ac.signal.aborted ? 'timeout' : String(err).slice(0, 200);
        log.warn('decision webhook failed', { decisionId: card.id, type, reason });
      })
      .finally(() => clearTimeout(timer));
  }
}
