import type { Actor, Role, ServiceMap, User } from '@aoc/contracts';
import type { ServiceRegistry } from '@aoc/kernel';
import { IdentityServiceImpl } from './service';

const TEST_ACTOR: Actor = { kind: 'system', id: 'identity:test' };

export interface IdentityTestUser {
  user: User;
  token: string;
  tokenId: string;
  /** Bearer headers for app.request. */
  headers: Record<string, string>;
}

/** The registered IdentityService as the concrete implementation (throws if another one is registered). */
export function identityServiceOf(services: ServiceRegistry): IdentityServiceImpl {
  const s: ServiceMap['identity'] = services.get('identity');
  if (!(s instanceof IdentityServiceImpl)) throw new Error('identity service is not mod-identity');
  return s;
}

/**
 * Test helpers mirroring the kernel test kit's user()/ingestHeaders() for runtimes that load
 * mod-identity (the kit's DevIdentityService is then not used). Users and tokens go through the real
 * service, so events, hashing and projections are exercised.
 */
export function identityTestHelpers(service: IdentityServiceImpl) {
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  return {
    service,
    user(
      role: Role,
      name?: string,
      opts: { complianceLead?: boolean; email?: string } = {},
    ): IdentityTestUser {
      const { user, issued } = service.createUserWithToken(
        {
          role,
          name: name ?? `${role} user`,
          email: opts.email ?? null,
          complianceLead: opts.complianceLead ?? false,
        },
        { label: 'test' },
        TEST_ACTOR,
      );
      return { user, token: issued.token, tokenId: issued.tokenId, headers: bearer(issued.token) };
    },
    token(
      userId: string,
      opts: { label?: string; expiresInDays?: number } = {},
    ): { token: string; tokenId: string; headers: Record<string, string> } {
      const issued = service.issueUserToken(userId, opts, TEST_ACTOR);
      return { token: issued.token, tokenId: issued.tokenId, headers: bearer(issued.token) };
    },
    /** Cookie headers for a console session opened with a user token. */
    cookieHeaders(userToken: string): Record<string, string> {
      const r = service.openWebSession(userToken);
      if (!r.ok) throw new Error(`cannot open a session: ${r.reason}`);
      return { cookie: `aoc_session=${r.issued.token}` };
    },
    ingestHeaders(sessionId: string | 'observer' | 'system'): Record<string, string> {
      const token =
        sessionId === 'observer'
          ? service.issueObserverToken(TEST_ACTOR)
          : sessionId === 'system'
            ? service.issueSystemToken(TEST_ACTOR)
            : service.issueIngestToken(sessionId, TEST_ACTOR);
      return bearer(token);
    },
    sidecarHeaders(sessionId: string): Record<string, string> {
      return bearer(service.issueSidecarToken(sessionId, TEST_ACTOR));
    },
  };
}
export type IdentityTestHelpers = ReturnType<typeof identityTestHelpers>;
