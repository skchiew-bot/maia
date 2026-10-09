import { describe, expect, it } from 'vitest';
import type { StreamMessage } from '../../src/api';
import {
  buildLanes,
  changesMap,
  currentPhaseIndex,
  eventWord,
  feedItem,
  livenessCounts,
  phaseSegments,
  pushFeed,
  trackOf,
} from '../../src/pages/showcase/model';
import { CONSOLE, DECISIONS, manifest, PROJECTS, session } from './fixtures';

const aoc = (
  type: string,
  seq: number,
  sessionId?: string,
  meta: Record<string, unknown> = {},
): StreamMessage => ({
  kind: 'aoc',
  event: { seq, type, ts: '2026-10-09T05:40:00Z', scope: sessionId ? { sessionId } : {}, meta },
});

describe('showcase model', () => {
  it('lays a plan out as phases in plan order, sized by declared weight, removed tasks excluded', () => {
    const phases = phaseSegments(manifest(['t1', 't3']));
    expect(phases).toEqual([
      { phaseId: 'design', name: 'Design', total: 5, done: 2, start: 0 },
      { phaseId: 'build', name: 'Build', total: 10, done: 5, start: 5 },
      { phaseId: 'verify', name: 'Verify', total: 2, done: 0, start: 15 },
    ]);
    expect(currentPhaseIndex(phases)).toBe(0);
    expect(currentPhaseIndex(phaseSegments(manifest(['t1', 't2'])))).toBe(1);
    expect(currentPhaseIndex(phaseSegments(manifest(['t1', 't2', 't3', 't4', 't5', 't6'])))).toBe(2);
    expect(currentPhaseIndex([])).toBe(-1);
  });

  it('makes a track from a session and its manifest', () => {
    const t = trackOf(session({ sessionId: 's', throttledUntil: null }), manifest(['t1', 't2', 't3']));
    expect(t).toMatchObject({
      totalWeight: 17,
      doneWeight: 10,
      currentPhase: 1,
      liveness: 'working',
      finished: false,
      decision: null,
    });
    expect(trackOf(session({ sessionId: 'e', lifecycle: 'ended', liveness: null }), undefined)).toMatchObject(
      {
        finished: true,
        liveness: null,
        phases: [],
        currentPhase: -1,
      },
    );
  });

  it('groups tracks into project lanes by §4 precedence and keeps decisions no track carries', () => {
    const manifests = new Map([['ses_work', manifest(['t1'])]]);
    const lanes = buildLanes({ console: CONSOLE, projects: PROJECTS, manifests, decisions: DECISIONS });
    expect(lanes.map((l) => l.name)).toEqual([
      'AOC Platform',
      'Claims Intake Bot',
      'CX Copilot',
      'Across projects',
    ]);
    const cx = lanes.find((l) => l.projectId === 'prj_cx')!;
    expect(cx.progressPct).toBe(76.8);
    expect(cx.tracks.map((t) => t.sessionId)).toEqual(['ses_thr', 'ses_work', 'ses_done']);
    expect(cx.decisions.map((d) => d.label)).toEqual(['Fix plan']);
    // The agent decision travels with its session, not as a loose diamond.
    const claims = lanes.find((l) => l.projectId === 'prj_claims')!;
    expect(claims.decisions).toEqual([]);
    expect(claims.tracks[0]!.decision).toMatchObject({ kind: 'agent_decision' });
    expect(lanes[3]!.decisions.map((d) => d.label)).toEqual(['Credit top-up']);
    expect(Object.fromEntries(livenessCounts(lanes))).toEqual({
      working: 1,
      waiting_on_you: 1,
      throttled: 1,
      stalled: 1,
    });
  });

  it('refreshes the map only for events that change it', () => {
    expect(changesMap(aoc('task.done', 1, 's'))).toBe(true);
    expect(changesMap(aoc('decision.requested', 2))).toBe(true);
    expect(changesMap({ kind: 'liveness', event: { sessionId: 's', state: 'stalled', since: 'x' } })).toBe(
      true,
    );
    expect(changesMap(aoc('tool.used', 3, 's'))).toBe(false);
    expect(changesMap(aoc('fx.rate_recorded', 4))).toBe(false);
  });

  it('writes the feed in words, folds tool-call bursts and drops metering chatter', () => {
    expect(eventWord('task.done')).toBe('Task done');
    expect(eventWord('ticket.fix_plan_submitted')).toBe('Fix plan submitted');
    expect(feedItem(aoc('usage.recorded', 1, 's'))).toBeNull();
    expect(feedItem(aoc('decision.requested', 2, undefined, { kind: 'fix_plan' }))).toMatchObject({
      word: 'Decision requested',
      detail: 'Fix plan',
    });
    expect(
      feedItem({
        kind: 'liveness',
        event: { sessionId: 's', state: 'throttled', since: '2026-10-09T05:41:00Z' },
      }),
    ).toMatchObject({
      word: 'Now throttled',
      liveness: 'throttled',
    });
    let feed = pushFeed([], feedItem(aoc('tool.used', 3, 's', { toolName: 'Read' }))!, 3);
    feed = pushFeed(feed, feedItem(aoc('tool.used', 4, 's', { toolName: 'Edit' }))!, 3);
    feed = pushFeed(feed, feedItem(aoc('tool.used', 5, 's', { toolName: 'Bash' }))!, 3);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ kind: 'tool', count: 3 });
    feed = pushFeed(feed, feedItem(aoc('task.done', 6, 's'))!, 3);
    feed = pushFeed(feed, feedItem(aoc('tool.used', 7, 's'))!, 3);
    feed = pushFeed(feed, feedItem(aoc('phase.completed', 8, 's'))!, 3);
    expect(feed.map((f) => f.word)).toEqual(['Phase completed', 'Tool calls', 'Task done']);
  });
});
