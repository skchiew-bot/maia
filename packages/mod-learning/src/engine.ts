import type { SQLInputValue } from 'node:sqlite';
import {
  modelTierOf,
  newId,
  type Actor,
  type ErrorPriority,
  type ErrorSource,
  type EventSource,
  type LessonInfo,
  type LessonPayoffDTO,
  type LessonScopeType,
  type LessonStatus,
  type ModelTier,
  type OffenceState,
  type RootCauseAssigner,
  type RootCauseDimension,
  type StoredEvent,
} from '@aoc/contracts';
import { HttpError, type ModuleContext, type NewEvent } from '@aoc/kernel';
import { CostCalculator, type CostSubject } from './costs';
import { lessonPayoff, unusedStreak, type RunUse } from './rules';
import { areasOverlap, codeAreaOfFile, normalizeScopeValue, pathUnder, toCodeArea } from './scope';
import { errorSignature } from './signature';

export interface ResolvedLearningOptions {
  classifyMinConfidence: number;
  highPriorityMultiplier: number;
  costWindowMinutes: number;
  minRunsPerTier: number;
  runSettleHours: number;
  distillModel: ModelTier;
  classifyBatch: number;
  classifyLookbackHours: number;
  aiEveryMs: number;
}

/** Reactor / job writes. AI suggestions use their own actor so the audit log tells them apart from rules. */
export const SYSTEM: Actor = { kind: 'system', id: 'learning' };
export const AI_ACTOR: Actor = { kind: 'system', id: 'learning:ai' };

export interface ErrorRow {
  error_id: string;
  seq: number;
  observed_at: string;
  observed_ms: number;
  source: ErrorSource;
  session_id: string | null;
  project_id: string | null;
  process_type: string | null;
  model: string | null;
  model_tier: string | null;
  signature: string;
  code_area: string | null;
  priority: ErrorPriority;
  direct_cost_usd: number;
  direct_cost_ms: number;
  message: string | null;
  template: string | null;
  fix: string | null;
  hint: string | null;
  body_scope: string | null;
  class_id: string | null;
  assigned_by: RootCauseAssigner | null;
  confidence: number | null;
  assigned_seq: number | null;
}

export interface ClassRow {
  class_id: string;
  seq: number;
  created_at: string;
  dimension: RootCauseDimension;
  name: string | null;
  description: string | null;
  origin: 'human' | 'ai';
}

export interface OffenceRow {
  offence_id: string;
  class_id: string;
  state: OffenceState;
  detected_at: string;
  root_caused_at: string | null;
  fix_applied_at: string | null;
  fix_applied_ms: number | null;
  fix_seq: number | null;
  verified_closed_at: string | null;
  reopened_at: string | null;
  reopen_count: number;
  last_transition_at: string;
  last_transition_event: string;
  fix: string | null;
}

export interface LessonRow {
  lesson_id: string;
  seq: number;
  class_id: string | null;
  scope_type: LessonScopeType;
  scope_value: string;
  decision_id: string;
  status: LessonStatus;
  origin: 'human' | 'ai';
  rule: string | null;
  fix: string | null;
  rationale: string | null;
  proposed_at: string;
  bound_at: string | null;
  bound_ms: number | null;
  rejected_at: string | null;
  retired_at: string | null;
  retired_ms: number | null;
  retire_reason: 'unused' | 'superseded' | 'manual' | null;
  runs_unused: number | null;
}

/** A session ("run") as the learning analyses see it — no owner, by design (R11). */
export interface RunInfo {
  sessionId: string;
  processType: string | null;
  tier: ModelTier | null;
  startedMs: number;
  ended: boolean;
}

export interface RecordErrorInput {
  source: ErrorSource;
  sessionId?: string | null;
  projectId?: string | null;
  ticketId?: string | null;
  message: string;
  context?: string | null;
  fix?: string | null;
  rootCauseHint?: string | null;
  codeArea?: string | null;
  /** A file the failing call touched (its directory becomes the code area). */
  filePath?: string | null;
  priority?: ErrorPriority;
  sourceTs?: string;
  causationId?: string;
  idempotencyKey?: string;
}

