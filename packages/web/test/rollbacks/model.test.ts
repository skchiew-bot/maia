import { describe, expect, it } from 'vitest';
import {
  displayRef,
  postIncidentState,
  promotionOutcome,
  rollbackTrack,
} from '../../src/pages/rollbacks/model';
import { CEO, HOUR, NOW, SHA_A, ago, ahead, breakglass, promotion, rollback } from '../governance/fixtures';

const states = (r: Parameters<typeof rollbackTrack>[0]) => rollbackTrack(r).map((s) => s.state);

describe('rollback model', () => {
  it('shows a full SHA as 12 characters and keeps tag names whole', () => {
    expect(displayRef(SHA_A)).toBe('c5e8cadc95f5');
    expect(displayRef('aoc/change/chg_01M4FDBZQ07K5AFQRTGWSKHCF0')).toBe(
      'aoc/change/chg_01M4FDBZQ07K5AFQRTGWSKHCF0',
    );
  });

  it('walks the gated flow: requested → verified on a branch → passkey → restored on main', () => {
    const queued = rollback({ status: 'requested', verification: null, decisionId: null });
    expect(states(queued)).toEqual(['done', 'current', 'pending', 'pending']);

    const waiting = rollback();
    expect(states(waiting)).toEqual(['done', 'done', 'current', 'pending']);
    expect(rollbackTrack(waiting)[1]!.detail).toBe('clean: 42 passed, 0 failed');

    const restoring = rollback({
      status: 'approved',
      approval: { approverId: CEO.id, passkeyVerified: true, at: ago(HOUR) },
    });
    expect(states(restoring)).toEqual(['done', 'done', 'done', 'current']);
    expect(rollbackTrack(restoring)[2]!.detail).toBe('approved with a verified passkey');

    const executed = rollback({
      status: 'executed',
      approval: { approverId: CEO.id, passkeyVerified: true, at: ago(HOUR) },
      execution: { mainShaBefore: 'a'.repeat(40), mainShaAfter: 'b'.repeat(40), at: ago(HOUR / 2) },
    });
    expect(states(executed)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('never asks for approval when the verification was not clean', () => {
    const dirty = rollback({
      status: 'not_clean',
      decisionId: null,
      verification: { ...rollback().verification!, clean: false, testsPassed: 0, testsFailed: 0 },
    });
    const track = rollbackTrack(dirty);
    expect(track.map((s) => s.state)).toEqual(['done', 'failed', 'skipped', 'skipped']);
    expect(track[1]!.detail).toBe('not clean: the test command failed');
    expect(track[2]!.detail).toBe('no approval requested: verification was not clean');
    expect(track[3]!.detail).toBe('main untouched');
  });

  it('says why an approved rollback was not executed and that main is unchanged', () => {
    const failed = rollback({
      status: 'failed',
      approval: { approverId: CEO.id, passkeyVerified: true, at: ago(HOUR) },
      failure: { reason: 'execution_error', detail: 'credential profile missing', at: ago(HOUR) },
    });
    const track = rollbackTrack(failed);
    expect(track.map((s) => s.state)).toEqual(['done', 'done', 'done', 'failed']);
    expect(track[3]!.detail).toBe('not executed: execution_error; main left unchanged');
  });

  it('counts the post-incident record down from the break-glass approval, then flags it overdue', () => {
    expect(postIncidentState(breakglass(), NOW)).toEqual({ kind: 'none' });
    const due = breakglass({
      status: 'approved',
      postIncidentChangeId: 'chg_post',
      postIncidentStatus: 'draft',
      dueAt: ahead(6 * HOUR),
    });
    expect(postIncidentState(due, NOW)).toEqual({
      kind: 'due',
      changeId: 'chg_post',
      dueAt: due.dueAt,
      remainingMs: 6 * HOUR,
      elapsedRatio: 0.75,
    });
    const late = { ...due, dueAt: ago(2 * HOUR) };
    expect(postIncidentState(late, NOW)).toEqual({
      kind: 'overdue',
      changeId: 'chg_post',
      dueAt: late.dueAt,
      overdueMs: 2 * HOUR,
    });
    expect(postIncidentState({ ...due, overdue: true }, NOW).kind).toBe('overdue');
    expect(postIncidentState({ ...late, postIncidentStatus: 'completed' }, NOW)).toEqual({
      kind: 'done',
      changeId: 'chg_post',
    });
  });

  it('states each promotion’s provenance outcome in words', () => {
    expect(promotionOutcome(promotion())).toMatchObject({
      label: 'Refused',
      tone: 'danger',
      detail: '2 orphan commits: no approved change record or fix plan',
    });
    expect(
      promotionOutcome(
        promotion({ status: 'refused', refusal: { reason: 'uat_missing', orphanShas: [], at: ago(HOUR) } }),
      ).detail,
    ).toBe('no passing UAT sign-off on the ticket');
    expect(promotionOutcome(promotion({ status: 'completed', refusal: null })).detail).toBe(
      'every commit traced through an approved gate',
    );
    expect(promotionOutcome(promotion({ status: 'completed', refusal: null, breakglass: true })).detail).toBe(
      'break-glass: provenance check waived and recorded (the sole exception)',
    );
    expect(
      promotionOutcome(
        promotion({
          status: 'failed',
          refusal: null,
          failure: { reason: 'execution_error', detail: null, at: ago(HOUR) },
        }),
      ),
    ).toMatchObject({
      label: 'Not executed',
      detail: 'approved, but the push failed (execution_error); main unchanged',
    });
    expect(promotionOutcome(promotion({ status: 'requested', refusal: null })).label).toBe(
      'Awaiting go-live',
    );
  });
});
