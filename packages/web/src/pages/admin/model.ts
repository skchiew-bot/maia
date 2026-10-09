/**
 * Pure rules for the Admin › Users page (§6): who holds which gate, where cover is missing, and token and
 * passkey hygiene. This is access governance, so people are named — but nothing here ranks them.
 */
import type { IdentityTokenDto, IdentityUserDto, PasskeyDto, Role } from '@aoc/contracts';
import type { Tone } from '../../components';

export const ROLE_META: Record<Role, { label: string; tone: Tone; hint: string }> = {
  approver: {
    label: 'Approver',
    tone: 'accent',
    hint: 'Holds the gates: fix plans, go-live, rollback, top-ups',
  },
  builder: {
    label: 'Builder',
    tone: 'neutral',
    hint: 'Operator surface; self-approves reversible off-main work',
  },
  requester: { label: 'Requester', tone: 'neutral', hint: 'Intake portal only: files tickets, tests on UAT' },
};

export const ROLES_IN_ORDER: readonly Role[] = ['approver', 'builder', 'requester'];

export interface UserFacts {
  passkeys: readonly PasskeyDto[];
  /** Newest audited event this person was the actor of. */
  lastActionAt: string | null;
}

/** `unknown` while the facts a level depends on are still loading. */
export type CoverageLevel = 'ok' | 'warn' | 'danger' | 'unknown';

export interface GateCoverage {
  id: 'passkey' | 'approver' | 'builder' | 'compliance';
  label: string;
  /** What the gate covers. */
  scope: string;
  holders: IdentityUserDto[];
  /** Holders needed for cover: two for gates (nobody approves their own request), one for the stamp. */
  seats: number;
  level: CoverageLevel;
  /** Why the level is not ok, in words. */
  note: string;
}

const active = (users: readonly IdentityUserDto[]) => users.filter((u) => u.active);

export function hasUsablePasskey(facts: ReadonlyMap<string, UserFacts> | undefined, userId: string): boolean {
  return (facts?.get(userId)?.passkeys.length ?? 0) > 0;
}

/**
 * Who can clear each kind of gate right now. One holder is a single point of failure; for Approver gates it
 * is worse — with the sole-Approver fallback off, that person's own requests can never be approved.
 */
export function gateCoverage(
  users: readonly IdentityUserDto[],
  facts: ReadonlyMap<string, UserFacts> | undefined,
): GateCoverage[] {
  const live = active(users);
  const approvers = live.filter((u) => u.role === 'approver');
  const withPasskey = approvers.filter((u) => hasUsablePasskey(facts, u.id));
  const operators = live.filter((u) => u.role === 'approver' || u.role === 'builder');
  const leads = live.filter((u) => u.flags.complianceLead && u.role !== 'requester');
  const level = (n: number, minOk = 2): CoverageLevel => (n === 0 ? 'danger' : n < minOk ? 'warn' : 'ok');
  return [
    {
      id: 'passkey',
      seats: 2,
      label: 'Passkey gates',
      scope: 'Go-live, rollback, break-glass',
      holders: withPasskey,
      level: facts ? level(withPasskey.length) : 'unknown',
      // Passkeys load per person after the user list: say nothing until they have.
      note: !facts
        ? ''
        : withPasskey.length === 0
          ? 'Nobody can approve them: an Approver must register a passkey.'
          : withPasskey.length === 1
            ? 'One person: no cover when they are away.'
            : '',
    },
    {
      id: 'approver',
      seats: 2,
      label: 'Approver gates',
      scope: 'Fix plans, change requests, top-ups, lesson binding',
      holders: approvers,
      level: level(approvers.length),
      note:
        approvers.length === 0
          ? 'Nobody can approve gated work.'
          : approvers.length === 1
            ? 'Their own requests can never be approved: add a deputy.'
            : '',
    },
    {
      id: 'builder',
      seats: 2,
      label: 'Builder decisions',
      scope: 'Reversible off-main work, triage reconciliation',
      holders: operators,
      level: level(operators.length),
      note: operators.length < 2 ? 'Requests cannot route away from their requester.' : '',
    },
    {
      id: 'compliance',
      seats: 1,
      label: 'Compliance stamp',
      scope: 'ISO/IEC 42001 mapping review',
      holders: leads,
      level: leads.length === 0 ? 'warn' : 'ok',
      note: leads.length === 0 ? 'The mapping stays provisional until a compliance lead stamps it.' : '',
    },
  ];
}