export interface NewClassInput {
  name: string;
  dimension: RootCauseDimension;
  description?: string | null;
}

export interface ProposeLessonInput {
  classId: string | null;
  scopeType: LessonScopeType;
  scopeValue: string;
  rule: string;
  fix: string;
  rationale?: string | null;
}

interface WriteOpts {
  source: EventSource;
  causationId?: string;
  idempotencyKey?: string;
}

export interface ClassStats {
  occurrences: number;
  highPriority: number;
  /** Σ occurrence cost × priority multiplier — the ranking key. */
  weightedUsd: number;
  usd: number;
  ms: number;
  tokens: number;
  lastSeenAt: string | null;
}

const ENDED = new Set(['ended', 'failed', 'retired']);
const LABEL = /^[a-z0-9_.:/-]{1,80}$/i;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const round = (n: number, d = 6): number => Math.round(n * 10 ** d) / 10 ** d;

export class LearningEngine {
  constructor(
    readonly ctx: ModuleContext,
    readonly opts: ResolvedLearningOptions,
  ) {}

  // ── tiny query helpers ───────────────────────────────────────────────────
  one<T>(sql: string, ...args: SQLInputValue[]): T | null {
    return (this.ctx.db.prepare(sql).get(...args) as T | undefined) ?? null;
  }
  all<T>(sql: string, ...args: SQLInputValue[]): T[] {
    return this.ctx.db.prepare(sql).all(...args) as unknown as T[];
  }
  now(): number {
    return this.ctx.clock.now();
  }

  errorRow(id: string): ErrorRow | null {
    return this.one<ErrorRow>('SELECT * FROM lrn_errors WHERE error_id = ?', id);
  }
  classRow(id: string): ClassRow | null {
    return this.one<ClassRow>('SELECT * FROM lrn_classes WHERE class_id = ?', id);
  }
  offenceRow(id: string): OffenceRow | null {
    return this.one<OffenceRow>('SELECT * FROM lrn_offences WHERE offence_id = ?', id);
  }
  offenceForClass(classId: string): OffenceRow | null {
    return this.one<OffenceRow>('SELECT * FROM lrn_offences WHERE class_id = ?', classId);
  }
  lessonRow(id: string): LessonRow | null {
    return this.one<LessonRow>('SELECT * FROM lrn_lessons WHERE lesson_id = ?', id);
  }
  classErrors(classId: string): ErrorRow[] {
    return this.all<ErrorRow>('SELECT * FROM lrn_errors WHERE class_id = ? ORDER BY seq', classId);
  }

  // ── sessions (runs) ──────────────────────────────────────────────────────
  /** Process type / model / cwd of a session: the sessions directory first, then its latest usage batch. */
  sessionFacts(sessionId: string): {
    processType: string | null;
    model: string | null;
    cwd: string | null;
    projectId: string | null;
  } {
    const s = this.ctx.services.maybe('sessions')?.get(sessionId) ?? null;
    const usageModel = s?.model
      ? null
      : (this.one<{ model: string }>(
          'SELECT model FROM lrn_usage WHERE session_id = ? ORDER BY seq DESC LIMIT 1',
          sessionId,
        )?.model ?? null);
    return {
      processType: s?.processType ?? null,
      model: s?.model ?? usageModel,
      cwd: s?.cwd ?? null,
      projectId: s?.projectId ?? null,
    };
  }

