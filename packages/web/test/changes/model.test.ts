import { describe, expect, it } from 'vitest';
import { BLIND_AFFIRM_DWELL_MS } from '@aoc/contracts';
import {
  BLIND_DWELL_MS,
  authorship,
  blockedBySoleApprover,
  buildPipeline,
  canActOn,
  fieldState,
  lifecycleSegments,
  needsAttention,
  pipelineBottleneck,
  stageSince,
  submitGate,
} from '../../src/pages/changes/model';
import {
  AISYAH,
  CEO,
  HOUR,
  MIN,
  NOW,
  PRIYA,
  WEIJIE,
  ago,
  change,
  demoChanges,
  field,
  fourFields,
} from '../governance/fixtures';

describe('change model', () => {
  it('mirrors the contract’s blind-confirm threshold', () => {
    expect(BLIND_DWELL_MS).toBe(BLIND_AFFIRM_DWELL_MS);
  });

  it('builds the pipeline with counts, ages per open stage and lead time for closed ones', () => {
    const stages = buildPipeline(demoChanges(), NOW);
    const by = Object.fromEntries(stages.map((s) => [s.status, s]));
    expect(stages.map((s) => s.status)).toEqual([
      'draft',
      'submitted',
      'approved',
      'in_progress',
      'completed',
      'rejected',
    ]);
    expect(by.draft!.count).toBe(2);
    expect(by.submitted!.count).toBe(2);
    // Oldest waiting approval was submitted 170 minutes ago; the other 30 minutes ago.
    expect(by.submitted!.oldestAgeMs).toBe(170 * MIN);
    expect(by.submitted!.medianAgeMs).toBe(100 * MIN);
    expect(by.in_progress!.oldestAgeMs).toBe(170 * MIN);
    // Closed stages carry no "oldest" age, only the median draft-to-close lead time.
    expect(by.completed!.terminal).toBe(true);
    expect(by.completed!.oldestAgeMs).toBeUndefined();
    expect(by.completed!.medianAgeMs).toBe(30 * MIN);
    expect(by.rejected!.medianAgeMs).toBe(30 * MIN);
  });

  it('names the open stage holding the most waiting time as the bottleneck', () => {
    const stages = buildPipeline(demoChanges(), NOW);
    expect(pipelineBottleneck(stages)).toBe('draft');
    const onlyClosed = buildPipeline(
      demoChanges().filter((c) => c.status === 'completed'),
      NOW,
    );
    expect(pipelineBottleneck(onlyClosed)).toBeUndefined();
  });

  it('dates each record by the moment it entered its stage', () => {
    const [draft, submitted, , inProgress] = demoChanges();
    expect(stageSince(draft!)).toBe(draft!.createdAt);
    expect(stageSince(submitted!)).toBe(submitted!.submittedAt);
    expect(stageSince(inProgress!)).toBe(inProgress!.sessions[0]!.startedAt);
  });

  it('will not submit until all four fields are affirmed and a rollback target is named', () => {
    const draft = demoChanges()[0]!;
    expect(submitGate(draft)).toEqual({
      ready: false,
      missing: ['rollbackPlan', 'acceptanceTest'],
      needsRollbackRef: true,
    });
    const allFields = change({ fields: fourFields(), affirmedCount: 4 });
    expect(submitGate(allFields)).toEqual({ ready: false, missing: [], needsRollbackRef: true });
    const blank = change({
      fields: [...fourFields().slice(0, 3), field('acceptanceTest', '   ')],
      rollbackRef: 'aoc/phase/claims-v1.2',
    });
    expect(submitGate(blank).missing).toEqual(['acceptanceTest']);
    expect(submitGate(change({ fields: fourFields(), rollbackRef: 'aoc/phase/claims-v1.2' })).ready).toBe(
      true,
    );
  });

  it('separates who wrote a field from who affirmed it', () => {
    const ai = { draftedBy: 'ai' as const };
    const human = { draftedBy: 'human' as const };
    const drafted = field('impact', null, { draft: 'AI draft text', value: null });
    expect(authorship(ai, drafted)).toEqual({ wrote: 'ai', summary: 'not yet affirmed or edited' });
    expect(authorship(human, field('impact', null))).toEqual({ wrote: 'nobody', summary: 'not written yet' });
    expect(authorship(human, field('impact', 'Mine'))).toEqual({
      wrote: 'developer',
      summary: 'no AI draft',
    });
    expect(authorship(ai, field('impact', 'Rewritten', { draft: 'AI draft text', edited: true }))).toEqual({
      wrote: 'developer',
      summary: 'edited the AI draft',
    });
    expect(
      authorship(
        ai,
        field('impact', 'AI draft text', { draft: 'AI draft text', edited: false, editRatio: 0 }),
      ),
    ).toEqual({ wrote: 'ai', summary: 'affirmed without edit' });
  });

  it('flags blind one-click confirms and shredded text', () => {
    expect(fieldState(field('impact', null), false)).toBe('pending');
    expect(fieldState(field('impact', 'x', { blind: true, edited: false }), false)).toBe('blind');
    expect(fieldState(field('impact', 'x', { edited: false }), false)).toBe('affirmed');
    expect(fieldState(field('impact', 'x'), false)).toBe('edited');
    expect(fieldState(field('impact', null, { affirmed: true }), true)).toBe('erased');
  });

  it('lets only the owner or an Approver act on a record', () => {
    const c = change({ ownerId: WEIJIE.id });
    expect(canActOn(c, WEIJIE)).toBe(true);
    expect(canActOn(c, CEO)).toBe(true);
    expect(canActOn(c, AISYAH)).toBe(false);
    expect(canActOn(c, null)).toBe(false);
  });

  it('blocks a request raised by the only Approver (sole-Approver fallback off)', () => {
    expect(blockedBySoleApprover(CEO.id, [{ id: CEO.id }])).toBe(true);
    expect(blockedBySoleApprover(WEIJIE.id, [{ id: CEO.id }])).toBe(false);
    expect(blockedBySoleApprover(CEO.id, [{ id: CEO.id }, { id: 'usr_second' }])).toBe(false);
    expect(blockedBySoleApprover(null, [{ id: CEO.id }])).toBe(false);
  });

  it('asks for a human on waiting approvals and open post-incident records', () => {
    const all = demoChanges();
    expect(all.filter(needsAttention).map((c) => c.title)).toEqual([
      'Enable RFC 3161 timestamping for production anchors',
      'Partition interaction history by month',
      'Post-incident review for break-glass brk_01M4FDC17SR530WMYBDYVHJW16',
    ]);
  });

  it('splits a record’s time into drafting, approval wait, ready and in progress', () => {
    const inProgress = demoChanges()[3]!;
    const segs = lifecycleSegments(inProgress, NOW);
    expect(segs.map((s) => [s.id, s.to - s.from, s.ongoing])).toEqual([
      ['drafting', 5 * MIN, false],
      ['approval', 1 * MIN, false],
      ['ready', 4 * MIN, false],
      ['building', 170 * MIN, true],
    ]);

    // Self-approved: no approval wait; completed without a session runs approval → completion.
    const selfApproved = change({
      createdAt: ago(3 * HOUR),
      submittedAt: ago(2 * HOUR),
      submittedBy: PRIYA.id,
      approval: { approverId: PRIYA.id, selfApproved: true, at: ago(2 * HOUR) },
      completedAt: ago(HOUR),
      status: 'completed',
    });
    expect(lifecycleSegments(selfApproved, NOW).map((s) => [s.id, s.label, s.ongoing])).toEqual([
      ['drafting', 'Drafting', false],
      ['ready', 'Approved to completed', false],
    ]);

    const rejected = demoChanges().find((c) => c.status === 'rejected')!;
    expect(lifecycleSegments(rejected, NOW).map((s) => s.id)).toEqual(['drafting', 'approval']);
  });
});
