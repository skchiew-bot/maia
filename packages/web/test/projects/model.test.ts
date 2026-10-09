import { describe, expect, it } from 'vitest';
import { ApiError } from '../../src/api';
import { niceMax } from '../../src/pages/projects/BurnUp';
import { errorsOf, projectChanges } from '../../src/pages/projects/dialogs';
import { bucketCloses, clusterEvents, dayTicks, type LaneEvent } from '../../src/pages/projects/lanes';
import {
  attentionFor,
  attentionLabel,
  buildPeople,
  contributorsOf,
  currentPhase,
  isLiveSession,
  isSha,
  lastSevenDays,
  livenessCounts,
  orderedCounts,
  phaseStatsFromManifest,
  phaseStatsFromRollup,
  shortId,
  totalsOf,
} from '../../src/pages/projects/model';
import { matchesTaskFilter } from '../../src/pages/projects/TaskTable';
import { CX_TIMELINE, NOW, ROLLUPS, SESSIONS, SUMMARIES, USERS } from './fixtures';

const HOUR = 3_600_000;

describe('phase statistics (§9)', () => {
  it('weights tasks by declared size, keeps flagged closes in the done weight and drops removed tasks', () => {
    const stats = phaseStatsFromManifest(CX_TIMELINE.manifest);
    expect(stats.map((p) => [p.index, p.name, p.state])).toEqual([
      [1, 'Design', 'done'],
      [2, 'Build', 'active'],
      [3, 'Verify', 'pending'],
    ]);
    expect(stats[0]).toMatchObject({
      doneWeight: 5,
      totalWeight: 5,
      flaggedWeight: 3,
      flaggedTasks: 1,
      doneTasks: 2,
    });
    // t5 was removed by an amendment: not in the denominator.
    expect(stats[1]).toMatchObject({ doneWeight: 3, totalWeight: 10, totalTasks: 3 });
    expect(totalsOf(stats)).toEqual({
      doneWeight: 8,
      flaggedWeight: 3,
      totalWeight: 17,
      doneTasks: 3,
      flaggedTasks: 1,
      totalTasks: 6,
    });
    expect(currentPhase(stats)?.name).toBe('Build');
  });

  it('orders roll-up phases by manifest order', () => {
    const shuffled = [...ROLLUPS[1]!.phases].reverse();
    expect(phaseStatsFromRollup(shuffled).map((p) => [p.index, p.id])).toEqual([
      [1, 'design'],
      [2, 'build'],
      [3, 'verify'],
    ]);
  });
});

describe('attribution', () => {
  const people = buildPeople(SESSIONS, [[USERS.weijie, 'Tan Wei Jie']]);

  it('resolves a session id to its developer and keeps unknown ids readable', () => {
    expect(people.resolve('ses_01CXDEAD000002')).toEqual({ id: USERS.priya, name: 'Priya Nair' });
    expect(people.resolve(USERS.weijie)).toEqual({ id: USERS.weijie, name: 'Tan Wei Jie' });
    expect(people.resolve('ses_01UNKNOWN99999')).toEqual({
      id: 'ses_01UNKNOWN99999',
      name: 'session …N99999',
    });
    expect(shortId('ses_01M4F99XFHZFENRS689DVVJW1N')).toBe('…VVJW1N');
  });

  it('lists contributors in order of first declaration with their share of the phase', () => {
    const build = CX_TIMELINE.manifest[1]!;
    expect(contributorsOf(build, people)).toEqual([
      {
        id: USERS.weijie,
        name: 'Tan Wei Jie',
        doneWeight: 3,
        flaggedWeight: 0,
        totalWeight: 10,
        doneTasks: 1,
        totalTasks: 3,
      },
    ]);
    const design = CX_TIMELINE.manifest[0]!;
    expect(contributorsOf(design, people).map((c) => [c.name, c.flaggedWeight])).toEqual([
      ['Aisyah Rahman', 3],
    ]);
  });
});

describe('live mix (§4)', () => {
  it('counts live sessions and recent failures, in precedence order', () => {
    const counts = livenessCounts(SESSIONS, NOW);
    expect(counts).toEqual({ waiting_on_you: 1, dead: 1 });
    expect(orderedCounts({ working: 2, dead: 1, waiting_on_you: 1 })).toEqual([
      ['waiting_on_you', 1],
      ['dead', 1],
      ['working', 2],
    ]);
  });

  it('drops failures older than a day and every ended session', () => {
    const dead = SESSIONS[1]!;
    expect(isLiveSession(dead, NOW)).toBe(true);
    expect(isLiveSession(dead, NOW + 23 * HOUR)).toBe(false);
    expect(isLiveSession(SESSIONS[2]!, NOW)).toBe(false);
  });
});