  /** Every run the analyses can see: sessions directory ∪ usage batches ∪ sessions that produced errors. */
  runs(): Map<string, RunInfo> {
    const out = new Map<string, RunInfo>();
    const tierOf = (model: string | null | undefined): ModelTier | null => {
      const t = model ? modelTierOf(model) : 'unknown';
      return t === 'unknown' ? null : t;
    };
    for (const s of this.ctx.services.maybe('sessions')?.list() ?? []) {
      out.set(s.sessionId, {
        sessionId: s.sessionId,
        processType: s.processType,
        tier: tierOf(s.model),
        startedMs: Date.parse(s.startedAt) || 0,
        ended: ENDED.has(s.lifecycle),
      });
    }
    const fill = (
      sessionId: string,
      processType: string | null,
      tier: ModelTier | null,
      startedMs: number,
    ) => {
      const cur = out.get(sessionId);
      if (!cur) out.set(sessionId, { sessionId, processType, tier, startedMs, ended: false });
      else {
        cur.processType ??= processType;
        cur.tier ??= tier;
      }
    };
    for (const r of this.all<{ session_id: string; model: string; start: number }>(
      'SELECT session_id, model, MIN(first_ms) AS start FROM lrn_usage GROUP BY session_id',
    )) {
      fill(r.session_id, null, tierOf(r.model), r.start);
    }
    for (const r of this.all<{
      session_id: string;
      process_type: string | null;
      model: string | null;
      start: number;
    }>(
      'SELECT session_id, process_type, model, MIN(observed_ms) AS start FROM lrn_errors WHERE session_id IS NOT NULL GROUP BY session_id',
    )) {
      fill(r.session_id, r.process_type, tierOf(r.model), r.start);
    }
    return out;
  }

  // ── costs ────────────────────────────────────────────────────────────────
  costs(): CostCalculator {
    return new CostCalculator(this.ctx.db, {
      windowMs: this.opts.costWindowMinutes * 60_000,
      highPriorityMultiplier: this.opts.highPriorityMultiplier,
      timezone: this.ctx.config.timezone,
      nowMs: this.now(),
      metering: this.ctx.services.maybe('metering'),
    });
  }

  static subject(r: ErrorRow): CostSubject {
    return {
      errorId: r.error_id,
      seq: r.seq,
      sessionId: r.session_id,
      observedMs: r.observed_ms,
      priority: r.priority,
      directUsd: r.direct_cost_usd,
      directMs: r.direct_cost_ms,
    };
  }

  classStats(rows: ErrorRow[], calc: CostCalculator): ClassStats {
    const s: ClassStats = {
      occurrences: 0,
      highPriority: 0,
      weightedUsd: 0,
      usd: 0,
      ms: 0,
      tokens: 0,
      lastSeenAt: null,
    };
    for (const r of rows) {
      const c = calc.of(LearningEngine.subject(r));
      s.occurrences++;
      if (r.priority === 'high') s.highPriority++;
      s.weightedUsd += c.weightedUsd;
      s.usd += c.usd;
      s.ms += c.ms;
      s.tokens += c.tokens;
      if (!s.lastSeenAt || r.observed_at > s.lastSeenAt) s.lastSeenAt = r.observed_at;
    }
    s.weightedUsd = round(s.weightedUsd);
    s.usd = round(s.usd);
    return s;
  }

  // ── occurrences ──────────────────────────────────────────────────────────
  recordError(input: RecordErrorInput, actor: Actor, source: EventSource): StoredEvent {
    const sessionId = input.sessionId || null;
    const ticketId = input.ticketId || null;
    const facts = sessionId ? this.sessionFacts(sessionId) : null;
    const message = clip(input.message.trim() || `${input.source} error`, 4000);
    const codeArea =
      toCodeArea(input.codeArea, facts?.cwd) ??
      (input.filePath ? codeAreaOfFile(input.filePath, facts?.cwd) : null);
    const projectId = input.projectId || facts?.projectId || null;
    const processType = facts?.processType && LABEL.test(facts.processType) ? facts.processType : null;
    const hint = input.rootCauseHint?.trim();
    return this.ctx.store.append({
      type: 'error.observed',
      actor,
      scope: {
        sessionId: sessionId ?? undefined,
        projectId: projectId ?? undefined,
        ticketId: ticketId ?? undefined,
      },
      meta: {
        errorId: newId('error', this.now()),
        source: input.source,
        sessionId,
        projectId,
        processType,
        model: facts?.model ? facts.model.slice(0, 80) : null,
        signature: errorSignature(message),
        codeArea,
        priority: input.priority ?? (input.source === 'uat' ? 'high' : 'normal'),
        costUsd: 0,
        costMs: 0,
      },
      payload: {
        message,
        ...(input.context ? { context: clip(input.context, 4000) } : {}),
        ...(input.fix ? { fix: clip(input.fix, 4000) } : {}),
        ...(hint ? { rootCauseHint: clip(hint, 200) } : {}),
      },
      // A requester's UAT comment is erased with their ticket (PDPA), not with the build session.
      bodyScope: ticketId ?? undefined,
      source,
      sourceTs: input.sourceTs,
      causationId: input.causationId,
      idempotencyKey: input.idempotencyKey,
    });
  }

