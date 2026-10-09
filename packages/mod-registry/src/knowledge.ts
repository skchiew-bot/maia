/**
 * Team knowledge layer (§14): resolved bugs, approved playbooks, bound lessons and decisions resolved
 * with a comment become searchable institutional memory (SQLite FTS5, bm25-ranked).
 *
 * Privacy: only engineering knowledge is indexed — a ticket contributes its diagnosis (root cause + fix
 * plan), never the requester's title, description, comment or media; decisions about tickets, UAT
 * sign-offs and credit top-ups are not indexed at all. Each document is linked to the body scopes it
 * was built from plus its own entity id, and erasing any of those scopes removes it — live (onErase) and
 * on replay (`body.erased`), so a rebuild reproduces exactly the post-erasure index.
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  DecisionKind,
  JsonValue,
  KnowledgeKind,
  KnowledgeRefs,
  KnowledgeResult,
  KnowledgeSearchResponse,
  KnowledgeSnippetPart,
  MetaOf,
  PayloadOf,
  StoredEvent,
} from '@aoc/contracts';
import type { Projector } from '@aoc/kernel';

const TABLES = [
  'reg_knowledge',
  'reg_kn_docs',
  'reg_kn_links',
  'reg_kn_diagnoses',
  'reg_kn_fixplans',
  'reg_kn_playbooks',
  'reg_kn_lessons',
  'reg_kn_decisions',
];

/** Decision kinds whose resolution is reusable engineering knowledge. */
const INDEXED_DECISION_KINDS: ReadonlySet<DecisionKind> = new Set<DecisionKind>([
  'agent_decision',
  'protected_operation',
  'change_request',
  'go_live',
  'rollback',
  'break_glass',
]);

const MAX_BODY = 20_000;
const HIT_OPEN = '\u0002';
const HIT_CLOSE = '\u0003';

