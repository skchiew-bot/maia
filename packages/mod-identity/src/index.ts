import type { AocModule, Ctx, ModuleContext } from '@aoc/kernel';
import { bootstrapFirstApprover, type BootstrapResult } from './bootstrap';
import { identityProjector } from './projector';
import { defaultClientIp, mountIdentityRoutes } from './routes';
import { IdentityServiceImpl } from './service';
import { DEFAULT_THROTTLE, FailureThrottle, type ThrottleOptions } from './throttle';

export { BOOTSTRAP_TOKEN_ENV, bootstrapTokenPath, type BootstrapResult } from './bootstrap';
export {
  decisionCardHash,
  decisionChallenge,
  PASSKEY_CHALLENGE_TTL_MS,
  userBodyScope,
  webauthnUserHandle,
  type DecisionBinding,
} from './passkeys';
export { identityProjector } from './projector';
export { defaultClientIp, SESSION_COOKIE } from './routes';
export {
  IDENTITY_SYSTEM_ACTOR,
  IdentityServiceImpl,
  TOKEN_SHOWN_ONCE_NOTE,
  type CreateUserInput,
  type IssueTokenOptions,
  type TokenCheck,
  type UpdateUserPatch,
  type WebSessionResult,
} from './service';
export { assertNotRequester, separationOfDutiesViolation, type SodCard } from './sod';
export {
  identityServiceOf,
  identityTestHelpers,
  type IdentityTestHelpers,
  type IdentityTestUser,
} from './testing';
export { DEFAULT_THROTTLE, FailureThrottle, type ThrottleOptions } from './throttle';
export { hashToken, parseToken } from './tokens';

export interface IdentityModuleOptions {
  /** Create the first Approver on start when nobody exists yet (default true). */
  bootstrap?: boolean;
  /** Where AOC_BOOTSTRAP_TOKEN is read from (default process.env). */
  env?: Record<string, string | undefined>;
  /** Trust the last X-Forwarded-For hop for brute-force accounting (only behind a proxy you control). */
  trustProxy?: boolean;
  /** Override client-address resolution (tests). */
  clientIp?: (c: Ctx) => string;
  bruteForce?: Partial<ThrottleOptions>;
}

export interface IdentityModule extends AocModule {
  /** The service, once init has run. */
  readonly service: IdentityServiceImpl | null;
  /** What bootstrap did on start (null before start or when disabled). */
  readonly bootstrapResult: BootstrapResult | null;
}

/**
 * Identity layer (§6, §15.3): users and roles, hashed bearer / cookie / ingest tokens, brute-force
 * backoff, and per-decision WebAuthn passkeys. Provides the `identity` service; mount it before other
 * modules so its guard middleware (backoff + cookie CSRF origin check) precedes their routes.
 */
export function createIdentityModule(opts: IdentityModuleOptions = {}): IdentityModule {
  let service: IdentityServiceImpl | null = null;
  let bootstrapResult: BootstrapResult | null = null;
  const requireService = (): IdentityServiceImpl => {
    if (!service) throw new Error('identity module not initialised');
    return service;
  };
  return {
    name: 'identity',
    projectors: [identityProjector],
    get service() {
      return service;
    },
    get bootstrapResult() {
      return bootstrapResult;
    },
    init(ctx: ModuleContext) {
      service = new IdentityServiceImpl(ctx);
      ctx.services.provide('identity', service);
      warnOnRpMismatch(ctx);
    },
    routes(app, ctx) {
      mountIdentityRoutes(app, ctx, {
        service: requireService(),
        throttle: new FailureThrottle(ctx.clock, { ...DEFAULT_THROTTLE, ...opts.bruteForce }),
        clientIp: opts.clientIp ?? defaultClientIp(opts.trustProxy ?? false),
      });
    },
    start(ctx) {
      if (opts.bootstrap !== false)
        bootstrapResult = bootstrapFirstApprover(requireService(), ctx, opts.env ?? process.env);
    },
  };
}

/** WebAuthn only works when rpId is the origin's host or a registrable suffix of it. */
function warnOnRpMismatch(ctx: ModuleContext): void {
  const { rpId, origin } = ctx.config.identity;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    ctx.log.warn('identity: config.identity.origin is not a URL; passkeys will fail', { origin });
    return;
  }
  if (host !== rpId && !host.endsWith(`.${rpId}`))
    ctx.log.warn('identity: rpId does not match the origin host; passkeys will fail', { rpId, origin });
}