  // ── root-cause classes ───────────────────────────────────────────────────
  classEvent(input: NewClassInput, actor: Actor, opts: WriteOpts): NewEvent<'rootcause.class_defined'> {
    const classId = newId('rootCauseClass', this.now());
    const description = input.description?.trim();
    return {
      type: 'rootcause.class_defined',
      actor,
      meta: { classId, dimension: input.dimension },
      payload: {
        name: input.name.trim().slice(0, 120),
        ...(description ? { description: description.slice(0, 2000) } : {}),
      },
      bodyScope: classId,
      source: opts.source,
      causationId: opts.causationId,
    };
  }

  defineClass(input: NewClassInput, actor: Actor, opts: WriteOpts): string {
    const ev = this.classEvent(input, actor, opts);
    this.ctx.store.append(ev);
    return ev.meta.classId;
  }

  assignEvent(
    errorId: string,
    classId: string,
    by: RootCauseAssigner,
    confidence: number,
    actor: Actor,
    opts: WriteOpts,
  ): NewEvent<'rootcause.assigned'> {
    return {
      type: 'rootcause.assigned',
      actor,
      meta: { errorId, classId, assignedBy: by, confidence: Math.min(1, Math.max(0, confidence)) },
      source: opts.source,
      causationId: opts.causationId,
      idempotencyKey: opts.idempotencyKey,
    };
  }

  assign(
    errorId: string,
    classId: string,
    by: RootCauseAssigner,
    confidence: number,
    actor: Actor,
    opts: WriteOpts,
  ): void {
    this.ctx.store.append(this.assignEvent(errorId, classId, by, confidence, actor, opts));
  }

  // ── repeat offences ──────────────────────────────────────────────────────
  private snapshot(classId: string): { occurrences: number; costOfRecurrenceUsd: number } {
    const s = this.classStats(this.classErrors(classId), this.costs());
    return { occurrences: s.occurrences, costOfRecurrenceUsd: s.weightedUsd };
  }

  detectOffence(classId: string, causationId: string): void {
    const offenceId = newId('offence', this.now());
    this.ctx.store.append({
      type: 'offence.transitioned',
      actor: SYSTEM,
      meta: { offenceId, classId, from: null, to: 'detected', ...this.snapshot(classId) },
      payload: {},
      bodyScope: offenceId,
      source: 'system',
      causationId,
      idempotencyKey: `offence.detected:${classId}`,
    });
  }

  transitionOffence(
    off: OffenceRow,
    to: OffenceState,
    text: { note?: string | null; fix?: string | null },
    actor: Actor,
    opts: WriteOpts,
  ): void {
    const note = text.note?.trim();
    const fix = text.fix?.trim();
    this.ctx.store.append({
      type: 'offence.transitioned',
      actor,
      meta: {
        offenceId: off.offence_id,
        classId: off.class_id,
        from: off.state,
        to,
        ...this.snapshot(off.class_id),
      },
      payload: { ...(note ? { note } : {}), ...(fix ? { fix } : {}) },
      bodyScope: off.offence_id,
      source: opts.source,
      causationId: opts.causationId,
      idempotencyKey: opts.idempotencyKey,
    });
  }

