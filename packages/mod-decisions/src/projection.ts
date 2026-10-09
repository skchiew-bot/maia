import type { DatabaseSync } from 'node:sqlite';
import {
  resolutionAssurance,
  type DecisionCard,
  type DecisionKind,
  type DecisionOption,
  type DecisionStatus,
  type DecisionTest,
  type JsonValue,
  type MetaOf,
  type PayloadOf,
  type Role,
  type StoredEvent,
} from '@aoc/contracts';
import type { Projector } from '@aoc/kernel';

/** Shown wherever free text came from a crypto-shredded body (§13). */
export const ERASED = '[erased]';

const TABLE = 'dec_decisions';

const DDL = [
  `CREATE TABLE IF NOT EXISTS ${TABLE} (
    id TEXT PRIMARY KEY,
    requested_seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    test TEXT,
    title TEXT NOT NULL,
    question TEXT NOT NULL,
    options_json TEXT NOT NULL,
    recommendation_json TEXT,
    context TEXT,
    required_role TEXT NOT NULL,
    requires_passkey INTEGER NOT NULL,
    requester_id TEXT NOT NULL,
    excluded_json TEXT NOT NULL,
    eligible_json TEXT,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    session_id TEXT,
    project_id TEXT,
    raised_by_kind TEXT NOT NULL,
    raised_by_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    due_at TEXT,
    body_scope TEXT,
    erased INTEGER NOT NULL DEFAULT 0,
    escalated_to TEXT,
    escalated_at TEXT,
    escalation_reason TEXT,
    resolved_option_id TEXT,
    resolved_by TEXT,
    resolved_at TEXT,
    resolution_method TEXT,
    passkey_verified INTEGER,
    self_approved INTEGER,
    resolution_comment TEXT,
    resolution_age_ms INTEGER,
    resolution_body_scope TEXT,
    withdrawn_by TEXT,
    withdrawn_at TEXT,
    withdraw_reason TEXT,
    withdraw_note TEXT,
    withdraw_body_scope TEXT,
    closed_at TEXT,
    closed_seq INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS dec_decisions_status ON ${TABLE}(status, requested_seq)`,
  `CREATE INDEX IF NOT EXISTS dec_decisions_kind ON ${TABLE}(kind, status)`,
  `CREATE INDEX IF NOT EXISTS dec_decisions_session ON ${TABLE}(session_id, status)`,
  `CREATE INDEX IF NOT EXISTS dec_decisions_project ON ${TABLE}(project_id, status)`,
  `CREATE INDEX IF NOT EXISTS dec_decisions_subject ON ${TABLE}(subject_type, subject_id)`,
  `CREATE INDEX IF NOT EXISTS dec_decisions_body_scope ON ${TABLE}(body_scope)`,
];

/** Projection row plus the bits the API needs that DecisionCard does not carry. */
export interface DecisionRecord {
  card: DecisionCard;
  /** Body scope of the request payload (resolution/withdrawal bodies use the same scope). */
  bodyScope: string | null;
  closedAt: string | null;
  erased: boolean;
  escalation: { toRole: Role; reason: string; at: string } | null;
  withdrawal: { reason: string; by: string; at: string; note: string | null } | null;
}

interface Row {
  id: string;
  kind: string;
  status: string;
  test: string | null;
  title: string;
  question: string;
  options_json: string;
  recommendation_json: string | null;
  context: string | null;
  required_role: string;
  requires_passkey: number;
  requester_id: string;
  excluded_json: string;
  eligible_json: string | null;
  subject_type: string;
  subject_id: string;
  session_id: string | null;
  project_id: string | null;
  created_at: string;
  due_at: string | null;
  body_scope: string | null;
  erased: number;
  escalated_to: string | null;
  escalated_at: string | null;
  escalation_reason: string | null;
  resolved_option_id: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_method: string | null;
  passkey_verified: number | null;
  self_approved: number | null;
  resolution_comment: string | null;
  withdrawn_by: string | null;
  withdrawn_at: string | null;
  withdraw_reason: string | null;
  withdraw_note: string | null;
  closed_at: string | null;
}

