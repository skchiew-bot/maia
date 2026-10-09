import { createHash, randomBytes } from 'node:crypto';
import {
  hasPermission,
  newId,
  type Actor,
  type AuthContext,
  type IdentityService,
  type IngestPrincipal,
  type Permission,
  type Role,
  type User,
} from '@aoc/contracts';
import type { EventStore } from '../store/event-store';

/**
 * In-memory IdentityService for tests and for modules developed before mod-identity lands.
 * Appends real user.created events so projections that join users behave as in production.
 */
export class DevIdentityService implements IdentityService {
  readonly users = new Map<string, User>();
  private readonly tokens = new Map<string, { userId: string; tokenId: string }>();
  private readonly ingest = new Map<string, IngestPrincipal>();
  passkeyResult = true;
  readonly passkeyCalls: { userId: string; decisionId: string; optionId: string }[] = [];

  constructor(private readonly store: EventStore | null = null) {}

  createUser(input: { role: Role; name?: string; complianceLead?: boolean; id?: string }): { user: User; token: string } {
    const user: User = {
      id: input.id ?? newId('user'),
      name: input.name ?? `${input.role} user`,
      email: null,
      role: input.role,
      flags: { complianceLead: input.complianceLead ?? false },
      active: true,
    };
    this.users.set(user.id, user);
    this.store?.append({
      type: 'user.created',
      actor: { kind: 'system', id: 'dev-identity' },
      scope: { userId: user.id },
      meta: { userId: user.id, role: user.role, complianceLead: user.flags.complianceLead ?? false },
      payload: { name: user.name },
      source: 'system',
    });
    const token = `aoc_u_${randomBytes(18).toString('hex')}`;
    this.tokens.set(token, { userId: user.id, tokenId: newId('token') });
    return { user, token };
  }

  authenticate(token: string): AuthContext | null {
    const t = this.tokens.get(token);
    const user = t ? this.users.get(t.userId) : undefined;
    if (!t || !user || !user.active) return null;
    return { user, tokenId: t.tokenId, method: 'bearer' };
  }
  getUser(id: string): User | null {
    return this.users.get(id) ?? null;
  }
  listUsers(): User[] {
    return [...this.users.values()];
  }
  can(user: User, perm: Permission): boolean {
    return hasPermission(user.role, perm, user.flags);
  }
  issueIngestToken(sessionId: string, _actor: Actor): string {
    const token = `aoc_i_${randomBytes(18).toString('hex')}`;
    this.ingest.set(token, { kind: 'session', sessionId, tokenId: newId('token') });
    return token;
  }
  issueObserverToken(): string {
    const token = `aoc_o_${randomBytes(18).toString('hex')}`;
    this.ingest.set(token, { kind: 'observer', tokenId: newId('token') });
    return token;
  }
  issueSystemToken(): string {
    const token = `aoc_s_${randomBytes(18).toString('hex')}`;
    this.ingest.set(token, { kind: 'system', tokenId: newId('token') });
    return token;
  }
  revokeIngestTokensFor(sessionId: string): void {
    for (const [k, v] of this.ingest) if (v.kind === 'session' && v.sessionId === sessionId) this.ingest.delete(k);
  }
  verifyIngestToken(token: string): IngestPrincipal | null {
    return this.ingest.get(token) ?? null;
  }
  async verifyDecisionPasskey(input: { userId: string; decisionId: string; optionId: string; assertion: unknown }): Promise<boolean> {
    this.passkeyCalls.push({ userId: input.userId, decisionId: input.decisionId, optionId: input.optionId });
    return this.passkeyResult && input.assertion != null;
  }
}

export const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');