  /** Daily: fix_applied → verified_closed after a full window without recurrence (or reopened if one slipped past the reactor). */
  verifyOffences(): number {
    const windowMs = this.ctx.config.learning.verifyWindowDays * DAY;
    let n = 0;
    for (const off of this.all<OffenceRow>("SELECT * FROM lrn_offences WHERE state = 'fix_applied'")) {
      if (off.fix_applied_ms === null || off.fix_seq === null || this.now() < off.fix_applied_ms + windowMs)
        continue;
      const recurred =
        this.one<{ n: number }>(
          'SELECT COUNT(*) AS n FROM lrn_errors WHERE class_id = ? AND seq > ?',
          off.class_id,
          off.fix_seq,
        )!.n > 0;
      const to: OffenceState = recurred ? 'reopened' : 'verified_closed';
      this.transitionOffence(off, to, {}, SYSTEM, {
        source: 'scheduler',
        idempotencyKey: `offence.${to}:${off.offence_id}:${off.fix_seq}`,
      });
      n++;
    }
    return n;
  }

  // ── lessons ──────────────────────────────────────────────────────────────
  /** Lesson binding is a human-required decision (one bad lesson corrupts the fleet). */
  proposeLesson(input: ProposeLessonInput, actor: Actor, opts: WriteOpts): string {
    const scopeValue = normalizeScopeValue(input.scopeType, input.scopeValue);
    if (!scopeValue)
      throw new HttpError(
        422,
        'invalid_scope',
        'Lessons are scoped to one process type or a repo-relative code area, never global',
      );
    if (input.scopeType === 'process_type') {
      const registry = this.ctx.services.maybe('registry');
      if (registry && !registry.getType(scopeValue))
        throw new HttpError(422, 'unknown_process_type', `Unknown process type ${scopeValue}`);
    }
    if (input.classId && !this.classRow(input.classId))
      throw new HttpError(404, 'class_not_found', 'Root-cause class not found');
    const decisions = this.ctx.services.maybe('decisions');
    if (!decisions)
      throw new HttpError(503, 'decisions_unavailable', 'Lesson binding needs the decision service');
    const lessonId = newId('lesson', this.now());
    const rule = input.rule.trim();
    const fix = input.fix.trim();
    const rationale = input.rationale?.trim();
    const card = decisions.request(
      {
        kind: 'lesson_binding',
        title: `Bind lesson for ${input.scopeType === 'process_type' ? 'process type' : 'code area'} ${scopeValue}`,
        question: 'Bind this lesson? Once bound it is injected into every session in its scope.',
        options: [
          {
            id: 'bind',
            label: 'Bind lesson',
            description: `Inject into ${input.scopeType === 'process_type' ? 'every run of' : 'sessions touching'} ${scopeValue}`,
          },
          { id: 'reject', label: 'Reject' },
        ],
        context: `Rule: ${rule}\nFix: ${fix}${rationale ? `\nRationale: ${rationale}` : ''}`,
        subjectType: 'lesson',
        subjectId: lessonId,
        requesterId: actor.id.slice(0, 64),
      },
      actor,
    );
    this.ctx.store.append({
      type: 'lesson.proposed',
      actor,
      meta: { lessonId, classId: input.classId, scopeType: input.scopeType, scopeValue, decisionId: card.id },
      payload: { rule, fix, ...(rationale ? { rationale } : {}) },
      bodyScope: lessonId,
      source: opts.source,
      causationId: opts.causationId,
    });
    return lessonId;
  }

  retireLesson(
    lesson: LessonRow,
    reason: 'unused' | 'manual',
    runsUnused: number,
    actor: Actor,
    opts: WriteOpts,
  ): void {
    this.ctx.store.append({
      type: 'lesson.retired',
      actor,
      meta: { lessonId: lesson.lesson_id, reason, runsUnused },
      source: opts.source,
      idempotencyKey: opts.idempotencyKey ?? `lesson.retired:${lesson.lesson_id}`,
    });
    // A still-open binding decision is moot once the lesson is retired (retired first, so the withdrawal is not read as a rejection).
    if (lesson.status === 'proposed') {
      const decisions = this.ctx.services.maybe('decisions');
      if (decisions?.get(lesson.decision_id)?.status === 'open')
        decisions.withdraw(lesson.decision_id, 'lesson_retired', actor);
    }
  }