/** Strip control characters (they would collide with the snippet markers) and bound the size. */
function clean(s: string | null | undefined, max = MAX_BODY): string {
  if (!s) return '';
  const t = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function firstLine(s: string, max: number): string {
  return clean(s.split('\n').find((l) => l.trim()) ?? s, max);
}

interface Doc {
  docId: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  refs: KnowledgeRefs;
  date: string;
  /** Body scopes and entity ids whose erasure must remove this document. */
  links: (string | null | undefined)[];
}

function upsertDoc(db: DatabaseSync, d: Doc): void {
  const existing = db.prepare('SELECT k FROM reg_kn_docs WHERE doc_id = ?').get(d.docId) as
    { k: number } | undefined;
  let k: number;
  if (existing) {
    k = existing.k;
    db.prepare('DELETE FROM reg_knowledge WHERE rowid = ?').run(k);
    db.prepare('UPDATE reg_kn_docs SET kind = ?, title = ?, refs_json = ?, date = ? WHERE k = ?').run(
      d.kind,
      d.title,
      JSON.stringify(d.refs),
      d.date,
      k,
    );
  } else {
    k = Number(
      db
        .prepare('INSERT INTO reg_kn_docs (doc_id, kind, title, refs_json, date) VALUES (?,?,?,?,?)')
        .run(d.docId, d.kind, d.title, JSON.stringify(d.refs), d.date).lastInsertRowid,
    );
  }
  db.prepare('INSERT INTO reg_knowledge (rowid, title, body) VALUES (?,?,?)').run(k, d.title, d.body);
  db.prepare('DELETE FROM reg_kn_links WHERE doc_id = ?').run(d.docId);
  for (const link of new Set(d.links.filter((l): l is string => !!l))) {
    db.prepare('INSERT INTO reg_kn_links (doc_id, scope_id) VALUES (?,?)').run(d.docId, link);
  }
}

function deleteDoc(db: DatabaseSync, docId: string): void {
  const row = db.prepare('SELECT k FROM reg_kn_docs WHERE doc_id = ?').get(docId) as
    { k: number } | undefined;
  if (!row) return;
  db.prepare('DELETE FROM reg_knowledge WHERE rowid = ?').run(row.k);
  db.prepare('DELETE FROM reg_kn_docs WHERE k = ?').run(row.k);
  db.prepare('DELETE FROM reg_kn_links WHERE doc_id = ?').run(docId);
}

/** Remove every document and pending (staged) knowledge derived from an erased scope. */
function eraseScope(db: DatabaseSync, scopeId: string): void {
  const docs = db.prepare('SELECT DISTINCT doc_id FROM reg_kn_links WHERE scope_id = ?').all(scopeId) as {
    doc_id: string;
  }[];
  for (const d of docs) deleteDoc(db, d.doc_id);
  // An FTS5 delete only adds tombstones: the erased terms stay in live index segments until a merge rewrites
  // them. Merge now so they leave the index pages (the kernel's secure_delete then zeroes the freed pages).
  if (docs.length) db.exec("INSERT INTO reg_knowledge(reg_knowledge) VALUES('optimize')");
  db.prepare('DELETE FROM reg_kn_diagnoses WHERE body_scope = ? OR ticket_id = ?').run(scopeId, scopeId);
  db.prepare('DELETE FROM reg_kn_fixplans WHERE ticket_id = ?').run(scopeId);
  db.prepare('DELETE FROM reg_kn_playbooks WHERE body_scope = ? OR playbook_id = ?').run(scopeId, scopeId);
  db.prepare('DELETE FROM reg_kn_lessons WHERE body_scope = ? OR lesson_id = ?').run(scopeId, scopeId);
  db.prepare('DELETE FROM reg_kn_decisions WHERE body_scope = ? OR decision_id = ?').run(scopeId, scopeId);
}

export function createKnowledgeProjector(): Projector {
  return {
    name: 'registry.knowledge',
    tables: TABLES,
    ddl: [
      `CREATE TABLE IF NOT EXISTS reg_kn_docs (
        k INTEGER PRIMARY KEY,
        doc_id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        refs_json TEXT NOT NULL,
        date TEXT NOT NULL
      )`,
      'CREATE INDEX IF NOT EXISTS reg_kn_docs_kind ON reg_kn_docs(kind)',
      // rowid = reg_kn_docs.k
      "CREATE VIRTUAL TABLE IF NOT EXISTS reg_knowledge USING fts5(title, body, tokenize = 'porter unicode61 remove_diacritics 2')",
      'CREATE TABLE IF NOT EXISTS reg_kn_links (doc_id TEXT NOT NULL, scope_id TEXT NOT NULL, PRIMARY KEY (doc_id, scope_id))',
      'CREATE INDEX IF NOT EXISTS reg_kn_links_scope ON reg_kn_links(scope_id)',
      // Staging: knowledge that is not yet established (open ticket, pending playbook / lesson / decision).
      `CREATE TABLE IF NOT EXISTS reg_kn_diagnoses (
        ticket_id TEXT NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL, confidence REAL NOT NULL,
        root_cause_class TEXT, root_cause TEXT, fix_plan TEXT, affected_json TEXT, project_id TEXT, body_scope TEXT,
        PRIMARY KEY (ticket_id, session_id)
      )`,
      'CREATE TABLE IF NOT EXISTS reg_kn_fixplans (ticket_id TEXT PRIMARY KEY, source_session_id TEXT)',
      `CREATE TABLE IF NOT EXISTS reg_kn_playbooks (
        playbook_id TEXT PRIMARY KEY, process_type TEXT NOT NULL, version INTEGER NOT NULL, project_id TEXT, source_session_id TEXT,
        title TEXT, steps_json TEXT, rationale TEXT, body_scope TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS reg_kn_lessons (
        lesson_id TEXT PRIMARY KEY, scope_type TEXT NOT NULL, scope_value TEXT NOT NULL, rule TEXT, fix TEXT, rationale TEXT, body_scope TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS reg_kn_decisions (
        decision_id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT, project_id TEXT,
        title TEXT, question TEXT, options_json TEXT, body_scope TEXT
      )`,
    ],
    handles: [
      'ticket.diagnosis_reported',
      'ticket.fix_plan_submitted',
      'ticket.closed',
      'playbook.proposed',
      'playbook.approved',
      'playbook.rejected',
      'playbook.retired',
      'lesson.proposed',
      'lesson.bound',
      'lesson.rejected',
      'lesson.retired',
      'decision.requested',
      'decision.resolved',
      'decision.withdrawn',
      'body.erased',
    ],
    apply({ db }, e, payload) {
      applyKnowledge(db, e, payload);
    },
    onErase(db, scopeId) {
      eraseScope(db, scopeId);
    },
  };
}

function applyKnowledge(db: DatabaseSync, e: StoredEvent, payload: JsonValue | null): void {
  switch (e.type) {
    // ── resolved tickets: diagnosis only ──────────────────────────────────
    case 'ticket.diagnosis_reported': {
      const m = e.meta as MetaOf<'ticket.diagnosis_reported'>;
      const p = payload as PayloadOf<'ticket.diagnosis_reported'> | null;
      db.prepare(
        `INSERT INTO reg_kn_diagnoses (ticket_id, session_id, seq, confidence, root_cause_class, root_cause, fix_plan, affected_json, project_id, body_scope)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(ticket_id, session_id) DO UPDATE SET seq = excluded.seq, confidence = excluded.confidence, root_cause_class = excluded.root_cause_class,
           root_cause = excluded.root_cause, fix_plan = excluded.fix_plan, affected_json = excluded.affected_json, body_scope = excluded.body_scope`,
      ).run(
        m.ticketId,
        m.sessionId,
        e.seq,
        m.confidence,
        m.rootCauseClass,
        p?.rootCause ?? null,
        p?.fixPlan ?? null,
        p?.affectedAreas ? JSON.stringify(p.affectedAreas) : null,
        e.scope.projectId ?? null,
        e.bodyScope,
      );
      return;
    }
    case 'ticket.fix_plan_submitted': {
      const m = e.meta as MetaOf<'ticket.fix_plan_submitted'>;
      db.prepare(
        'INSERT INTO reg_kn_fixplans (ticket_id, source_session_id) VALUES (?,?) ON CONFLICT(ticket_id) DO UPDATE SET source_session_id = excluded.source_session_id',
      ).run(m.ticketId, m.sourceSessionId);
      return;
    }
    case 'ticket.closed': {
      const m = e.meta as MetaOf<'ticket.closed'>;
      if (m.resolution === 'fixed') indexTicket(db, m.ticketId, e);
      db.prepare('DELETE FROM reg_kn_diagnoses WHERE ticket_id = ?').run(m.ticketId);
      db.prepare('DELETE FROM reg_kn_fixplans WHERE ticket_id = ?').run(m.ticketId);
      return;
    }
    // ── playbooks: searchable once approved ───────────────────────────────
    case 'playbook.proposed': {
      const m = e.meta as MetaOf<'playbook.proposed'>;
      const p = payload as PayloadOf<'playbook.proposed'> | null;
      if (!p) return;
      db.prepare(
        `INSERT INTO reg_kn_playbooks (playbook_id, process_type, version, project_id, source_session_id, title, steps_json, rationale, body_scope)
         VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(playbook_id) DO NOTHING`,
      ).run(
        m.playbookId,
        m.processType,
        m.version,
        e.scope.projectId ?? null,
        m.sourceSessionId,
        p.title,
        JSON.stringify(p.steps),
        p.rationale ?? null,
        e.bodyScope,
      );
      return;
    }
    case 'playbook.approved': {
      const m = e.meta as MetaOf<'playbook.approved'>;
      const pb = db.prepare('SELECT * FROM reg_kn_playbooks WHERE playbook_id = ?').get(m.playbookId) as
        | {
            playbook_id: string;
            process_type: string;
            version: number;
            project_id: string | null;
            source_session_id: string | null;
            title: string;
            steps_json: string;
            rationale: string | null;
            body_scope: string | null;
          }
        | undefined;
      if (!pb) return;
      const steps = JSON.parse(pb.steps_json) as { title: string; detail?: string }[];
      upsertDoc(db, {
        docId: `playbook:${pb.playbook_id}`,
        kind: 'playbook',
        title: clean(`${pb.title} (v${pb.version})`, 300),
        body: clean(
          [
            `Process type: ${pb.process_type}`,
            ...steps.map((s, i) => `${i + 1}. ${s.title}${s.detail ? ` — ${s.detail}` : ''}`),
            pb.rationale ? `Rationale: ${pb.rationale}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        ),
        refs: compact({
          playbookId: pb.playbook_id,
          processType: pb.process_type,
          sessionId: pb.source_session_id,
          projectId: pb.project_id,
        }),
        date: e.ts,
        links: [pb.playbook_id, pb.body_scope],
      });
      db.prepare('DELETE FROM reg_kn_playbooks WHERE playbook_id = ?').run(m.playbookId);
      return;
    }
    case 'playbook.rejected': {
      db.prepare('DELETE FROM reg_kn_playbooks WHERE playbook_id = ?').run(
        (e.meta as MetaOf<'playbook.rejected'>).playbookId,
      );
      return;
    }
    case 'playbook.retired': {
      const id = (e.meta as MetaOf<'playbook.retired'>).playbookId;
      db.prepare('DELETE FROM reg_kn_playbooks WHERE playbook_id = ?').run(id);
      deleteDoc(db, `playbook:${id}`);
      return;
    }
    // ── lessons: searchable while bound ───────────────────────────────────
    case 'lesson.proposed': {
      const m = e.meta as MetaOf<'lesson.proposed'>;
      const p = payload as PayloadOf<'lesson.proposed'> | null;
      if (!p) return;
      db.prepare(
        `INSERT INTO reg_kn_lessons (lesson_id, scope_type, scope_value, rule, fix, rationale, body_scope) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(lesson_id) DO NOTHING`,
      ).run(m.lessonId, m.scopeType, m.scopeValue, p.rule, p.fix, p.rationale ?? null, e.bodyScope);
      return;
    }
    case 'lesson.bound': {
      const m = e.meta as MetaOf<'lesson.bound'>;
      const l = db.prepare('SELECT * FROM reg_kn_lessons WHERE lesson_id = ?').get(m.lessonId) as
        | {
            lesson_id: string;
            scope_type: string;
            scope_value: string;
            rule: string;
            fix: string;
            rationale: string | null;
            body_scope: string | null;
          }
        | undefined;
      if (!l) return;
      upsertDoc(db, {
        docId: `lesson:${l.lesson_id}`,
        kind: 'lesson',
        title: firstLine(l.rule, 200),
        body: clean(
          [
            `Rule: ${l.rule}`,
            `Fix: ${l.fix}`,
            l.rationale ? `Rationale: ${l.rationale}` : '',
            `Scope: ${l.scope_type} ${l.scope_value}`,
          ]
            .filter(Boolean)
            .join('\n'),
        ),
        refs: compact({
          lessonId: l.lesson_id,
          processType: l.scope_type === 'process_type' ? l.scope_value : undefined,
        }),
        date: e.ts,
        links: [l.lesson_id, l.body_scope],
      });
      db.prepare('DELETE FROM reg_kn_lessons WHERE lesson_id = ?').run(m.lessonId);
      return;
    }
    case 'lesson.rejected': {
      db.prepare('DELETE FROM reg_kn_lessons WHERE lesson_id = ?').run(
        (e.meta as MetaOf<'lesson.rejected'>).lessonId,
      );
      return;
    }
    case 'lesson.retired': {
      const id = (e.meta as MetaOf<'lesson.retired'>).lessonId;
      db.prepare('DELETE FROM reg_kn_lessons WHERE lesson_id = ?').run(id);
      deleteDoc(db, `lesson:${id}`);
      return;
    }
    // ── decisions: question + chosen option + comment ─────────────────────
    case 'decision.requested': {
      const m = e.meta as MetaOf<'decision.requested'>;
      const p = payload as PayloadOf<'decision.requested'> | null;
      if (!p || !INDEXED_DECISION_KINDS.has(m.kind) || m.subjectType === 'ticket') return;
      db.prepare(
        `INSERT INTO reg_kn_decisions (decision_id, kind, session_id, project_id, title, question, options_json, body_scope) VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(decision_id) DO NOTHING`,
      ).run(
        m.decisionId,
        m.kind,
        m.sessionId,
        m.projectId,
        p.title,
        p.question,
        JSON.stringify(p.options),
        e.bodyScope,
      );
      return;
    }
    case 'decision.resolved': {
      const m = e.meta as MetaOf<'decision.resolved'>;
      const d = db.prepare('SELECT * FROM reg_kn_decisions WHERE decision_id = ?').get(m.decisionId) as
        | {
            decision_id: string;
            kind: string;
            session_id: string | null;
            project_id: string | null;
            title: string;
            question: string;
            options_json: string;
            body_scope: string | null;
          }
        | undefined;
      if (!d) return;
      db.prepare('DELETE FROM reg_kn_decisions WHERE decision_id = ?').run(m.decisionId);
      // The resolver's comment is the reasoning that makes a decision reusable; a bare click is not indexed.
      const comment = (payload as PayloadOf<'decision.resolved'> | null)?.comment?.trim();
      if (!comment) return;
      const options = JSON.parse(d.options_json) as { id: string; label: string }[];
      const chosen = options.find((o) => o.id === m.optionId)?.label ?? m.optionId;
      upsertDoc(db, {
        docId: `decision:${d.decision_id}`,
        kind: 'decision',
        title: firstLine(d.title || d.question, 200),
        body: clean([`Question: ${d.question}`, `Chosen: ${chosen}`, `Comment: ${comment}`].join('\n')),
        refs: compact({ decisionId: d.decision_id, sessionId: d.session_id, projectId: d.project_id }),
        date: e.ts,
        links: [d.decision_id, d.body_scope, e.bodyScope],
      });
      return;
    }
    case 'decision.withdrawn': {
      db.prepare('DELETE FROM reg_kn_decisions WHERE decision_id = ?').run(
        (e.meta as MetaOf<'decision.withdrawn'>).decisionId,
      );
      return;
    }
    case 'body.erased': {
      eraseScope(db, (e.meta as MetaOf<'body.erased'>).scopeId);
      return;
    }
  }
}

/** Index the diagnosis that led to the fix: the fix-plan source session's, else the most confident (latest on ties). */
function indexTicket(db: DatabaseSync, ticketId: string, closed: StoredEvent): void {
  const diags = db
    .prepare(
      'SELECT * FROM reg_kn_diagnoses WHERE ticket_id = ? AND root_cause IS NOT NULL ORDER BY confidence DESC, seq DESC',
    )
    .all(ticketId) as {
    session_id: string;
    root_cause_class: string | null;
    root_cause: string;
    fix_plan: string | null;
    affected_json: string | null;
    project_id: string | null;
    body_scope: string | null;
  }[];
  if (!diags.length) return;
  const plan = db
    .prepare('SELECT source_session_id FROM reg_kn_fixplans WHERE ticket_id = ?')
    .get(ticketId) as { source_session_id: string | null } | undefined;
  const d = diags.find((x) => x.session_id === plan?.source_session_id) ?? diags[0]!;
  const areas = d.affected_json ? (JSON.parse(d.affected_json) as string[]) : [];
  upsertDoc(db, {
    docId: `ticket:${ticketId}`,
    kind: 'ticket',
    title: d.root_cause_class ? clean(d.root_cause_class, 200) : firstLine(d.root_cause, 200),
    body: clean(
      [
        `Root cause: ${d.root_cause}`,
        d.fix_plan ? `Fix plan: ${d.fix_plan}` : '',
        areas.length ? `Affected areas: ${areas.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    refs: compact({ ticketId, sessionId: d.session_id, projectId: d.project_id ?? closed.scope.projectId }),
    date: closed.ts,
    links: [ticketId, d.body_scope],
  });
}

function compact(r: Record<string, string | null | undefined>): KnowledgeRefs {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) if (v) out[k] = v;
  return out as KnowledgeRefs;
}

// ── search ─────────────────────────────────────────────────────────────────
const TITLE_WEIGHT = 4;
const BODY_WEIGHT = 1;

/**
 * User input is data, never FTS syntax: it is reduced to word tokens, each quoted. All terms must
 * match (last one as a prefix, for search-as-you-type); if nothing matches every term, any-term
 * matches are returned instead (still bm25-ranked).
 */
export function searchKnowledge(
  db: DatabaseSync,
  q: string,
  opts: { kind: KnowledgeKind | null; limit: number },
): KnowledgeSearchResponse {
  const tokens = [
    ...new Set(
      (
        q
          .normalize('NFKC')
          .toLowerCase()
          .match(/[\p{L}\p{N}_]+/gu) ?? []
      ).map((t) => t.slice(0, 64)),
    ),
  ].slice(0, 12);
  const base: KnowledgeSearchResponse = { query: q, kind: opts.kind, match: 'all', results: [] };
  if (!tokens.length) return base;
  const quoted = tokens.map((t) => `"${t}"`);
  const all = [...quoted.slice(0, -1), `${quoted[quoted.length - 1]}*`].join(' ');
  let results = runMatch(db, all, opts);
  if (!results.length && tokens.length > 1) {
    results = runMatch(db, quoted.join(' OR '), opts);
    if (results.length) return { ...base, match: 'any', results };
  }
  return { ...base, results };
}

function runMatch(
  db: DatabaseSync,
  match: string,
  opts: { kind: KnowledgeKind | null; limit: number },
): KnowledgeResult[] {
  const rows = db
    .prepare(
      `SELECT d.doc_id, d.kind, d.title, d.refs_json, d.date, bm25(reg_knowledge, ?, ?) AS rank, snippet(reg_knowledge, -1, ?, ?, '…', 24) AS snip
       FROM reg_knowledge JOIN reg_kn_docs d ON d.k = reg_knowledge.rowid
       WHERE reg_knowledge MATCH ? ${opts.kind ? 'AND d.kind = ?' : ''}
       ORDER BY rank ASC, d.date DESC
       LIMIT ?`,
    )
    .all(
      TITLE_WEIGHT,
      BODY_WEIGHT,
      HIT_OPEN,
      HIT_CLOSE,
      match,
      ...(opts.kind ? [opts.kind] : []),
      opts.limit,
    ) as {
    doc_id: string;
    kind: KnowledgeKind;
    title: string;
    refs_json: string;
    date: string;
    rank: number;
    snip: string;
  }[];
  return rows.map((r) => {
    const parts = snippetParts(r.snip);
    return {
      docId: r.doc_id,
      kind: r.kind,
      title: r.title,
      snippet: parts.map((p) => p.text).join(''),
      snippetParts: parts,
      score: Math.round(-r.rank * 1e6) / 1e6,
      refs: JSON.parse(r.refs_json) as KnowledgeRefs,
      date: r.date,
    };
  });
}

function snippetParts(snip: string): KnowledgeSnippetPart[] {
  const parts: KnowledgeSnippetPart[] = [];
  const re = new RegExp(`${HIT_OPEN}([^${HIT_CLOSE}]*)${HIT_CLOSE}`, 'g');
  let last = 0;
  for (const m of snip.matchAll(re)) {
    if (m.index > last) parts.push({ text: snip.slice(last, m.index), hit: false });
    parts.push({ text: m[1]!, hit: true });
    last = m.index + m[0].length;
  }
  if (last < snip.length) parts.push({ text: snip.slice(last), hit: false });
  return parts;
}