type RequestedMeta = MetaOf<'decision.requested'>;
type RequestedPayload = PayloadOf<'decision.requested'>;

const erasedOptions = (ids: string[]): DecisionOption[] => ids.map((id) => ({ id, label: ERASED }));

function applyRequested(db: DatabaseSync, e: StoredEvent, payload: RequestedPayload | null): void {
  const m = e.meta as unknown as RequestedMeta;
  const options: DecisionOption[] = payload
    ? payload.options.map((o) =>
        o.description === undefined
          ? { id: o.id, label: o.label }
          : { id: o.id, label: o.label, description: o.description },
      )
    : erasedOptions(m.optionIds);
  const recommendation = payload?.recommendation
    ? { optionId: payload.recommendation.optionId, rationale: payload.recommendation.rationale }
    : m.recommendedOptionId
      ? { optionId: m.recommendedOptionId, rationale: payload ? '' : ERASED }
      : null;
  db.prepare(
    `INSERT INTO ${TABLE} (id, requested_seq, kind, status, test, title, question, options_json, recommendation_json, context,
       required_role, requires_passkey, requester_id, excluded_json, eligible_json, subject_type, subject_id, session_id, project_id,
       raised_by_kind, raised_by_id, created_at, due_at, body_scope, erased)
     VALUES (?,?,?,'open',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    m.decisionId,
    e.seq,
    m.kind,
    m.test,
    payload ? payload.title : ERASED,
    payload ? payload.question : ERASED,
    JSON.stringify(options),
    recommendation ? JSON.stringify(recommendation) : null,
    payload ? (payload.context ?? null) : ERASED,
    m.requiredRole,
    m.requiresPasskey ? 1 : 0,
    m.requesterId,
    JSON.stringify(m.excludedApproverIds),
    m.eligibleUserIds ? JSON.stringify(m.eligibleUserIds) : null,
    m.subjectType,
    m.subjectId,
    m.sessionId,
    m.projectId,
    e.actor.kind,
    e.actor.id,
    e.ts,
    m.dueAt,
    e.bodyScope,
    payload ? 0 : 1,
  );
}

/** A body that existed (payloadHash set) but can no longer be read was crypto-shredded. */
function bodyText(e: StoredEvent, payload: JsonValue | null, key: string): string | null {
  if (payload === null) return e.payloadHash ? ERASED : null;
  const v = (payload as Record<string, JsonValue>)[key];
  return typeof v === 'string' ? v : null;
}

function applyResolved(db: DatabaseSync, e: StoredEvent, payload: JsonValue | null): void {
  const m = e.meta as unknown as MetaOf<'decision.resolved'>;
  db.prepare(
    `UPDATE ${TABLE} SET status = 'resolved', resolved_option_id = ?, resolved_by = ?, resolved_at = ?, resolution_method = ?,
       passkey_verified = ?, self_approved = ?, resolution_comment = ?, resolution_age_ms = ?, resolution_body_scope = ?,
       closed_at = ?, closed_seq = ?
     WHERE id = ? AND status = 'open'`,
  ).run(
    m.optionId,
    m.resolvedBy,
    e.ts,
    m.method,
    m.passkeyVerified ? 1 : 0,
    m.selfApproved ? 1 : 0,
    bodyText(e, payload, 'comment'),
    m.ageMs,
    e.bodyScope,
    e.ts,
    e.seq,
    m.decisionId,
  );
}

function applyWithdrawn(db: DatabaseSync, e: StoredEvent, payload: JsonValue | null): void {
  const m = e.meta as unknown as MetaOf<'decision.withdrawn'>;
  // Logs written before decision.expired was emitted expire cards as a withdrawal labelled `expired`.
  const status: DecisionStatus = m.reason === 'expired' ? 'expired' : 'withdrawn';
  db.prepare(
    `UPDATE ${TABLE} SET status = ?, withdrawn_by = ?, withdrawn_at = ?, withdraw_reason = ?, withdraw_note = ?, withdraw_body_scope = ?,
       closed_at = ?, closed_seq = ?
     WHERE id = ? AND status = 'open'`,
  ).run(
    status,
    e.actor.id,
    e.ts,
    m.reason,
    bodyText(e, payload, 'note'),
    e.bodyScope,
    e.ts,
    e.seq,
    m.decisionId,
  );
}

function applyExpired(db: DatabaseSync, e: StoredEvent): void {
  const m = e.meta as unknown as MetaOf<'decision.expired'>;
  db.prepare(
    `UPDATE ${TABLE} SET status = 'expired', closed_at = ?, closed_seq = ? WHERE id = ? AND status = 'open'`,
  ).run(e.ts, e.seq, m.decisionId);
}

function applyEscalated(db: DatabaseSync, e: StoredEvent): void {
  const m = e.meta as unknown as MetaOf<'decision.escalated'>;
  // Escalation only ever raises Builder → Approver (never lowers, never routes to the requester role).
  // The card then goes to every Approver, so a Builder-only eligibility list no longer applies.
  if (m.toRole !== 'approver') return;
  db.prepare(
    `UPDATE ${TABLE} SET required_role = 'approver', eligible_json = NULL, escalated_to = 'approver', escalated_at = ?, escalation_reason = ?
     WHERE id = ? AND status = 'open' AND required_role = 'builder'`,
  ).run(e.ts, m.reason, m.decisionId);
}

/** Scrub every free-text column whose body lived in an erased scope (mirrors what a rebuild produces). */
function eraseScope(db: DatabaseSync, scopeId: string): void {
  const rows = db
    .prepare(`SELECT id, options_json, recommendation_json FROM ${TABLE} WHERE body_scope = ?`)
    .all(scopeId) as unknown as Pick<Row, 'id' | 'options_json' | 'recommendation_json'>[];
  const update = db.prepare(
    `UPDATE ${TABLE} SET title = ?, question = ?, context = ?, options_json = ?, recommendation_json = ?, erased = 1 WHERE id = ?`,
  );
  for (const r of rows) {
    const ids = (JSON.parse(r.options_json) as DecisionOption[]).map((o) => o.id);
    const rec = r.recommendation_json ? (JSON.parse(r.recommendation_json) as { optionId: string }) : null;
    update.run(
      ERASED,
      ERASED,
      ERASED,
      JSON.stringify(erasedOptions(ids)),
      rec ? JSON.stringify({ optionId: rec.optionId, rationale: ERASED }) : null,
      r.id,
    );
  }
  db.prepare(`UPDATE ${TABLE} SET resolution_comment = ? WHERE resolution_body_scope = ?`).run(
    ERASED,
    scopeId,
  );
  db.prepare(`UPDATE ${TABLE} SET withdraw_note = ? WHERE withdraw_body_scope = ?`).run(ERASED, scopeId);
}

export const DECISION_EVENT_TYPES = [
  'decision.requested',
  'decision.resolved',
  'decision.withdrawn',
  'decision.expired',
  'decision.escalated',
] as const;

export function createDecisionsProjector(): Projector {
  return {
    name: 'decisions',
    tables: [TABLE],
    ddl: DDL,
    handles: DECISION_EVENT_TYPES,
    apply({ db }, e, payload) {
      switch (e.type) {
        case 'decision.requested':
          return applyRequested(db, e, payload as RequestedPayload | null);
        case 'decision.resolved':
          return applyResolved(db, e, payload);
        case 'decision.withdrawn':
          return applyWithdrawn(db, e, payload);
        case 'decision.expired':
          return applyExpired(db, e);
        case 'decision.escalated':
          return applyEscalated(db, e);
      }
    },
    onErase: eraseScope,
  };
}

function toRecord(r: Row): DecisionRecord {
  const status = r.status as DecisionStatus;
  const card: DecisionCard = {
    id: r.id,
    kind: r.kind as DecisionKind,
    status,
    test: r.test as DecisionTest | null,
    title: r.title,
    question: r.question,
    options: JSON.parse(r.options_json) as DecisionOption[],
    recommendation: r.recommendation_json
      ? (JSON.parse(r.recommendation_json) as DecisionCard['recommendation'])
      : null,
    context: r.context,
    requiredRole: r.required_role as Role,
    requiresPasskey: r.requires_passkey === 1,
    requesterId: r.requester_id,
    excludedApproverIds: JSON.parse(r.excluded_json) as string[],
    eligibleUserIds: r.eligible_json ? (JSON.parse(r.eligible_json) as string[]) : null,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    sessionId: r.session_id,
    projectId: r.project_id,
    createdAt: r.created_at,
    dueAt: r.due_at,
    resolution:
      status === 'resolved' && r.resolved_option_id !== null
        ? {
            optionId: r.resolved_option_id,
            resolvedBy: r.resolved_by ?? '',
            resolvedAt: r.resolved_at ?? r.closed_at ?? r.created_at,
            method: r.resolution_method as 'button' | 'passkey' | 'policy',
            passkeyVerified: r.passkey_verified === 1,
            assurance: resolutionAssurance({
              method: r.resolution_method as 'button' | 'passkey' | 'policy',
              passkeyVerified: r.passkey_verified === 1,
            }),
            selfApproved: r.self_approved === 1,
            comment: r.resolution_comment,
          }
        : null,
  };
  return {
    card,
    bodyScope: r.body_scope,
    closedAt: r.closed_at,
    erased: r.erased === 1,
    escalation:
      r.escalated_to !== null
        ? {
            toRole: r.escalated_to as Role,
            reason: r.escalation_reason ?? '',
            at: r.escalated_at ?? r.created_at,
          }
        : null,
    withdrawal:
      r.withdrawn_at !== null
        ? {
            reason: r.withdraw_reason ?? '',
            by: r.withdrawn_by ?? '',
            at: r.withdrawn_at,
            note: r.withdraw_note,
          }
        : null,
  };
}

export interface RecordQuery {
  status?: DecisionStatus[];
  kind?: DecisionKind[];
  sessionId?: string;
  projectId?: string;
  subjectId?: string;
  /** null = no limit. */
  limit: number | null;
}

/** Read side of the `decisions` projection. */
export class DecisionReadModel {
  constructor(private readonly db: DatabaseSync) {}

  get(id: string): DecisionRecord | null {
    const row = this.db.prepare(`SELECT * FROM ${TABLE} WHERE id = ?`).get(id) as unknown as Row | undefined;
    return row ? toRecord(row) : null;
  }

  /** Open cards first (oldest first), then closed cards (most recently closed first). */
  list(q: RecordQuery): DecisionRecord[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const inList = (col: string, values: readonly string[]) => {
      where.push(`${col} IN (${values.map(() => '?').join(',')})`);
      args.push(...values);
    };
    if (q.status?.length) inList('status', q.status);
    if (q.kind?.length) inList('kind', q.kind);
    if (q.sessionId) (where.push('session_id = ?'), args.push(q.sessionId));
    if (q.projectId) (where.push('project_id = ?'), args.push(q.projectId));
    if (q.subjectId) (where.push('subject_id = ?'), args.push(q.subjectId));
    let sql =
      `SELECT * FROM ${TABLE} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ` +
      `ORDER BY CASE WHEN status = 'open' THEN 0 ELSE 1 END, CASE WHEN status = 'open' THEN requested_seq END ASC, closed_seq DESC`;
    if (q.limit !== null) {
      sql += ' LIMIT ?';
      args.push(q.limit);
    }
    return (this.db.prepare(sql).all(...args) as unknown as Row[]).map(toRecord);
  }

  /** Resolution timestamps of policy-resolved cards of a kind raised for a requester. */
  policyResolutionTimes(kind: DecisionKind, requesterId: string): string[] {
    const rows = this.db
      .prepare(
        `SELECT resolved_at FROM ${TABLE} WHERE kind = ? AND requester_id = ? AND resolution_method = 'policy' AND status = 'resolved'`,
      )
      .all(kind, requesterId) as unknown as { resolved_at: string }[];
    return rows.map((r) => r.resolved_at);
  }
}
