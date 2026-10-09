import { describe, expect, it } from 'vitest';
import { refLinks } from '../../src/pages/knowledge/KnowledgeSearch';
import {
  blockedReason,
  filterLessons,
  isKnowledgeEvent,
  payoffRows,
  pendingDecisions,
  readyToDistil,
  retirementCandidates,
  retirementProgress,
  summarise,
} from '../../src/pages/knowledge/model';
import { codeAreaProblem } from '../../src/pages/knowledge/ProposeLessonDialog';
import { offence } from '../learning/fixtures';
import { DECISIONS, LESSONS, lesson } from './fixtures';

describe('lessons registry summary', () => {
  it('counts by status and scope, and sums payoff only where it is measurable', () => {
    const s = summarise(LESSONS);
    expect(s.byStatus).toEqual({ proposed: 1, bound: 2, retired: 1, rejected: 1 });
    expect(s.inForce).toBe(2);
    expect(s.processTypes).toBe(1);
    expect(s.codeAreas).toBe(1);
    expect(s.measurable).toBe(2);
    expect(s.repeatsPrevented).toBeCloseTo(0.5, 6);
    expect(s.usdSaved).toBeCloseTo(0.84, 6);
  });

  it('lists payoff best first, keeping lessons that are not working (negative) visible', () => {
    expect(payoffRows(LESSONS).map((r) => [r.lesson.lessonId, r.prevented])).toEqual([
      ['les_sql', 2],
      ['les_env', -1.5],
    ]);
  });

  it('flags lessons in force that are halfway or more to automatic retirement', () => {
    expect(retirementProgress(LESSONS[3]!)).toBeCloseTo(0.6, 6);
    expect(retirementCandidates(LESSONS).map((l) => l.lessonId)).toEqual(['les_env']);
    expect(retirementCandidates(LESSONS, 0.7)).toEqual([]);
  });

  it('filters by status', () => {
    expect(filterLessons(LESSONS, 'all')).toHaveLength(5);
    expect(filterLessons(LESSONS, 'bound').map((l) => l.lessonId)).toEqual(['les_sql', 'les_env']);
  });
});

describe('pending lesson decisions', () => {
  it('joins each open binding decision to its lesson, oldest first, and keeps orphans', () => {
    const pending = pendingDecisions(DECISIONS, LESSONS);
    expect(pending.map((p) => [p.decision.id, p.lesson?.lessonId ?? null])).toEqual([
      ['dec_orphan', null],
      ['dec_les_pending', 'les_pending'],
    ]);
  });

  it('explains why the viewer cannot decide', () => {
    expect(blockedReason(DECISIONS[0]!)).toBeNull();
    expect(blockedReason(DECISIONS[1]!)).toBe('You proposed it, so another Approver decides.');
  });
});

describe('ready to distil', () => {
  it('offers repeat offences with a stated fix and no active lesson, costliest first', () => {
    const offences = [
      offence({ offenceId: 'o1', classId: 'rcc_sql', className: 'SQL', fix: 'x', costOfRecurrenceUsd: 9 }),
      offence({ offenceId: 'o2', classId: 'rcc_spec', className: 'Spec', fix: 'y', costOfRecurrenceUsd: 3 }),
      offence({ offenceId: 'o3', classId: 'rcc_new', className: 'New', fix: 'z', costOfRecurrenceUsd: 5 }),
      offence({ offenceId: 'o4', classId: 'rcc_nofix', className: 'No fix', costOfRecurrenceUsd: 50 }),
    ];
    // rcc_sql has a bound lesson; rcc_spec's lesson was rejected, so it is a candidate again
    expect(readyToDistil(offences, LESSONS).map((o) => o.classId)).toEqual(['rcc_new', 'rcc_spec']);
  });
});

describe('scope rules', () => {
  it('accepts a repo-relative code area and refuses global or absolute ones', () => {
    expect(codeAreaProblem('src/config')).toBeNull();
    expect(codeAreaProblem('./packages/web/')).toBeNull();
    expect(codeAreaProblem('')).toMatch(/repo-relative/);
    expect(codeAreaProblem('/etc/app')).toMatch(/relative to the repository root/);
    expect(codeAreaProblem('**')).toMatch(/global/);
    expect(codeAreaProblem('src/../secrets')).toMatch(/“\.\.”/);
    expect(codeAreaProblem('src/con fig')).toMatch(/Letters/);
  });
});

describe('stream filter and search links', () => {
  it('refreshes on lesson events and lesson-binding decisions only', () => {
    expect(isKnowledgeEvent('lesson.bound', {})).toBe(true);
    expect(isKnowledgeEvent('decision.resolved', { kind: 'lesson_binding' })).toBe(true);
    expect(isKnowledgeEvent('decision.withdrawn', { decisionId: 'd' })).toBe(true);
    expect(isKnowledgeEvent('decision.resolved', { kind: 'credit_topup' })).toBe(false);
    expect(isKnowledgeEvent('tool.used', {})).toBe(false);
  });

  it('turns knowledge references into console links', () => {
    expect(refLinks({ lessonId: 'les_1', decisionId: 'dec_1', ticketId: 'tkt_1' })).toEqual([
      { to: '/knowledge?lesson=les_1', label: 'Lesson' },
      { to: '/tickets/tkt_1', label: 'Ticket' },
      { to: '/decisions?focus=dec_1', label: 'Decision' },
    ]);
  });

  it('never counts a proposed lesson toward payoff', () => {
    expect(
      summarise([lesson({ lessonId: 'p', rule: 'r', status: 'proposed', boundAt: null })]).measurable,
    ).toBe(0);
  });
});
