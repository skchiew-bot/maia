import { describe, expect, it } from 'vitest';
import {
  etaText,
  evidenceRef,
  isEnded,
  livenessDetail,
  modelLabel,
  outcomeText,
  phaseLabel,
  sessionLiveness,
  shortId,
} from '../../src/pages/sessions/sessionText';
import { formatClock } from '../../src/lib/format';
import { ago, iso, MIN, NOW, progress, summary } from './fixtures';

describe('sessionLiveness', () => {
  it('uses the daemon state, and terminal states once the session is over', () => {
    expect(sessionLiveness(summary())).toBe('working');
    expect(sessionLiveness(summary({ lifecycle: 'ended', liveness: null }))).toBe('ended');
    expect(sessionLiveness(summary({ lifecycle: 'retired', liveness: { state: null, reason: 'retired', since: ago(1) } }))).toBe('retired');
    expect(sessionLiveness(summary({ lifecycle: 'failed', liveness: null }))).toBe('dead');
    expect(sessionLiveness(summary({ lifecycle: 'launching', liveness: null }))).toBe('thinking');
    expect(isEnded(summary({ lifecycle: 'failed' }))).toBe(false);
  });
});

describe('livenessDetail', () => {
  const at = (state: 'working' | 'thinking' | 'stalled' | 'dead' | 'throttled' | 'waiting_on_you', reason: string, minutes = 14) =>
    summary({ liveness: { state, reason, since: ago(minutes) } });

  it('says why and since when, per state', () => {
    expect(livenessDetail(summary({ liveness: { state: 'waiting_on_you', reason: 'open_decision', since: ago(5) }, openDecision: { decisionId: 'dec_1', kind: 'agent_decision', createdAt: ago(134) } }), NOW)).toBe('decision 2h 14m');
    expect(livenessDetail(at('waiting_on_you', 'turn_ended', 3), NOW)).toBe('turn ended 3m');
    expect(livenessDetail(summary({ liveness: { state: 'throttled', reason: 'plan_limit', since: ago(2) }, throttledUntil: iso(NOW + 23 * MIN) }), NOW)).toBe(
      `resets ${formatClock(NOW + 23 * MIN)}`,
    );
    expect(livenessDetail(at('throttled', 'plan_limit'), NOW)).toBe('reset time unknown');
    expect(livenessDetail(at('dead', 'no_heartbeat', 21), NOW)).toBe('no heartbeat 21m');
    expect(livenessDetail(at('dead', 'never_reported'), NOW)).toBe('never reported');
    expect(livenessDetail(at('stalled', 'no_activity', 11), NOW)).toBe('no output 11m');
    expect(livenessDetail(at('thinking', 'streaming', 2), NOW)).toBe('generating 2m');
    expect(livenessDetail(at('working', 'recent_tool', 40), NOW)).toBe('for 40m');
    expect(livenessDetail(summary({ lifecycle: 'ended', liveness: null, endedAt: ago(30) }), NOW)).toBe(formatClock(NOW - 30 * MIN));
  });
});

describe('etaText', () => {
  it('hides the ETA until three tasks are done and never shows a clock while the session is not moving', () => {
    expect(etaText(null, 'working', NOW)).toBe('No plan declared');
    expect(etaText(progress({ doneTasks: 2 }), 'working', NOW)).toBe('ETA after 3 tasks');
    const p = progress({ doneTasks: 4, etaMs: 90 * MIN, etaHiddenReason: null });
    expect(etaText(p, 'working', NOW)).toBe(`ETA ${formatClock(NOW + 90 * MIN)}`);
    expect(etaText(p, 'waiting_on_you', NOW)).toBe('ETA paused');
    expect(etaText(p, 'throttled', NOW)).toBe('ETA paused');
    expect(etaText(p, 'stalled', NOW)).toBe('ETA on hold');
    expect(etaText(p, 'dead', NOW)).toBe('ETA —');
    expect(etaText(progress({ etaHiddenReason: 'complete' }), 'ended', NOW)).toBe('Plan complete');
  });
});

describe('labels', () => {
  it('names models, phases, outcomes and evidence', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus');
    expect(modelLabel('claude-haiku-5-5')).toBe('Haiku');
    expect(modelLabel('gpt-x')).toBe('gpt-x');
    expect(modelLabel(null)).toBeNull();
    expect(phaseLabel({ phaseId: 'b', name: 'Build', index: 2, count: 3 })).toBe('P2 Build');
    expect(outcomeText(summary({ lifecycle: 'retired', outcome: 'retired' }))).toBe('Rolled over to a fresh session');
    expect(outcomeText(summary({ lifecycle: 'ended', outcome: 'completed', progress: progress({ etaHiddenReason: 'complete' }) }))).toBe('Completed, plan done');
    expect(outcomeText(summary({ lifecycle: 'ended', outcome: 'abandoned' }))).toBe('Stopped before finishing, 2 of 6 tasks');
    expect(evidenceRef('commit', '1f0b7aa94c2e5d')).toBe('1f0b7aa');
    expect(evidenceRef('test', 'panel.test.ts > renders')).toBe('panel.test.ts > renders');
    expect(shortId('ses_01M4F9696ZWB27CGPZE9KKNW4B')).toBe('…KKNW4B');
  });
});
