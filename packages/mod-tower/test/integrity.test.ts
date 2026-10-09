import { afterEach, describe, expect, it } from 'vitest';
import type { AocModule } from '@aoc/kernel';
import {
  ago,
  anchored,
  changeCompleted,
  DAY,
  decide,
  hours,
  minutes,
  NOW,
  resolveDecision,
  setup,
  sys,
  verified,
  type Harness,
} from './helpers';

let h: Harness;
afterEach(async () => h?.close());

const iso = (ms: number) => new Date(ms).toISOString();

function selfmodBlocked(at: number): void {
  h.emit(
    {
      type: 'selfmod.blocked',
      actor: sys,
      scope: { sessionId: 'ses_x' },
      meta: { sessionId: 'ses_x', rule: 'governance_core', pathHash: 'f'.repeat(64) },
      payload: { path: 'packages/kernel/x.ts', toolName: 'Edit' },
      source: 'hook',
    },
    at,
  );
}

describe('integrity', () => {
  it('is neutral before any audit event', async () => {
    h = await setup();
    const s = await h.snap();
    expect(s.integrity).toEqual({
      chainOk: null,
      lastVerifiedAt: null,
      lastAnchorAt: null,
      anchorAgeMs: null,
      unanchoredEvents: h.t.rt.store.head().seq,
      breakglassOpen: 0,
      postIncidentOverdue: 0,
      provenanceRefusals7d: 0,
      selfModBlocks7d: 0,
      mappingStatus: 'unknown',
      degradedProjections: 0,
      reactorFailures24h: 0,
    });
    expect(s.attention).toEqual([]);
    expect(s.kpis).toMatchObject({ chainOk: null, anchorAgeMs: null });
  });

  it('chain verification: latest result wins; a broken chain is a critical item from the first failing run', async () => {
    h = await setup();
    verified(h, true, ago(h, hours(3)));
    expect((await h.snap()).integrity).toMatchObject({
      chainOk: true,
      lastVerifiedAt: iso(ago(h, hours(3))),
    });
    verified(h, false, ago(h, hours(2)));
    verified(h, false, ago(h, hours(1)));
    let s = await h.snap();
    expect(s.integrity).toMatchObject({ chainOk: false, lastVerifiedAt: iso(ago(h, hours(1))) });
    expect(s.kpis.chainOk).toBe(false);
    expect(s.attention).toEqual([
      expect.objectContaining({
        id: 'chain_broken',
        kind: 'chain_broken',
        severity: 'critical',
        since: iso(ago(h, hours(2))),
        costOfDelay: { score: 98.5, basis: 'Chain broken · 2h · first bad seq 42' }, // raw 332.2
        action: { kind: 'open', label: 'Open audit', href: '/audit', recommendedOptionId: null },
      }),
    ]);
    expect(s.summary).toContain('Audit chain verification failed.');
    verified(h, true, ago(h, minutes(10)));
    s = await h.snap();
    expect(s.integrity.chainOk).toBe(true);
    expect(s.attention).toEqual([]);
  });

  it('anchors: age, unanchored events, and anchor_missed after 26h (or never anchored)', async () => {
    h = await setup();
    anchored(h, ago(h, hours(2)));
    let s = await h.snap();
    expect(s.integrity).toMatchObject({
      lastAnchorAt: iso(ago(h, hours(2))),
      anchorAgeMs: hours(2),
      unanchoredEvents: 1,
    });
    expect(s.kpis.anchorAgeMs).toBe(hours(2));
    expect(s.attention).toEqual([]);
    await h.close();

    h = await setup();
    anchored(h, ago(h, hours(27))); // anchors seq 1
    selfmodBlocked(ago(h, hours(5)));
    h.emit(
      {
        type: 'anchor.failed',
        actor: sys,
        meta: { provider: 'rfc3161', reason: 'tsa_timeout' },
        payload: {},
        source: 'scheduler',
      },
      ago(h, hours(2)),
    );
    s = await h.snap();
    expect(s.integrity.unanchoredEvents).toBe(h.t.rt.store.head().seq - 1);
    expect(s.attention).toEqual([
      expect.objectContaining({
        id: 'anchor_missed',
        since: iso(ago(h, hours(1))), // 26h after the last anchor
        detail: 'Last attempt failed: tsa_timeout',
        costOfDelay: {
          score: 93.5,
          basis: `Anchor missed · last anchor 27h ago · ${h.t.rt.store.head().seq - 1} events unanchored`,
        },
        chips: ['Integrity', 'Anchor failing'],
      }),
    ]);
    await h.close();

    // Never anchored: the clock runs from the first event in the log.
    h = await setup({ now: '2026-10-07T00:00:00.000Z' });
    h.t.clock.set(NOW);
    s = await h.snap();
    expect(s.attention).toEqual([
      expect.objectContaining({
        id: 'anchor_missed',
        since: '2026-10-08T02:00:00.000Z',
        costOfDelay: { score: 99.9, basis: 'Anchor missed · never anchored · 1 event unanchored' },
      }),
    ]);
  });

  it('compliance mapping: provisional until the published version and hash are stamped', async () => {
    h = await setup();
    const hash = (c: string) => c.repeat(64);
    h.emit({
      type: 'mapping.published',
      actor: sys,
      meta: { version: 'v1', hash: hash('a'), rows: 40, source: 'builtin' },
      source: 'system',
    });
    expect((await h.snap()).integrity.mappingStatus).toBe('provisional');
    h.emit({
      type: 'mapping.stamped',
      actor: { kind: 'human', id: 'usr_lead' },
      meta: { version: 'v1', hash: hash('a'), stampedBy: 'usr_lead' },
      payload: {},
      source: 'api',
    });
    expect((await h.snap()).integrity.mappingStatus).toBe('stamped');
    h.emit({
      type: 'mapping.published',
      actor: sys,
      meta: { version: 'v2', hash: hash('b'), rows: 41, source: 'config' },
      source: 'system',
    });
    h.emit({
      type: 'mapping.stamped',
      actor: { kind: 'human', id: 'usr_lead' },
      meta: { version: 'v2', hash: hash('c'), stampedBy: 'usr_lead' },
      payload: {},
      source: 'api',
    });
    expect((await h.snap()).integrity.mappingStatus).toBe('provisional');
  });

  it('self-modification blocks and provenance refusals over 7 days; a refusal stays an item until a newer promotion supersedes it', async () => {
    h = await setup();
    selfmodBlocked(ago(h, DAY));
    selfmodBlocked(ago(h, 2 * DAY));
    selfmodBlocked(ago(h, 8 * DAY));
    const promotion = (id: string, ms: number) =>
      h.emit(
        {
          type: 'promotion.requested',
          actor: sys,
          scope: { projectId: 'prj_a' },
          meta: {
            promotionId: id,
            projectId: 'prj_a',
            fromRef: 'fix/1',
            fromSha: 'abcdef1',
            targetBranch: 'main',
            ticketId: null,
            changeId: null,
          },
          source: 'api',
        },
        ms,
      );
    promotion('prm_old', ago(h, 9 * DAY));
    h.emit(
      {
        type: 'promotion.refused',
        actor: sys,
        meta: { promotionId: 'prm_old', reason: 'tests_failed', orphanShas: [] },
        source: 'system',
      },
      ago(h, 9 * DAY),
    );
    promotion('prm_1', ago(h, hours(3)));
    h.emit(
      {
        type: 'promotion.refused',
        actor: sys,
        meta: { promotionId: 'prm_1', reason: 'provenance_gap', orphanShas: ['abcdef2', 'abcdef3'] },
        source: 'system',
      },
      ago(h, hours(3)),
    );

    let s = await h.snap();
    expect(s.integrity).toMatchObject({ selfModBlocks7d: 2, provenanceRefusals7d: 1 });
    expect(s.attention).toEqual([
      expect.objectContaining({
        id: 'provenance_refused:prm_1',
        title: 'Promotion refused: provenance gap',
        projectId: 'prj_a',
        costOfDelay: { score: 93.7, basis: 'Promotion refused · 3h · provenance gap · 2 orphan commits' }, // raw 55 × 3.81
        action: {
          kind: 'open',
          label: 'Open promotion',
          href: '/changes?promotionId=prm_1',
          recommendedOptionId: null,
        },
      }),
    ]);
    promotion('prm_2', ago(h, hours(1)));
    s = await h.snap();
    expect(s.attention).toEqual([]);
    expect(s.integrity.provenanceRefusals7d).toBe(1);
  });

  it('break-glass: open until its post-incident change completes; overdue records are items; unknown decisions still surface', async () => {
    h = await setup();
    h.emit(
      {
        type: 'breakglass.invoked',
        actor: { kind: 'human', id: 'usr_dev' },
        scope: { projectId: 'prj_a' },
        meta: {
          breakglassId: 'brk_1',
          projectId: 'prj_a',
          invokedBy: 'usr_dev',
          ref: 'hotfix/1',
          sha: 'abcdef1',
          decisionId: 'dec_bg',
        },
        payload: { justification: 'prod down' },
        source: 'api',
      },
      ago(h, minutes(30)),
    );
    decide(h, 'dec_bg', 'break_glass', { at: ago(h, minutes(30)) });
    let s = await h.snap();
    expect(s.integrity).toMatchObject({ breakglassOpen: 1, postIncidentOverdue: 0 });
    expect(s.attention.map((a) => [a.id, a.kind, a.action.requiresPasskey])).toEqual([
      ['decision:dec_bg', 'decision', true],
    ]);

    resolveDecision(h, 'dec_bg', 'break_glass', ago(h, minutes(20)), 'passkey');
    h.emit(
      {
        type: 'breakglass.approved',
        actor: { kind: 'human', id: 'usr_ceo' },
        meta: {
          breakglassId: 'brk_1',
          decisionId: 'dec_bg',
          approverId: 'usr_ceo',
          passkeyVerified: true,
          postIncidentChangeId: 'chg_pi',
          dueAt: iso(ago(h, minutes(20)) + DAY),
        },
        source: 'api',
      },
      ago(h, minutes(20)),
    );
    s = await h.snap();
    expect(s.integrity).toMatchObject({ breakglassOpen: 1, postIncidentOverdue: 0 });
    expect(s.attention).toEqual([]);

    h.t.clock.advance(DAY + hours(2));
    h.emit(
      {
        type: 'breakglass.post_incident_overdue',
        actor: sys,
        meta: { breakglassId: 'brk_1', changeId: 'chg_pi', dueAt: iso(ago(h, hours(2) + minutes(20))) },
        source: 'scheduler',
      },
      ago(h, hours(2)),
    );
    s = await h.snap();
    expect(s.integrity).toMatchObject({ breakglassOpen: 1, postIncidentOverdue: 1 });
    expect(s.attention).toEqual([
      expect.objectContaining({
        id: 'post_incident_overdue:brk_1',
        projectId: 'prj_a',
        since: iso(ago(h, hours(2) + minutes(20))),
        costOfDelay: {
          score: 97.7,
          basis: 'Post-incident record · 2h 20m overdue · open audit finding until filed',
        }, // raw 85 × 3.50
        action: { kind: 'open', label: 'Open record', href: '/changes?id=chg_pi', recommendedOptionId: null },
      }),
    ]);
    changeCompleted(h, 'chg_pi');
    s = await h.snap();
    expect(s.integrity).toMatchObject({ breakglassOpen: 0, postIncidentOverdue: 0 });
    expect(s.attention).toEqual([]);

    // Invoked, but its decision never reached the tower: still the most urgent thing on the page.
    h.emit(
      {
        type: 'breakglass.invoked',
        actor: { kind: 'human', id: 'usr_dev' },
        scope: { projectId: 'prj_b' },
        meta: {
          breakglassId: 'brk_2',
          projectId: 'prj_b',
          invokedBy: 'usr_dev',
          ref: 'hotfix/2',
          sha: 'abcdef4',
          decisionId: 'dec_lost',
        },
        payload: { justification: 'down' },
        source: 'api',
      },
      ago(h, minutes(5)),
    );
    // Withdrawn emergencies are closed.
    h.emit(
      {
        type: 'breakglass.invoked',
        actor: { kind: 'human', id: 'usr_dev' },
        scope: { projectId: 'prj_b' },
        meta: {
          breakglassId: 'brk_3',
          projectId: 'prj_b',
          invokedBy: 'usr_dev',
          ref: 'hotfix/3',
          sha: 'abcdef5',
          decisionId: 'dec_w',
        },
        payload: { justification: 'down' },
        source: 'api',
      },
      ago(h, minutes(5)),
    );
    decide(h, 'dec_w', 'break_glass', { at: ago(h, minutes(5)) });
    h.emit({
      type: 'decision.withdrawn',
      actor: sys,
      scope: { decisionId: 'dec_w' },
      meta: { decisionId: 'dec_w', reason: 'resolved_elsewhere' },
      payload: {},
      source: 'api',
    });
    // So are rejected ones (even when the tower never saw their decision).
    h.emit(
      {
        type: 'breakglass.invoked',
        actor: { kind: 'human', id: 'usr_dev' },
        scope: { projectId: 'prj_b' },
        meta: {
          breakglassId: 'brk_4',
          projectId: 'prj_b',
          invokedBy: 'usr_dev',
          ref: 'hotfix/4',
          sha: 'abcdef6',
          decisionId: 'dec_r',
        },
        payload: { justification: 'down' },
        source: 'api',
      },
      ago(h, minutes(5)),
    );
    h.emit({
      type: 'breakglass.rejected',
      actor: { kind: 'human', id: 'usr_ceo' },
      meta: { breakglassId: 'brk_4', decisionId: 'dec_r', approverId: 'usr_ceo' },
      payload: {},
      source: 'api',
    });
    s = await h.snap();
    expect(s.integrity.breakglassOpen).toBe(1);
    expect(s.attention).toEqual([
      expect.objectContaining({
        id: 'breakglass_open:brk_2',
        kind: 'breakglass_open',
        costOfDelay: { score: 82.8, basis: 'Break-glass promotion · 5m · production down' },
        // Its options never reached the tower, so there is no recommendation to apply inline: review it.
        action: {
          kind: 'resolve_decision',
          label: 'Review',
          href: '/decisions?id=dec_lost',
          decisionId: 'dec_lost',
          requiresPasskey: true,
          recommendedOptionId: null,
        },
      }),
    ]);
  });

  it('platform health: degraded projections are items; reactor failures counted over 24h', async () => {
    const broken: AocModule = {
      name: 'broken',
      projectors: [
        {
          name: 'broken',
          tables: [],
          ddl: [],
          handles: ['selfmod.blocked'],
          apply() {
            throw new Error('boom');
          },
        },
      ],
      reactors: [
        {
          name: 'broken.reactor',
          handles: ['selfmod.blocked'],
          react() {
            throw new Error('nope');
          },
        },
      ],
    };
    h = await setup({ modules: [broken] });
    selfmodBlocked(ago(h, minutes(10)));
    await h.t.drain();
    const seq = h.t.rt.store.head().seq;
    let s = await h.snap();
    expect(s.integrity).toMatchObject({ degradedProjections: 1, reactorFailures24h: 1, selfModBlocks7d: 1 });
    expect(s.attention).toEqual([
      expect.objectContaining({
        id: 'projection_degraded:broken',
        title: 'Projection degraded: broken',
        since: iso(ago(h, minutes(10))),
        costOfDelay: { score: 70.8, basis: `Projection degraded · 10m · failed at seq ${seq}` },
      }),
    ]);
    h.t.clock.advance(25 * 3_600_000);
    s = await h.snap();
    expect(s.integrity.reactorFailures24h).toBe(0);
  });

  it('FX: an open discrepancy is one item (not also a decision item); carry-forward alerts clear on the next live rate', async () => {
    h = await setup();
    h.emit(
      {
        type: 'fx.discrepancy_raised',
        actor: sys,
        meta: { date: '2026-10-08', scraped: 4.1, official: 4.15, decisionId: 'dec_fx' },
        payload: {},
        source: 'scheduler',
      },
      ago(h, hours(2)),
    );
    decide(h, 'dec_fx', 'fx_discrepancy', { at: ago(h, hours(2)), projectId: null });
    h.emit(
      {
        type: 'fx.carry_forward_alert',
        actor: sys,
        meta: { consecutiveDays: 1, since: '2026-10-08' },
        source: 'scheduler',
      },
      ago(h, hours(1)),
    );
    let s = await h.snap();
    expect(s.attention.map((a) => [a.id, a.kind, a.costOfDelay.score, a.action.kind])).toEqual([
      ['fx_discrepancy:dec_fx', 'fx_discrepancy', 55.4, 'resolve_decision'],
      ['fx_carry_forward', 'fx_carry_forward', 32.3, 'open'],
    ]);
    h.emit({
      type: 'fx.discrepancy_resolved',
      actor: { kind: 'human', id: 'usr_ceo' },
      meta: { date: '2026-10-08', chosenRate: 4.15, decisionId: 'dec_fx' },
      source: 'api',
    });
    h.emit({
      type: 'fx.rate_recorded',
      actor: sys,
      meta: {
        date: '2026-10-09',
        pair: 'USD/MYR',
        rate: 4.2,
        status: 'live',
        sourceDate: '2026-10-09',
        extractor: 'haiku',
        validation: 'pass',
        reason: 'fetched',
      },
      payload: {},
      source: 'scheduler',
    });
    s = await h.snap();
    expect(s.attention).toEqual([]);
  });
});
