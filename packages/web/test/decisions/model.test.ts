import { describe, expect, it } from 'vitest';
import { RESOLUTION_ASSURANCES, RESOLUTION_ASSURANCE_LABEL } from '@aoc/contracts';
import {
  agingOf,
  agingPhrase,
  assuranceLabel,
  assuranceOf,
  closedWithinSla,
  expectedAssurance,
  explainBlock,
  latencyByKind,
  outcomeLabel,
  requesterOf,
  sortByUrgency,
  subjectLinkOf,
} from '../../src/pages/decisions/model';
import { applyFilters, filtersToParams, parseFilters } from '../../src/pages/decisions/filters';
import { AISYAH, CEO, HOUR, MIN, NOW, card, closedHistory, openQueue, resolved } from './fixtures';

const people = (names: Record<string, string>, activeApprovers: number | null = null) => ({
  nameOf: (id: string) => names[id] ?? null,
  activeApprovers,
});

describe('decision aging against the CEO-approved SLAs', () => {
  it('reads within, due soon and over for an agent decision (1h SLA)', () => {
    const at = (ageMin: number) =>
      agingOf(card({ id: 'd', createdAt: new Date(NOW - ageMin * MIN).toISOString() }), NOW);
    expect(at(20).state).toBe('within');
    expect(agingPhrase(at(20))).toBe('Due in 40m');
    expect(at(50).state).toBe('due_soon');
    expect(at(74).state).toBe('over');
    expect(agingPhrase(at(74))).toBe('Over SLA by 14m');
  });

  it('ages a protected operation on the agent decision SLA, as those cards did before they had a kind of their own', () => {
    const at = (ageMin: number) =>
      agingOf(card({ id: 'd', kind: 'protected_operation', createdAt: new Date(NOW - ageMin * MIN).toISOString() }), NOW);
    expect(at(20).state).toBe('within');
    expect(at(74).state).toBe('over');
    expect(agingPhrase(at(74))).toBe('Over SLA by 14m');
    expect(closedWithinSla(card({ id: 'c', kind: 'protected_operation', ageMs: 30 * MIN }))).toBe(true);
  });

  it('uses an explicit due time over the kind SLA', () => {
    const a = agingOf(
      card({
        id: 'd',
        createdAt: new Date(NOW - 10 * MIN).toISOString(),
        dueAt: new Date(NOW - MIN).toISOString(),
      }),
      NOW,
    );
    expect(a.state).toBe('over');
    expect(a.allowedMs).toBe(9 * MIN);
  });

  it('never invents an SLA for kinds without an agreed one', () => {
    const a = agingOf(card({ id: 'd', kind: 'break_glass' }), NOW);
    expect(a.state).toBe('no_sla');
    expect(agingPhrase(a)).toBe('No SLA set');
  });

  it('orders the queue most overdue first, then soonest due, then SLA-less by age', () => {
    const order = sortByUrgency(openQueue(), NOW).map((c) => c.id);
    // top-up is 2h over its 1h SLA; the agent decision is due in 10m; break-glass cards have no SLA.
    expect(order).toEqual(['dec_topup', 'dec_agent', 'dec_bg', 'dec_own']);
  });

  it('judges closed cards by the time they waited', () => {
    const [fast, slow] = closedHistory();
    expect(closedWithinSla(fast!)).toBe(true);
    expect(closedWithinSla(slow!)).toBe(false);
  });
});

describe('who may resolve, in words', () => {
  const own = openQueue().find((c) => c.id === 'dec_own')!;

  it('tells the only Approver that a second Approver is needed for their own request', () => {
    const why = explainBlock(own, 'separation_of_duties', CEO, people({}, 1))!;
    expect(why.title).toBe('You raised this request');
    expect(why.body).toMatch(/only Approver, so a second Approver is needed/);
  });

  it('says another Approver must resolve it when there are several', () => {
    const why = explainBlock(own, 'separation_of_duties', CEO, people({}, 2))!;
    expect(why.body).toMatch(/Another Approver must resolve it/);
  });

  it('explains role routing for a Builder looking at an Approver gate', () => {
    const why = explainBlock(card({ id: 'd' }), 'role', AISYAH, people({}))!;
    expect(why.title).toBe('Needs the Approver role');
    expect(why.body).toMatch(/signed in as Builder/);
  });

  it('names the eligible people for routed cards', () => {
    const why = explainBlock(
      card({ id: 'd', eligibleUserIds: ['usr_dan'] }),
      'not_eligible',
      AISYAH,
      people({ usr_dan: 'Daniel Lim' }),
    )!;
    expect(why.body).toBe('It is routed to Daniel Lim.');
  });

  it('describes requesters: people, agent sessions and platform components', () => {
    const p = people({ usr_weijie: 'Tan Wei Jie' });
    expect(requesterOf('usr_weijie', p)).toMatchObject({ kind: 'person', name: 'Tan Wei Jie' });
    expect(requesterOf('session:ses_01M4F96VD3NYBS33ZTK8K67GHD', p)).toMatchObject({
      kind: 'agent',
      sessionId: 'ses_01M4F96VD3NYBS33ZTK8K67GHD',
    });
    expect(requesterOf('system:intake', p)).toMatchObject({ kind: 'system', name: 'Intake (AOC system)' });
  });
});

