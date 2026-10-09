/**
 * Pure view-model rules for the Knowledge page: the distilled lessons registry (§11). Lessons are scoped to a
 * process type or a code area (never global), bind only through a human decision, and retire when unused for
 * N runs so the rulebook stays small (R10).
 */
import type {
  DecisionCardView,
  KnowledgeKind,
  LessonDTO,
  LessonScopeType,
  LessonStatus,
  OffenceDTO,
} from '@aoc/contracts';
import type { IconName, Tone } from '../../components';

export const STATUS_META: Record<LessonStatus, { label: string; tone: Tone; icon: IconName; hint: string }> =
  {
    proposed: {
      label: 'Awaiting decision',
      tone: 'accent',
      icon: 'decisions',
      hint: 'Proposed; binds only when an Approver decides',
    },
    bound: { label: 'In force', tone: 'ok', icon: 'ok', hint: 'Injected into every session in its scope' },
    retired: { label: 'Retired', tone: 'neutral', icon: 'retired', hint: 'No longer injected' },
    rejected: { label: 'Rejected', tone: 'neutral', icon: 'close', hint: 'The Approver did not bind it' },
  };

export const SCOPE_LABEL: Record<LessonScopeType, string> = {
  process_type: 'Process type',
  code_area: 'Code area',
};

export const RETIRE_REASON: Record<'unused' | 'superseded' | 'manual', string> = {
  unused: 'unused',
  superseded: 'superseded',
  manual: 'retired by hand',
};

export const KIND_LABEL: Record<KnowledgeKind, string> = {
  ticket: 'Resolved bug',
  playbook: 'Playbook',
  lesson: 'Lesson',
  decision: 'Decision',
};

/** Lessons that were in force at some point carry a payoff (bound, or bound then retired). */
function everBound(l: LessonDTO): boolean {
  return l.boundAt !== null;
}

export interface KnowledgeSummary {
  byStatus: Record<LessonStatus, number>;
  inForce: number;
  processTypes: number;
  codeAreas: number;
  /** Σ over lessons with a measurable payoff since binding (may be negative: some lessons do not work). */
  repeatsPrevented: number;
  usdSaved: number;
  msSaved: number;
  tokensSaved: number;
  measurable: number;
}

export function summarise(lessons: readonly LessonDTO[]): KnowledgeSummary {
  const byStatus: Record<LessonStatus, number> = { proposed: 0, bound: 0, retired: 0, rejected: 0 };
  const processTypes = new Set<string>();
  const codeAreas = new Set<string>();
  const s: KnowledgeSummary = {
    byStatus,
    inForce: 0,
    processTypes: 0,
    codeAreas: 0,
    repeatsPrevented: 0,
    usdSaved: 0,
    msSaved: 0,
    tokensSaved: 0,
    measurable: 0,
  };
  for (const l of lessons) {
    byStatus[l.status] += 1;
    if (l.status === 'bound') {
      (l.scopeType === 'process_type' ? processTypes : codeAreas).add(l.scopeValue);
    }
    if (everBound(l) && l.payoff?.measurable) {
      s.measurable += 1;
      s.repeatsPrevented += l.payoff.repeatsPrevented;
      s.usdSaved += l.payoff.usdSaved;
      s.msSaved += l.payoff.msSaved;
      s.tokensSaved += l.payoff.tokensSaved;
    }
  }
  s.inForce = byStatus.bound;
  s.processTypes = processTypes.size;
  s.codeAreas = codeAreas.size;
  return s;
}

export interface PayoffRow {
  lesson: LessonDTO;
  prevented: number;
  usdSaved: number;
  msSaved: number;
  /** Exposures since binding: how much evidence stands behind the number. */
  exposuresAfter: number;
}