  /** Bound lessons in scope: the run's process type, or code areas overlapping what it will touch. Never global. */
  lessonsForScope(scope: { processType: string; codeAreas?: string[] }): LessonInfo[] {
    const areas = (scope.codeAreas ?? []).map((a) => toCodeArea(a)).filter((a): a is string => a !== null);
    return this.all<LessonRow>(
      "SELECT * FROM lrn_lessons WHERE status = 'bound' AND rule IS NOT NULL AND fix IS NOT NULL ORDER BY bound_ms, seq",
    )
      .filter((l) =>
        l.scope_type === 'process_type'
          ? l.scope_value === scope.processType
          : areas.some((a) => areasOverlap(a, l.scope_value)),
      )
      .map((l) => ({
        lessonId: l.lesson_id,
        scopeType: l.scope_type,
        scopeValue: l.scope_value,
        rule: l.rule!,
        fix: l.fix!,
      }));
  }

  applyLessons(lessonIds: string[], sessionId: string, actor: Actor): void {
    const bound = new Set(
      this.all<{ lesson_id: string }>("SELECT lesson_id FROM lrn_lessons WHERE status = 'bound'").map(
        (r) => r.lesson_id,
      ),
    );
    const events: NewEvent[] = [...new Set(lessonIds)]
      .filter((id) => bound.has(id))
      .map((lessonId) => ({
        type: 'lesson.applied',
        actor,
        scope: { sessionId },
        meta: { lessonId, sessionId },
        source: 'system',
        idempotencyKey: `lesson.applied:${lessonId}:${sessionId}`,
      }));
    if (events.length) this.ctx.store.appendMany(events);
  }

  private filesUnder(area: string): { session_id: string; first_ms: number }[] {
    const bySession = new Map<string, number>();
    const rows = this.all<{ session_id: string; path: string; first_ms: number }>(
      'SELECT session_id, path, first_ms FROM lrn_session_files WHERE path LIKE ?',
      `%${area}%`,
    );
    for (const f of rows) {
      if (!pathUnder(f.path, area)) continue;
      bySession.set(f.session_id, Math.min(bySession.get(f.session_id) ?? Infinity, f.first_ms));
    }
    return [...bySession].map(([session_id, first_ms]) => ({ session_id, first_ms }));
  }

  /**
   * A lesson is "used" in a run that actually exercised its scope: any run of its process type, or a session
   * whose file-changing tool calls touched its code area. Unfinished runs stay pending until they end (or settle).
   */
  lessonRuns(lesson: LessonRow, runs: Map<string, RunInfo>): RunUse[] {
    const settleMs = this.opts.runSettleHours * HOUR;
    const exercised =
      lesson.scope_type === 'process_type'
        ? (sessionId: string) => runs.get(sessionId)?.processType === lesson.scope_value
        : (() => {
            const touched = new Set(this.filesUnder(lesson.scope_value).map((f) => f.session_id));
            return (sessionId: string) => touched.has(sessionId);
          })();
    return this.all<{ session_id: string; applied_ms: number }>(
      'SELECT session_id, applied_ms FROM lrn_lesson_runs WHERE lesson_id = ? ORDER BY seq',
      lesson.lesson_id,
    ).map((a) => {
      if (exercised(a.session_id)) return 'used';
      return runs.get(a.session_id)?.ended || this.now() - a.applied_ms >= settleMs ? 'unused' : 'pending';
    });
  }

  /** Daily: retire bound lessons after N consecutive applied-but-unused runs (R10). */
  retireUnusedLessons(): number {
    const limit = this.ctx.config.learning.retireAfterUnusedRuns;
    const runs = this.runs();
    let n = 0;
    for (const lesson of this.all<LessonRow>("SELECT * FROM lrn_lessons WHERE status = 'bound'")) {
      const streak = unusedStreak(this.lessonRuns(lesson, runs));
      if (streak < limit) continue;
      this.retireLesson(lesson, 'unused', streak, SYSTEM, { source: 'scheduler' });
      n++;
    }
    return n;
  }