describe('attention order', () => {
  it('scores blocking work first and explains itself in words', () => {
    const cx = attentionFor({
      summary: SUMMARIES[1]!,
      rollup: ROLLUPS[1],
      liveness: livenessCounts(SESSIONS, NOW),
      now: NOW,
    });
    expect(cx.reasons.map((r) => [r.kind, r.count])).toEqual([
      ['decisions', 1],
      ['dead', 1],
      ['drift_high', 1],
      ['flagged', 1],
      ['drift', 1],
      ['scope', 1],
    ]);
    expect(cx.score).toBe(40 + 30 + 15 + 4 + 3 + 2);
    expect(cx.reasons.map(attentionLabel)).toEqual([
      '1 decision open',
      '1 dead session',
      '1 high drift (7d)',
      '1 flagged close',
      '1 drift (7d)',
      '1 amendment (7d)',
    ]);
    const aoc = attentionFor({ summary: SUMMARIES[0]!, rollup: ROLLUPS[0], liveness: {}, now: NOW });
    expect(aoc).toEqual({ score: 0, reasons: [] });
  });

  it('flags a project with open work and no activity for three days as stale', () => {
    const quiet = {
      ...SUMMARIES[1]!,
      openDecisions: 0,
      lastActivityAt: new Date(NOW - 4 * 24 * HOUR).toISOString(),
    };
    const { reasons } = attentionFor({ summary: quiet, liveness: {}, now: NOW });
    expect(reasons.map((r) => r.kind)).toEqual(['stale', 'flagged']);
  });
});

describe('time lanes', () => {
  const scale = { start: Date.parse('2026-09-25T00:00:00Z'), end: NOW, now: NOW };

  it('labels day boundaries no closer than the label width', () => {
    const wide = dayTicks(scale, 1400);
    const narrow = dayTicks(scale, 320);
    expect(wide.length).toBeGreaterThan(narrow.length);
    expect(narrow.length).toBeGreaterThan(0);
  });

  it('stacks closes in the same pixels and merges nearby marks of a row with a count', () => {
    const x = (t: number) => (t - scale.start) / HOUR;
    expect(
      bucketCloses(
        [
          { at: scale.start + HOUR, flagged: false },
          { at: scale.start + HOUR, flagged: true },
          { at: scale.start + 50 * HOUR, flagged: false },
        ],
        x,
      ),
    ).toEqual([
      { x: 0, verified: 1, flagged: 1 },
      { x: 51, verified: 1, flagged: 0 },
    ]);
    const ev = (id: string, kind: LaneEvent['kind'], h: number): LaneEvent => ({
      id,
      kind,
      at: scale.start + h * HOUR,
      title: id,
    });
    const clusters = clusterEvents(
      [
        ev('a', 'drift', 10),
        ev('b', 'drift', 12),
        ev('c', 'amendment', 11),
        ev('d', 'enhancement', 13),
        ev('e', 'drift', 40),
      ],
      x,
    );
    expect(clusters.map((c) => [c.row, c.events.map((e) => e.id)])).toEqual([
      ['scope', ['c', 'd']],
      ['drift', ['a', 'b']],
      ['drift', ['e']],
    ]);
  });

  it('rounds the burn-up scale to a readable ceiling', () => {
    expect([niceMax(7), niceMax(141), niceMax(158), niceMax(1200)]).toEqual([10, 150, 200, 1500]);
  });
});

describe('tasks, values and forms', () => {
  it('filters tasks to open or flagged closes', () => {
    const tasks = CX_TIMELINE.manifest.flatMap((p) => p.tasks);
    expect(tasks.filter((t) => matchesTaskFilter(t, 'flagged')).map((t) => t.taskId)).toEqual(['t2']);
    expect(tasks.filter((t) => matchesTaskFilter(t, 'open')).map((t) => t.taskId)).toEqual([
      't4',
      't7',
      't6',
    ]);
  });

  it('recognises commit SHAs and the trailing seven calendar days', () => {
    expect(isSha('3558d66')).toBe(true);
    expect(isSha('api/t1.test.ts > passes')).toBe(false);
    expect(lastSevenDays(new Date(2026, 9, 9, 12).getTime())).toEqual({
      from: '2026-10-03',
      to: '2026-10-09',
    });
  });

  it('sends only changed project fields and never clears one with a blank', () => {
    const initial = { name: 'CX', description: 'Old', repoPath: '/srv/cx', defaultBranch: 'main' };
    expect(projectChanges(initial, { ...initial, description: ' New ', repoPath: '' })).toEqual({
      description: 'New',
    });
    expect(projectChanges(initial, initial)).toEqual({});
  });

  it('maps validation details to fields and refusals to one message', () => {
    expect(
      errorsOf(new ApiError(422, 'invalid', 'Validation failed', [{ path: 'name', message: 'Required' }])),
    ).toEqual({
      fields: { name: 'Required' },
      message: null,
    });
    expect(errorsOf(new ApiError(403, 'forbidden', 'Missing permission')).message).toMatch(
      /role cannot make this change/,
    );
    expect(errorsOf(new ApiError(0, 'network_error', 'Network request failed')).message).toBe(
      'The AOC daemon could not be reached.',
    );
  });
});
