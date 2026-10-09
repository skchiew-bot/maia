import type { IdentityTokenDto, IdentityUserDto, PasskeyDto } from '@aoc/contracts';

/** Fixtures mirror /api/users, /api/tokens and /api/passkeys for the seeded demo (ids shortened). */

export function person(
  u: Partial<IdentityUserDto> & Pick<IdentityUserDto, 'id' | 'name' | 'role'>,
): IdentityUserDto {
  return {
    email: null,
    flags: { complianceLead: false },
    active: true,
    createdAt: '2026-09-25T03:36:40.186Z',
    updatedAt: '2026-09-25T03:36:40.186Z',
    ...u,
  };
}

export const USERS: IdentityUserDto[] = [
  person({ id: 'usr_ceo', name: 'Chiew Sin Kwang', role: 'approver' }),
  person({ id: 'usr_aisyah', name: 'Aisyah Rahman', role: 'builder' }),
  person({ id: 'usr_priya', name: 'Priya Nair', role: 'builder', flags: { complianceLead: true } }),
  person({ id: 'usr_nur', name: 'Nur Hidayah', role: 'requester' }),
  person({ id: 'usr_old', name: 'Former Approver', role: 'approver', active: false }),
];

export function token(
  t: Partial<IdentityTokenDto> & Pick<IdentityTokenDto, 'tokenId' | 'prefix'>,
): IdentityTokenDto {
  return {
    kind: 'user',
    userId: null,
    sessionId: null,
    parentTokenId: null,
    label: 'demo',
    createdAt: '2026-09-25T03:36:40.186Z',
    createdBy: 'usr_ceo',
    expiresAt: null,
    revokedAt: null,
    revokeReason: null,
    status: 'active',
    ...t,
  };
}

export const USER_TOKENS: IdentityTokenDto[] = [
  token({ tokenId: 'tok_ceo', prefix: 'aoc_u_S80g9N4T', userId: 'usr_ceo' }),
  token({
    tokenId: 'tok_aisyah',
    prefix: 'aoc_u_Yx6q5Mb5',
    userId: 'usr_aisyah',
    expiresAt: '2026-11-08T00:00:00.000Z',
  }),
  token({
    tokenId: 'tok_aisyah_old',
    prefix: 'aoc_u_OldOld12',
    userId: 'usr_aisyah',
    status: 'revoked',
    revokedAt: '2026-10-01T00:00:00.000Z',
    revokeReason: 'revoked_by_admin',
  }),
  token({ tokenId: 'tok_priya', prefix: 'aoc_u_unPeQyA8', userId: 'usr_priya' }),
];

export const SESSIONS: IdentityTokenDto[] = [
  token({
    tokenId: 'tok_web_priya',
    prefix: 'aoc_w_aaaaaaaa',
    kind: 'web_session',
    userId: 'usr_priya',
    parentTokenId: 'tok_priya',
    label: null,
    createdAt: '2026-10-09T05:00:00.000Z',
    expiresAt: '2026-10-09T17:00:00.000Z',
  }),
];

export const PASSKEYS: Record<string, PasskeyDto[]> = {
  usr_priya: [
    {
      id: 'a'.repeat(64),
      userId: 'usr_priya',
      label: 'MacBook Touch ID',
      counter: 0,
      transports: ['internal'],
      deviceType: 'multiDevice',
      backedUp: true,
      createdAt: '2026-10-02T00:00:00.000Z',
      lastUsedAt: null,
    },
  ],
};

/** Newest audited action per user. */
export const LAST_ACTION: Record<string, string> = {
  usr_ceo: '2026-10-09T04:22:36.000Z',
  usr_priya: '2026-10-09T03:00:00.000Z',
};
