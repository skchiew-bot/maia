import { describe, expect, it } from 'vitest';
import {
  anchorAge,
  chainCoverage,
  healthWarningText,
  parseProofRef,
  parseScopeFilter,
  parseTypeFilter,
  rangeCutoff,
  validScopeId,
  verifyVerdict,
  withinRange,
} from '../../src/pages/audit/model';
import { HOUR, NOW, ago, auditEvent, verifyReport } from '../governance/fixtures';

describe('audit model', () => {
  it('measures how much of the chain an anchor protects', () => {
    const cov = chainCoverage(4000, [{ seq: 1000 }, { seq: 3000 }, { seq: 3000 }, { seq: 5000 }]);
    expect(cov).toEqual({
      headSeq: 4000,
      anchoredThrough: 3000,
      unanchored: 1000,
      ratio: 0.75,
      ticks: [
        { seq: 1000, at: 0.25 },
        { seq: 3000, at: 0.75 },
      ],
    });
    expect(chainCoverage(10, [])).toMatchObject({ anchoredThrough: 0, unanchored: 10, ratio: 0 });
    expect(chainCoverage(0, [])).toMatchObject({ headSeq: 0, ratio: 0 });
  });

  it('warns when the last anchor is older than the threshold, or missing', () => {
    expect(anchorAge(ago(3 * HOUR), NOW)).toEqual({ ageMs: 3 * HOUR, stale: false });
    expect(anchorAge(ago(27 * HOUR), NOW)).toEqual({ ageMs: 27 * HOUR, stale: true });
    expect(anchorAge(ago(2 * HOUR), NOW, HOUR)).toEqual({ ageMs: 2 * HOUR, stale: true });
    expect(anchorAge(null, NOW)).toEqual({ ageMs: null, stale: true });
  });

  it('proves integrity only against off-host anchors', () => {
    expect(verifyVerdict(verifyReport(), true)).toMatchObject({
      tone: 'ok',
      title: 'Verified against 1 off-host anchor',
    });
    expect(verifyVerdict(verifyReport(), false)).toMatchObject({
      tone: 'warn',
      title: 'Matches 1 anchor, but they are local only',
    });
    expect(verifyVerdict(verifyReport({ anchors: [] }), true)).toMatchObject({
      tone: 'warn',
      title: 'Not proven: no anchor to verify against',
    });
    const mismatch = verifyReport();
    mismatch.anchors = [{ ...mismatch.anchors[0]!, matched: false, recomputedHash: 'ff'.repeat(32) }];
    expect(verifyVerdict({ ...mismatch, ok: false }, true)).toMatchObject({
      tone: 'danger',
      title: '1 of 1 anchors do not match',
    });
    expect(verifyVerdict(verifyReport({ ok: false, chainOk: false, firstBadSeq: 2041 }), true)).toMatchObject(
      {
        tone: 'danger',
        title: 'Chain broken at #2041',
      },
    );
    expect(
      verifyVerdict(verifyReport({ ok: false, problems: ['anchor proof unreadable'] }), true),
    ).toMatchObject({
      tone: 'danger',
      detail: 'anchor proof unreadable',
    });
  });

  it('reads a git anchor’s proof reference', () => {
    expect(
      parseProofRef('git:0828e4752437395aca28b7b5f8acfc610c0af6c1:anchors/2026-10-09-3149.json'),
    ).toEqual({
      kind: 'git',
      commit: '0828e4752437395aca28b7b5f8acfc610c0af6c1',
      path: 'anchors/2026-10-09-3149.json',
    });
    expect(parseProofRef('rfc3161:token-hash')).toEqual({ kind: 'other', ref: 'rfc3161:token-hash' });
  });

  it('turns the type filter into a family prefix or exact types, ignoring anything else', () => {
    expect(parseTypeFilter('')).toEqual({});
    expect(parseTypeFilter('change.')).toEqual({ typePrefix: 'change.' });
    expect(parseTypeFilter('change')).toEqual({ typePrefix: 'change.' });
    expect(parseTypeFilter(' Change.Submitted ')).toEqual({ type: 'change.submitted' });
    expect(parseTypeFilter('change.submitted, change.approved')).toEqual({
      type: 'change.submitted,change.approved',
    });
    expect(parseTypeFilter('drop table; --')).toEqual({});
  });

  it('routes a typed scope id to the matching filter', () => {
    expect(parseScopeFilter('ses_01ABC')).toEqual({ sessionId: 'ses_01ABC' });
    expect(parseScopeFilter('tkt_01ABC')).toEqual({ ticketId: 'tkt_01ABC' });
    expect(parseScopeFilter('prj_claims')).toEqual({ projectId: 'prj_claims' });
    expect(parseScopeFilter('usr_1')).toEqual({});
  });

  it('keeps events inside the chosen time range', () => {
    const recent = auditEvent(10, 'change.drafted', { ts: ago(30 * 60_000) });
    const old = auditEvent(9, 'change.drafted', { ts: ago(2 * HOUR) });
    expect(rangeCutoff('all', NOW)).toBeNull();
    expect(withinRange([recent, old], rangeCutoff('1h', NOW))).toEqual([recent]);
    expect(withinRange([recent, old], rangeCutoff('24h', NOW))).toEqual([recent, old]);
  });

  it('accepts body scope ids as mod-audit does and words health warnings', () => {
    expect(validScopeId('ses_01M4FAFKJ0HS6W702V2VZ0N2MV')).toBe(true);
    expect(validScopeId('user:usr_1')).toBe(true);
    expect(validScopeId('bad scope')).toBe(false);
    expect(validScopeId('')).toBe(false);
    expect(healthWarningText('anchor_not_off_host')).toMatch(/do not yet mitigate R2/);
    expect(healthWarningText('something_new')).toBe('something_new');
  });
});