  /**
   * Payoff: repeats prevented = baseline recurrence rate per exposure before binding × exposures after −
   * actual recurrences after; savings = prevented × average occurrence cost (tokens / time / notional USD).
   */
  lessonPayoff(lesson: LessonRow, runs: Map<string, RunInfo>, calc: CostCalculator): LessonPayoffDTO | null {
    if (lesson.bound_ms === null) return null;
    const empty: LessonPayoffDTO = {
      measurable: false,
      exposuresBefore: 0,
      occurrencesBefore: 0,
      baselineRatePerExposure: 0,
      exposuresAfter: 0,
      recurrencesAfter: 0,
      expectedRecurrences: 0,
      repeatsPrevented: 0,
      avgOccurrenceCostUsd: 0,
      avgOccurrenceMs: 0,
      avgOccurrenceTokens: 0,
      usdSaved: 0,
      msSaved: 0,
      tokensSaved: 0,
    };
    if (!lesson.class_id) return empty;
    const bound = lesson.bound_ms;
    const end = lesson.retired_ms ?? Infinity;
    // exposure = a run that exercised the scope, timed at its start (process type) or first touch (code area)
    const exposure = new Map<string, number>();
    if (lesson.scope_type === 'process_type') {
      for (const r of runs.values())
        if (r.processType === lesson.scope_value) exposure.set(r.sessionId, r.startedMs);
    } else {
      for (const f of this.filesUnder(lesson.scope_value)) exposure.set(f.session_id, f.first_ms);
    }
    const classRows = this.classErrors(lesson.class_id);
    const inScope = classRows.filter((e) =>
      lesson.scope_type === 'process_type'
        ? e.process_type === lesson.scope_value
        : (e.code_area !== null && pathUnder(e.code_area, lesson.scope_value)) ||
          (e.session_id !== null && exposure.has(e.session_id)),
    );
    // an occurrence in scope means its session was exposed
    for (const e of inScope)
      if (e.session_id && !exposure.has(e.session_id)) exposure.set(e.session_id, e.observed_ms);
    const exposures = [...exposure.values()];
    const before = inScope.filter((e) => e.observed_ms < bound);
    const basis = before.length ? before : classRows;
    const costs = basis.map((e) => calc.of(LearningEngine.subject(e)));
    const avg = (f: (c: (typeof costs)[number]) => number) =>
      costs.length ? costs.reduce((s, c) => s + f(c), 0) / costs.length : 0;
    const input = {
      exposuresBefore: exposures.filter((t) => t < bound).length,
      occurrencesBefore: before.length,
      exposuresAfter: exposures.filter((t) => t >= bound && t < end).length,
      recurrencesAfter: inScope.filter((e) => e.observed_ms >= bound && e.observed_ms < end).length,
      avgCostUsd: avg((c) => c.usd),
      avgCostMs: avg((c) => c.ms),
      avgTokens: avg((c) => c.tokens),
    };
    const p = lessonPayoff(input);
    return {
      measurable: true,
      exposuresBefore: input.exposuresBefore,
      occurrencesBefore: input.occurrencesBefore,
      baselineRatePerExposure: round(p.baselineRatePerExposure, 4),
      exposuresAfter: input.exposuresAfter,
      recurrencesAfter: input.recurrencesAfter,
      expectedRecurrences: round(p.expectedRecurrences, 4),
      repeatsPrevented: round(p.repeatsPrevented, 4),
      avgOccurrenceCostUsd: round(input.avgCostUsd),
      avgOccurrenceMs: Math.round(input.avgCostMs),
      avgOccurrenceTokens: Math.round(input.avgTokens),
      usdSaved: round(p.usdSaved),
      msSaved: Math.round(p.msSaved),
      tokensSaved: Math.round(p.tokensSaved),
    };
  }
}