/** Lessons with a measurable payoff, best first; negative values mean the lesson is not working (prune it). */
export function payoffRows(lessons: readonly LessonDTO[]): PayoffRow[] {
  return lessons
    .filter((l) => everBound(l) && l.payoff?.measurable)
    .map((l) => ({
      lesson: l,
      prevented: l.payoff!.repeatsPrevented,
      usdSaved: l.payoff!.usdSaved,
      msSaved: l.payoff!.msSaved,
      exposuresAfter: l.payoff!.exposuresAfter,
    }))
    .sort((a, b) => b.prevented - a.prevented || b.usdSaved - a.usdSaved);
}

/** Share of the retirement threshold already used up by consecutive unused runs (0..1). */
export function retirementProgress(l: LessonDTO): number {
  const limit = l.usage.retireAfterUnusedRuns;
  return limit > 0 ? Math.min(1, l.usage.unusedStreak / limit) : 0;
}

/** Lessons in force that are halfway or more to automatic retirement, closest first. */
export function retirementCandidates(lessons: readonly LessonDTO[], threshold = 0.5): LessonDTO[] {
  return lessons
    .filter((l) => l.status === 'bound' && l.usage.unusedStreak > 0 && retirementProgress(l) >= threshold)
    .sort(
      (a, b) => retirementProgress(b) - retirementProgress(a) || b.usage.unusedStreak - a.usage.unusedStreak,
    );
}

export interface PendingLessonDecision {
  decision: DecisionCardView;
  /** The proposed lesson behind the decision, when it is in the registry. */
  lesson: LessonDTO | null;
}

/** Open lesson-binding decisions, oldest first, each joined to its proposed lesson. */
export function pendingDecisions(
  decisions: readonly DecisionCardView[],
  lessons: readonly LessonDTO[],
): PendingLessonDecision[] {
  const byDecision = new Map(lessons.map((l) => [l.decisionId, l]));
  const bySubject = new Map(lessons.map((l) => [l.lessonId, l]));
  return decisions
    .filter((d) => d.kind === 'lesson_binding' && d.status === 'open')
    .map((d) => ({ decision: d, lesson: byDecision.get(d.id) ?? bySubject.get(d.subjectId) ?? null }))
    .sort((a, b) => a.decision.createdAt.localeCompare(b.decision.createdAt));
}

/** Why the viewer cannot decide, in words (the decision page still enforces it). */
export function blockedReason(d: DecisionCardView): string | null {
  if (d.viewer.canResolve) return null;
  switch (d.viewer.reason) {
    case 'separation_of_duties':
      return 'You proposed it, so another Approver decides.';
    case 'role':
      return 'An Approver decides lesson binding.';
    case 'not_eligible':
      return 'You are not eligible to decide this one.';
    case 'inactive':
      return 'Your account is inactive.';
    default:
      return 'You cannot decide this one.';
  }
}

/**
 * Repeat offences that have a stated fix but no lesson yet (or only rejected / retired ones): the next
 * candidates to distil. An error earns a lesson only as a repeatable class with a stated fix (§11).
 */
export function readyToDistil(offences: readonly OffenceDTO[], lessons: readonly LessonDTO[]): OffenceDTO[] {
  const covered = new Set(
    lessons
      .filter((l) => l.classId && (l.status === 'bound' || l.status === 'proposed'))
      .map((l) => l.classId!),
  );
  return offences
    .filter((o) => o.fix !== null && !covered.has(o.classId))
    .sort((a, b) => b.costOfRecurrenceUsd - a.costOfRecurrenceUsd);
}

export type StatusFilter = 'all' | LessonStatus;

export function filterLessons(lessons: readonly LessonDTO[], status: StatusFilter): LessonDTO[] {
  return status === 'all' ? [...lessons] : lessons.filter((l) => l.status === status);
}

/** Lesson events plus lesson-binding decisions (withdrawn/expired/escalated events carry no kind). */
export function isKnowledgeEvent(type: string, meta: Readonly<Record<string, unknown>>): boolean {
  if (type.startsWith('lesson.') || type.startsWith('rootcause.') || type.startsWith('offence.')) return true;
  if (!type.startsWith('decision.')) return false;
  return meta.kind === undefined || meta.kind === 'lesson_binding';
}
