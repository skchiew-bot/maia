import {
  MODEL_TIERS,
  type ErrorOccurrenceDTO,
  type LessonDTO,
  type LessonStatus,
  type ModelDimensionClassDTO,
  type ModelDimensionReportDTO,
  type ModelTier,
  type ModelVerdict,
  type OffenceDTO,
  type OffenceState,
  type RecurrenceTrendDTO,
  type RootCauseClassDTO,
  type TierStatDTO,
} from '@aoc/contracts';
import { addDays, localDate, weekdayOf } from '@aoc/kernel';
import type { CostCalculator } from './costs';
import {
  LearningEngine,
  type ClassRow,
  type ErrorRow,
  type LessonRow,
  type OffenceRow,
  type RunInfo,
} from './engine';
import {
  classVerdict,
  processVerdict,
  REPEAT_THRESHOLD,
  TIER_STRENGTH,
  unusedStreak,
  VERDICT_SUMMARY,
  type TierCell,
} from './rules';

const ERASED = '[erased]';
const DAY = 86_400_000;

interface HistoryRow {
  seq: number;
  at: string;
  from_state: OffenceState | null;
  to_state: OffenceState;
  occurrences: number;
  cost_usd: number;
  note: string | null;
}

function groupBy<T, K>(rows: T[], key: (r: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

/**
 * Read models for the learning console. R11: DTOs carry root-cause classes, process types, model tiers and
 * code areas — never actor/user ids, names, session ids or per-person counts.
 */
export class LearningReads {
  constructor(private readonly engine: LearningEngine) {}

  private classNames(): Map<string, string> {
    return new Map(
      this.engine
        .all<ClassRow>('SELECT class_id, name FROM lrn_classes')
        .map((c) => [c.class_id, c.name ?? ERASED]),
    );
  }

  private errorDto(r: ErrorRow, names: Map<string, string>, calc: CostCalculator): ErrorOccurrenceDTO {
    return {
      errorId: r.error_id,
      observedAt: r.observed_at,
      source: r.source,
      priority: r.priority,
      signature: r.signature,
      template: r.template,
      message: r.message ?? ERASED,
      fix: r.fix,
      rootCauseHint: r.hint,
      codeArea: r.code_area,
      processType: r.process_type,
      modelTier: r.model_tier as ModelTier | 'unknown' | null,
      projectId: r.project_id,
      classId: r.class_id,
      className: r.class_id ? (names.get(r.class_id) ?? null) : null,
      assignedBy: r.assigned_by,
      confidence: r.confidence,
      cost: calc.of(LearningEngine.subject(r)),
    };
  }

  errors(filter: { classId?: string; unassigned?: boolean; limit?: number } = {}): ErrorOccurrenceDTO[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.classId) (where.push('class_id = ?'), args.push(filter.classId));
    if (filter.unassigned) where.push('class_id IS NULL');
    const rows = this.engine.all<ErrorRow>(
      `SELECT * FROM lrn_errors ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY observed_ms DESC, seq DESC LIMIT ?`,
      ...args,
      Math.min(Math.max(filter.limit ?? 200, 1), 1000),
    );
    const names = this.classNames();
    const calc = this.engine.costs();
    return rows.map((r) => this.errorDto(r, names, calc));
  }

  error(id: string): ErrorOccurrenceDTO | null {
    const r = this.engine.errorRow(id);
    return r ? this.errorDto(r, this.classNames(), this.engine.costs()) : null;
  }

  classes(): RootCauseClassDTO[] {
    const calc = this.engine.costs();
    const byClass = groupBy(
      this.engine.all<ErrorRow>('SELECT * FROM lrn_errors WHERE class_id IS NOT NULL'),
      (e) => e.class_id!,
    );
    const offences = new Map(
      this.engine
        .all<OffenceRow>('SELECT offence_id, class_id, state FROM lrn_offences')
        .map((o) => [o.class_id, o]),
    );
    return this.engine
      .all<ClassRow>('SELECT * FROM lrn_classes ORDER BY seq')
      .map((c): RootCauseClassDTO => {
        const s = this.engine.classStats(byClass.get(c.class_id) ?? [], calc);
        const off = offences.get(c.class_id);
        return {
          classId: c.class_id,
          name: c.name ?? ERASED,
          description: c.description,
          dimension: c.dimension,
          origin: c.origin,
          createdAt: c.created_at,
          occurrences: s.occurrences,
          highPriorityOccurrences: s.highPriority,
          costOfRecurrenceUsd: s.weightedUsd,
          lastSeenAt: s.lastSeenAt,
          offence: off ? { offenceId: off.offence_id, state: off.state } : null,
        };
      })
      .sort(
        (a, b) => b.costOfRecurrenceUsd - a.costOfRecurrenceUsd || a.createdAt.localeCompare(b.createdAt),
      );
  }

  rootCauseClass(id: string): RootCauseClassDTO | null {
    return this.classes().find((c) => c.classId === id) ?? null;
  }

  private offenceDto(
    o: OffenceRow,
    classes: Map<string, ClassRow>,
    errors: ErrorRow[],
    calc: CostCalculator,
  ): OffenceDTO {
    const s = this.engine.classStats(errors, calc);
    const cls = classes.get(o.class_id);
    const history = this.engine.all<HistoryRow>(
      'SELECT seq, at, from_state, to_state, occurrences, cost_usd, note FROM lrn_offence_history WHERE offence_id = ? ORDER BY seq',
      o.offence_id,
    );
    const verifyDue =
      o.state === 'fix_applied' && o.fix_applied_ms !== null
        ? new Date(o.fix_applied_ms + this.engine.ctx.config.learning.verifyWindowDays * DAY).toISOString()
        : null;
    return {
      offenceId: o.offence_id,
      classId: o.class_id,
      className: cls?.name ?? ERASED,
      dimension: cls?.dimension ?? 'unknown',
      state: o.state,
      occurrences: s.occurrences,
      occurrencesSinceFix: o.fix_seq === null ? 0 : errors.filter((e) => e.seq > o.fix_seq!).length,
      highPriorityOccurrences: s.highPriority,
      costOfRecurrenceUsd: s.weightedUsd,
      costMs: s.ms,
      costTokens: s.tokens,
      detectedAt: o.detected_at,
      lastTransitionAt: o.last_transition_at,
      fixAppliedAt: o.fix_applied_at,
      verifyDueAt: verifyDue,
      verifiedClosedAt: o.verified_closed_at,
      reopenCount: o.reopen_count,
      fix: o.fix,
      history: history.map((h) => ({
        from: h.from_state,
        to: h.to_state,
        at: h.at,
        occurrences: h.occurrences,
        costOfRecurrenceUsd: h.cost_usd,
        note: h.note,
      })),
    };
  }

  /** Repeat offences ranked by cost of recurrence (Σ occurrence cost × priority multiplier), never by count. */
  offences(): OffenceDTO[] {
    const calc = this.engine.costs();
    const classes = new Map(
      this.engine.all<ClassRow>('SELECT * FROM lrn_classes').map((c) => [c.class_id, c]),
    );
    const byClass = groupBy(
      this.engine.all<ErrorRow>('SELECT * FROM lrn_errors WHERE class_id IS NOT NULL ORDER BY seq'),
      (e) => e.class_id!,
    );
    return this.engine
      .all<OffenceRow>('SELECT * FROM lrn_offences')
      .map((o) => this.offenceDto(o, classes, byClass.get(o.class_id) ?? [], calc))
      .sort(
        (a, b) =>
          b.costOfRecurrenceUsd - a.costOfRecurrenceUsd ||
          b.costMs - a.costMs ||
          b.lastTransitionAt.localeCompare(a.lastTransitionAt),
      );
  }

  offence(id: string): OffenceDTO | null {
    const o = this.engine.offenceRow(id);
    if (!o) return null;
    const cls = this.engine.classRow(o.class_id);
    return this.offenceDto(
      o,
      new Map(cls ? [[cls.class_id, cls]] : []),
      this.engine.classErrors(o.class_id),
      this.engine.costs(),
    );
  }

  /** Weekly occurrence counts per repeat class (the recurrence trend chart), weeks starting Monday in the local timezone. */
  trends(weeks: number): RecurrenceTrendDTO {
    const tz = this.engine.ctx.config.timezone;
    const today = localDate(this.engine.now(), tz);
    const monday = (d: string) => addDays(d, -((weekdayOf(d) + 6) % 7));
    const thisWeek = monday(today);
    const weekStarts = Array.from({ length: weeks }, (_, i) => addDays(thisWeek, -7 * (weeks - 1 - i)));
    const index = new Map(weekStarts.map((w, i) => [w, i]));
    // UTC lower bound padded by a day so every timezone's first local week is covered; exact bucketing is local
    const fromMs = Date.parse(`${weekStarts[0]}T00:00:00Z`) - DAY;
    const rows = this.engine.all<{ class_id: string | null; observed_ms: number }>(
      'SELECT class_id, observed_ms FROM lrn_errors WHERE observed_ms >= ?',
      fromMs,
    );
    const repeats = new Set(
      this.engine
        .all<{ class_id: string }>(
          'SELECT class_id FROM lrn_errors WHERE class_id IS NOT NULL GROUP BY class_id HAVING COUNT(*) >= ?',
          REPEAT_THRESHOLD,
        )
        .map((r) => r.class_id),
    );
    const counts = new Map<string, number[]>();
    const unclassified = weekStarts.map(() => 0);
    for (const r of rows) {
      const i = index.get(monday(localDate(r.observed_ms, tz)));
      if (i === undefined) continue;
      if (r.class_id === null) unclassified[i]!++;
      else if (repeats.has(r.class_id)) {
        const c = counts.get(r.class_id) ?? weekStarts.map(() => 0);
        c[i]!++;
        counts.set(r.class_id, c);
      }
    }
    const classes = new Map(
      this.engine.all<ClassRow>('SELECT * FROM lrn_classes').map((c) => [c.class_id, c]),
    );
    const states = new Map(
      this.engine
        .all<OffenceRow>('SELECT class_id, state FROM lrn_offences')
        .map((o) => [o.class_id, o.state]),
    );
    return {
      weeks: weekStarts,
      classes: [...counts]
        .map(([classId, c]) => ({
          classId,
          name: classes.get(classId)?.name ?? ERASED,
          dimension: classes.get(classId)?.dimension ?? 'unknown',
          counts: c,
          total: c.reduce((a, b) => a + b, 0),
          offenceState: states.get(classId) ?? null,
        }))
        .sort((a, b) => b.total - a.total || a.classId.localeCompare(b.classId)),
      unclassified,
    };
  }

  /**
   * Model as a tested root-cause dimension (§11): per repeat class, occurrences and runs by model tier within
   * each process type the class occurs in.
   */
  modelDimension(): ModelDimensionReportDTO {
    const minRuns = this.engine.opts.minRunsPerTier;
    const runSets = new Map<string, Map<ModelTier, Set<string>>>();
    for (const r of this.engine.runs().values()) {
      if (!r.processType || !r.tier) continue;
      const byTier = runSets.get(r.processType) ?? new Map<ModelTier, Set<string>>();
      const set = byTier.get(r.tier) ?? new Set<string>();
      set.add(r.sessionId);
      byTier.set(r.tier, set);
      runSets.set(r.processType, byTier);
    }
    const order: Record<ModelVerdict, number> = {
      model_capability: 0,
      spec_context_tooling: 1,
      inconclusive: 2,
    };
    const byClass = groupBy(
      this.engine.all<ErrorRow>('SELECT * FROM lrn_errors WHERE class_id IS NOT NULL'),
      (e) => e.class_id!,
    );
    const out: ModelDimensionClassDTO[] = [];
    for (const c of this.engine.all<ClassRow>('SELECT * FROM lrn_classes ORDER BY seq')) {
      const errors = byClass.get(c.class_id) ?? [];
      if (errors.length < REPEAT_THRESHOLD) continue;
      const occ = new Map<string, Map<ModelTier, number>>();
      for (const e of errors) {
        const tier = e.model_tier as ModelTier | 'unknown' | null;
        if (!e.process_type || !tier || tier === 'unknown') continue;
        const m = occ.get(e.process_type) ?? new Map<ModelTier, number>();
        m.set(tier, (m.get(tier) ?? 0) + 1);
        occ.set(e.process_type, m);
      }
      const byTier = new Map<ModelTier, TierCell>();
      const byProcessType = [...occ.keys()].sort().map((processType) => {
        const cells: Partial<Record<ModelTier, TierCell>> = {};
        for (const tier of MODEL_TIERS) {
          const runs = runSets.get(processType)?.get(tier)?.size ?? 0;
          const occurrences = occ.get(processType)?.get(tier) ?? 0;
          if (!runs && !occurrences) continue;
          cells[tier] = { runs, occurrences };
          const agg = byTier.get(tier) ?? { runs: 0, occurrences: 0 };
          byTier.set(tier, { runs: agg.runs + runs, occurrences: agg.occurrences + occurrences });
        }
        return { processType, cells, ...processVerdict(processType, cells, minRuns) };
      });
      const verdict = classVerdict(byProcessType);
      const recommendations =
        verdict === 'model_capability'
          ? byProcessType.map((p) => p.recommendation).filter((r): r is string => r !== null)
          : [];
      const tierStats = (
        cells: Partial<Record<ModelTier, TierCell>> | Map<ModelTier, TierCell>,
      ): TierStatDTO[] =>
        (cells instanceof Map ? [...cells] : (Object.entries(cells) as [ModelTier, TierCell][]))
          .map(([tier, v]) => ({ tier, runs: v.runs, occurrences: v.occurrences }))
          .sort((a, b) => TIER_STRENGTH[a.tier] - TIER_STRENGTH[b.tier]);
      out.push({
        classId: c.class_id,
        name: c.name ?? ERASED,
        dimension: c.dimension,
        occurrences: errors.length,
        verdict,
        summary:
          verdict === 'model_capability'
            ? `${VERDICT_SUMMARY.model_capability} — ${recommendations.join('; ')}`
            : VERDICT_SUMMARY[verdict],
        recommendations,
        byTier: tierStats(byTier),
        byProcessType: byProcessType.map((p) => ({
          processType: p.processType,
          verdict: p.verdict,
          tiers: tierStats(p.cells),
          cheaperTier: p.cheaperTier,
          strongerTier: p.strongerTier,
          recommendation: p.recommendation,
        })),
      });
    }
    out.sort((a, b) => order[a.verdict] - order[b.verdict] || b.occurrences - a.occurrences);
    return { generatedAt: this.engine.ctx.clock.iso(), minRunsPerTier: minRuns, classes: out };
  }

  private lessonDto(
    l: LessonRow,
    names: Map<string, string>,
    runs: Map<string, RunInfo>,
    calc: CostCalculator,
  ): LessonDTO {
    const uses = this.engine.lessonRuns(l, runs);
    return {
      lessonId: l.lesson_id,
      classId: l.class_id,
      className: l.class_id ? (names.get(l.class_id) ?? null) : null,
      scopeType: l.scope_type,
      scopeValue: l.scope_value,
      status: l.status,
      origin: l.origin,
      rule: l.rule ?? ERASED,
      fix: l.fix ?? ERASED,
      rationale: l.rationale,
      decisionId: l.decision_id,
      proposedAt: l.proposed_at,
      boundAt: l.bound_at,
      rejectedAt: l.rejected_at,
      retiredAt: l.retired_at,
      retireReason: l.retire_reason,
      usage: {
        appliedRuns: uses.length,
        usedRuns: uses.filter((u) => u === 'used').length,
        unusedRuns: uses.filter((u) => u === 'unused').length,
        pendingRuns: uses.filter((u) => u === 'pending').length,
        unusedStreak: unusedStreak(uses),
        retireAfterUnusedRuns: this.engine.ctx.config.learning.retireAfterUnusedRuns,
      },
      payoff: this.engine.lessonPayoff(l, runs, calc),
    };
  }

  lessons(
    filter: { status?: LessonStatus; scopeType?: string; scopeValue?: string; classId?: string } = {},
  ): LessonDTO[] {
    const runs = this.engine.runs();
    const calc = this.engine.costs();
    const names = this.classNames();
    return this.engine
      .all<LessonRow>('SELECT * FROM lrn_lessons ORDER BY seq DESC')
      .filter(
        (l) =>
          (!filter.status || l.status === filter.status) &&
          (!filter.scopeType || l.scope_type === filter.scopeType) &&
          (!filter.scopeValue || l.scope_value === filter.scopeValue) &&
          (!filter.classId || l.class_id === filter.classId),
      )
      .map((l) => this.lessonDto(l, names, runs, calc));
  }

  lesson(id: string): LessonDTO | null {
    const l = this.engine.lessonRow(id);
    return l ? this.lessonDto(l, this.classNames(), this.engine.runs(), this.engine.costs()) : null;
  }
}