describe('labels and links', () => {
  it('labels button resolutions as attribution and passkey resolutions as signed (§6)', () => {
    const [byButton, , byPasskey] = closedHistory();
    expect(assuranceLabel(byButton!.resolution!)).toBe('Attribution (bearer token)');
    expect(assuranceLabel(byPasskey!.resolution!)).toBe('Signed (passkey)');
    expect(outcomeLabel(byPasskey!)).toBe('Approve');
  });

  // The words are the contracts' (RESOLUTION_ASSURANCE_LABEL), never a page-local copy that could drift.
  it('uses the contracts assurance labels for every assurance, derived the same way for cards without one', () => {
    for (const a of RESOLUTION_ASSURANCES)
      expect(assuranceLabel({ method: 'button', passkeyVerified: false, assurance: a })).toBe(
        RESOLUTION_ASSURANCE_LABEL[a],
      );
    // Older cards and `decision.resolved` metadata carry the method only.
    expect(assuranceOf({ method: 'passkey', passkeyVerified: true })).toBe('signature');
    expect(assuranceOf({ method: 'policy', passkeyVerified: false })).toBe('policy');
    expect(assuranceLabel({ method: 'policy', passkeyVerified: false })).toBe('Platform policy');
    // A passkey the server did not verify is attribution, not a signature.
    expect(assuranceOf({ method: 'passkey', passkeyVerified: false })).toBe('attribution');
    // What an open card will be recorded as: go-live, rollback and break-glass are signed.
    expect(expectedAssurance(card({ id: 'x', requiresPasskey: true }))).toBe('signature');
    expect(expectedAssurance(card({ id: 'x' }))).toBe('attribution');
  });

  it('links each subject to the page that shows it', () => {
    expect(subjectLinkOf({ subjectType: 'ticket', subjectId: 'tkt_1' }).to).toBe('/tickets/tkt_1');
    expect(subjectLinkOf({ subjectType: 'session', subjectId: 'ses_1' }).to).toBe('/sessions/ses_1');
    expect(subjectLinkOf({ subjectType: 'credit_request', subjectId: 'tpu_1' }).to).toBe('/credits');
    expect(subjectLinkOf({ subjectType: 'lesson', subjectId: 'les_1' }).to).toBe('/learning');
  });
});

describe('time to decide per kind', () => {
  it('computes p50, p90 and SLA breaches from resolved cards only', () => {
    const base = card({ id: 'x' });
    const rows = latencyByKind([
      resolved(base, CEO.id, 'button', 'uat', 10 * MIN),
      resolved(base, CEO.id, 'button', 'uat', 30 * MIN),
      resolved(base, CEO.id, 'button', 'uat', 2 * HOUR),
      { ...base, status: 'withdrawn', ageMs: 5 * HOUR },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'agent_decision',
      total: 3,
      p50Ms: 30 * MIN,
      p90Ms: 2 * HOUR,
      breaches: 1,
    });
  });
});

describe('URL filters', () => {
  it('round-trips tab, kinds, aging, passkey, scope and focus', () => {
    const f = parseFilters(
      new URLSearchParams(
        'tab=resolved&kind=go_live,rollback,bogus&aging=over&passkey=1&scope=mine&focus=dec_1',
      ),
    );
    expect(f.tab).toBe('resolved');
    expect([...f.kinds]).toEqual(['go_live', 'rollback']);
    expect(filtersToParams(f).toString()).toBe(
      'tab=resolved&kind=go_live%2Crollback&aging=over&passkey=1&scope=mine&focus=dec_1',
    );
  });

  it('narrows the queue', () => {
    const q = openQueue();
    const only = (s: string) => applyFilters(q, parseFilters(new URLSearchParams(s)), NOW).map((c) => c.id);
    expect(only('passkey=1')).toEqual(['dec_bg', 'dec_own']);
    expect(only('scope=mine')).not.toContain('dec_own');
    expect(only('aging=over')).toEqual(['dec_topup']);
    expect(only('kind=credit_topup')).toEqual(['dec_topup']);
  });
});