export function activeApprovers(users: readonly IdentityUserDto[]): IdentityUserDto[] {
  return active(users).filter((u) => u.role === 'approver');
}

/** The last active Approver can be neither demoted nor deactivated (mirrors mod-identity). */
export function isLastApprover(user: IdentityUserDto, users: readonly IdentityUserDto[]): boolean {
  return user.active && user.role === 'approver' && activeApprovers(users).length <= 1;
}

export function roleCounts(users: readonly IdentityUserDto[]): Record<Role, number> {
  const out: Record<Role, number> = { approver: 0, builder: 0, requester: 0 };
  for (const u of active(users)) out[u.role] += 1;
  return out;
}

/** Newest console sign-in per user (each sign-in opens a web-session token). */
export function lastSignIns(sessions: readonly IdentityTokenDto[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of sessions) {
    if (t.kind !== 'web_session' || !t.userId) continue;
    const prev = out.get(t.userId);
    if (!prev || t.createdAt > prev) out.set(t.userId, t.createdAt);
  }
  return out;
}

/** The later of a person's last audited action and last console sign-in. */
export function lastSeen(
  lastActionAt: string | null | undefined,
  lastSignInAt: string | null | undefined,
): string | null {
  if (!lastActionAt) return lastSignInAt ?? null;
  if (!lastSignInAt) return lastActionAt;
  return Date.parse(lastActionAt) >= Date.parse(lastSignInAt) ? lastActionAt : lastSignInAt;
}

export interface TokenHygiene {
  live: number;
  withoutExpiry: number;
  /** Live tokens of deactivated people (deactivation should have revoked them). */
  orphaned: number;
}

export function tokenHygiene(
  tokens: readonly IdentityTokenDto[],
  users: readonly IdentityUserDto[],
): TokenHygiene {
  const inactive = new Set(users.filter((u) => !u.active).map((u) => u.id));
  const live = tokens.filter((t) => t.status === 'active');
  return {
    live: live.length,
    withoutExpiry: live.filter((t) => t.expiresAt === null).length,
    orphaned: live.filter((t) => t.userId !== null && inactive.has(t.userId)).length,
  };
}

/** Actor id that issues the first Approver's token when AOC is set up (mod-identity bootstrap). */
export const BOOTSTRAP_ACTOR = 'identity:bootstrap';

/** Live bootstrap tokens: setup credentials that should be replaced by a personal token, then revoked. */
export function liveBootstrapTokens(tokens: readonly IdentityTokenDto[]): IdentityTokenDto[] {
  return tokens.filter((t) => t.status === 'active' && t.createdBy === BOOTSTRAP_ACTOR);
}

export function liveTokensOf(tokens: readonly IdentityTokenDto[], userId: string): IdentityTokenDto[] {
  return tokens.filter((t) => t.userId === userId && t.status === 'active');
}

export const EXPIRY_CHOICES: readonly { value: string; label: string; days: number | null }[] = [
  { value: '30', label: '30 days', days: 30 },
  { value: '90', label: '90 days', days: 90 },
  { value: '365', label: '1 year', days: 365 },
  { value: 'never', label: 'No expiry', days: null },
];

export const REVOKE_REASON: Record<string, string> = {
  logout: 'signed out',
  revoked_by_owner: 'revoked by its owner',
  revoked_by_admin: 'revoked by an Approver',
  user_deactivated: 'person deactivated',
  parent_revoked: 'parent token revoked',
  session_ended: 'session ended',
};

/** True for stream events that change this page. */
export function isIdentityEvent(type: string): boolean {
  return type.startsWith('user.') || type.startsWith('token.') || type.startsWith('passkey.');
}
