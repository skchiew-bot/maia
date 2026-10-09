import { describe, expect, it } from 'vitest';
import {
  gateCoverage,
  isLastApprover,
  lastSeen,
  lastSignIns,
  liveTokensOf,
  roleCounts,
  tokenHygiene,
  type UserFacts,
} from '../../src/pages/admin/model';
import { registrationError } from '../../src/pages/admin/Passkeys';
import { PASSKEYS, SESSIONS, USERS, USER_TOKENS, person, token } from './fixtures';

const facts = (withKeys: Record<string, number>): Map<string, UserFacts> =>
  new Map(
    USERS.map((u) => [
      u.id,
      { passkeys: (PASSKEYS.usr_priya ?? []).slice(0, withKeys[u.id] ?? 0), lastActionAt: null },
    ]),
  );

describe('gate coverage', () => {
  it('flags a sole Approver: their own requests can never be approved', () => {
    const gates = gateCoverage(USERS, facts({}));
    const approver = gates.find((g) => g.id === 'approver')!;
    expect(approver.holders.map((u) => u.id)).toEqual(['usr_ceo']);
    expect(approver.level).toBe('warn');
    expect(approver.note).toMatch(/own requests can never be approved/);
    expect(approver.seats).toBe(2);
  });

  it('says nobody can sign passkey gates until an active Approver registers a passkey', () => {
    expect(gateCoverage(USERS, facts({})).find((g) => g.id === 'passkey')).toMatchObject({ level: 'danger' });
    // a Builder's passkey does not cover Approver gates; an inactive Approver never counts
    expect(
      gateCoverage(USERS, facts({ usr_priya: 1, usr_old: 1 })).find((g) => g.id === 'passkey'),
    ).toMatchObject({
      level: 'danger',
      holders: [],
    });
    expect(gateCoverage(USERS, facts({ usr_ceo: 1 })).find((g) => g.id === 'passkey')).toMatchObject({
      level: 'warn',
    });
  });

  it('counts operators for builder decisions and compliance leads for the stamp', () => {
    const gates = gateCoverage(USERS, facts({}));
    expect(gates.find((g) => g.id === 'builder')!.holders).toHaveLength(3);
    expect(gates.find((g) => g.id === 'compliance')).toMatchObject({ level: 'ok', seats: 1 });
    const noLead = gateCoverage([person({ id: 'a', name: 'A', role: 'approver' })], facts({}));
    expect(noLead.find((g) => g.id === 'compliance')!.level).toBe('warn');
  });

  it('does not judge passkey cover before passkeys have loaded', () => {
    expect(gateCoverage(USERS, undefined).find((g) => g.id === 'passkey')).toMatchObject({
      level: 'unknown',
      note: '',
    });
  });
});

describe('people', () => {
  it('protects the last active Approver from demotion and deactivation', () => {
    expect(isLastApprover(USERS[0]!, USERS)).toBe(true);
    const two = [...USERS, person({ id: 'usr_dep', name: 'Deputy', role: 'approver' })];
    expect(isLastApprover(USERS[0]!, two)).toBe(false);
    expect(isLastApprover(USERS[1]!, USERS)).toBe(false);
  });

  it('counts active people by role', () => {
    expect(roleCounts(USERS)).toEqual({ approver: 1, builder: 2, requester: 1 });
  });

  it('takes the later of last audited action and last console sign-in', () => {
    expect(lastSignIns(SESSIONS).get('usr_priya')).toBe('2026-10-09T05:00:00.000Z');
    expect(lastSeen('2026-10-09T03:00:00.000Z', '2026-10-09T05:00:00.000Z')).toBe('2026-10-09T05:00:00.000Z');
    expect(lastSeen('2026-10-09T06:00:00.000Z', '2026-10-09T05:00:00.000Z')).toBe('2026-10-09T06:00:00.000Z');
    expect(lastSeen(null, undefined)).toBeNull();
  });
});

describe('token hygiene', () => {
  it('counts live tokens, those without expiry and any still held by inactive people', () => {
    const tokens = [
      ...USER_TOKENS,
      token({ tokenId: 'tok_old', prefix: 'aoc_u_Leftover', userId: 'usr_old' }),
    ];
    expect(tokenHygiene(tokens, USERS)).toEqual({ live: 4, withoutExpiry: 3, orphaned: 1 });
    expect(liveTokensOf(USER_TOKENS, 'usr_aisyah').map((t) => t.tokenId)).toEqual(['tok_aisyah']);
  });
});

describe('passkey registration errors', () => {
  it('turns a dismissed prompt into words', () => {
    expect(registrationError(new DOMException('cancelled', 'NotAllowedError'))).toBe(
      'The passkey prompt was dismissed or timed out.',
    );
  });
});
