import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import {
  AuthLoginRequestSchema,
  BEARER_ATTRIBUTION_NOTE,
  IDENTITY_TOKEN_KINDS,
  IdentityCreateUserSchema,
  IdentityIssueTokenSchema,
  IdentityUpdateUserSchema,
  PasskeyAssertOptionsSchema,
  PasskeyRegisterVerifySchema,
  type Actor,
  type AuthContext,
  type AuthLoginResponse,
  type IdentityTokenKind,
} from '@aoc/contracts';
import {
  HttpError,
  readJson,
  requirePermission,
  requireUser,
  tokenFrom,
  type App,
  type Ctx,
  type ModuleContext,
} from '@aoc/kernel';
import type { IdentityServiceImpl } from './service';
import type { FailureThrottle } from './throttle';
import { parseToken } from './tokens';

export const SESSION_COOKIE = 'aoc_session';
const LOGIN_PATH = '/api/auth/login';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export interface IdentityRouteDeps {
  service: IdentityServiceImpl;
  throttle: FailureThrottle;
  clientIp: (c: Ctx) => string;
}

/**
 * Client address for brute-force accounting. Behind a reverse proxy you control, trust the LAST
 * X-Forwarded-For hop (the one your proxy appended); earlier hops are client-supplied and spoofable.
 */
export function defaultClientIp(trustProxy: boolean): (c: Ctx) => string {
  return (c) => {
    if (trustProxy) {
      const hops = c.req
        .header('x-forwarded-for')
        ?.split(',')
        .map((h) => h.trim())
        .filter(Boolean);
      if (hops?.length) return hops[hops.length - 1]!;
    }
    const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
    return env?.incoming?.socket?.remoteAddress ?? 'unknown';
  };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const humanActor = (auth: AuthContext): Actor => ({ kind: 'human', id: auth.user.id });

export function mountIdentityRoutes(app: App, ctx: ModuleContext, deps: IdentityRouteDeps): void {
  const { service, throttle } = deps;
  const allowedOrigins = new Set(
    [originOf(ctx.config.identity.origin), originOf(ctx.config.publicUrl)].filter(
      (o): o is string => o !== null,
    ),
  );
  const secureCookie = ctx.config.publicUrl.toLowerCase().startsWith('https:');
  const cookieBase = { path: '/', httpOnly: true, sameSite: 'Strict' as const, secure: secureCookie };

  const throttleKeys = (c: Ctx, prefix: string | null): string[] => [
    `ip:${deps.clientIp(c)}`,
    ...(prefix ? [`prefix:${prefix}`] : []),
  ];
  const retryAfterMs = (keys: string[]): number => Math.max(0, ...keys.map((k) => throttle.retryAfterMs(k)));
  const recordFailure = (keys: string[]): void => {
    for (const k of keys) {
      const lockMs = throttle.fail(k);
      if (lockMs > 0) ctx.log.warn('auth backoff engaged', { key: k, lockMs });
    }
  };
  const tooManyAttempts = (c: Ctx, waitMs: number): Response => {
    const seconds = Math.max(1, Math.ceil(waitMs / 1000));
    return c.json(
      {
        error: {
          code: 'too_many_attempts',
          message: 'Too many failed attempts; try again later',
          details: { retryAfterSeconds: seconds },
        },
      },
      429,
      {
        'Retry-After': String(seconds),
      },
    );
  };

  // Mounted first so it guards every route registered after it (mount identity before other modules).
  app.use('*', async (c, next) => {
    const isLogin = c.req.path === LOGIN_PATH;
    const auth = c.get('auth');
    // CSRF defence in depth on top of SameSite=Strict: a cookie-authenticated (or login) write must come from our origin.
    if (!SAFE_METHODS.has(c.req.method) && (isLogin || auth?.method === 'cookie')) {
      const origin = c.req.header('origin');
      if (origin !== undefined && !allowedOrigins.has(origin))
        throw new HttpError(403, 'bad_origin', 'Cross-origin request refused');
    }
    const tok = isLogin ? null : tokenFrom(c);
    if (tok && !auth && !c.get('ingest')) {
      // Count only guesses (no such token). Stale cookies or revoked hook tokens are not attacks and must
      // not lock a shared address out. While locked, guesses get 429; valid credentials still pass, since
      // blocking them would hand any co-located attacker a lockout of everyone behind the same IP.
      const check = c.req.path.startsWith('/ingest/')
        ? service.checkIngestCredential(tok.token)
        : service.checkUserCredential(tok.token);
      if (!check.ok && (check.reason === 'unknown' || check.reason === 'malformed')) {
        const keys = throttleKeys(c, check.prefix);
        const wait = retryAfterMs(keys);
        if (wait > 0) return tooManyAttempts(c, wait);
        recordFailure(keys);
      }
    }
    await next();
  });

  // ── auth ───────────────────────────────────────────────────────────────────
  app.post(LOGIN_PATH, async (c) => {
    const body = await readJson(c, AuthLoginRequestSchema);
    const prefix = parseToken(body.token)?.prefix ?? null;
    const keys = throttleKeys(c, prefix);
    // Login is a hard lock: during backoff even a correct token is refused, so the lock really slows guessing.
    const wait = retryAfterMs(keys);
    if (wait > 0) return tooManyAttempts(c, wait);
    const result = service.openWebSession(body.token);
    if (!result.ok) {
      recordFailure(keys);
      ctx.log.info('login failed', { ip: deps.clientIp(c), prefix, reason: result.reason });
      throw new HttpError(401, 'invalid_token', 'Invalid, expired or revoked token');
    }
    // The per-IP counter is deliberately kept: resetting it on success would let an attacker holding one
    // valid token interleave logins to keep guessing others indefinitely.
    if (prefix) throttle.reset(`prefix:${prefix}`);
    setCookie(c, SESSION_COOKIE, result.issued.token, { ...cookieBase, maxAge: result.maxAgeSeconds });
    c.header('Cache-Control', 'no-store');
    const res: AuthLoginResponse = {
      ...service.me(result.auth),
      expiresAt: result.issued.expiresAt!,
      attribution: { level: 'bearer_attribution', note: BEARER_ATTRIBUTION_NOTE },
    };
    return c.json(res);
  });

  app.post('/api/auth/logout', (c) => {
    const cookie = getCookie(c, SESSION_COOKIE);
    if (cookie) service.closeWebSession(cookie);
    deleteCookie(c, SESSION_COOKIE, cookieBase);
    return c.json({ ok: true });
  });

  app.get('/api/auth/me', (c) => {
    const auth = requireUser(c);
    c.header('Cache-Control', 'no-store');
    return c.json(service.me(auth));
  });

  // Every governance record names its developer (§6): operators may resolve each other's names.
  app.get('/api/directory', (c) => {
    requirePermission(c, 'audit.view');
    return c.json(service.directory());
  });

  // ── users (admin) ──────────────────────────────────────────────────────────
  app.get('/api/users', (c) => {
    requirePermission(c, 'users.manage');
    return c.json({ users: service.listUserDtos() });
  });

  app.post('/api/users', async (c) => {
    const auth = requirePermission(c, 'users.manage');
    const body = await readJson(c, IdentityCreateUserSchema);
    const user = service.createUser(
      {
        role: body.role,
        name: body.name,
        email: body.email ?? null,
        complianceLead: body.flags?.complianceLead ?? false,
      },
      humanActor(auth),
    );
    return c.json({ user: service.getUserDto(user.id) }, 201);
  });

  app.patch('/api/users/:id', async (c) => {
    const auth = requirePermission(c, 'users.manage');
    const body = await readJson(c, IdentityUpdateUserSchema);
    const user = service.updateUser(
      c.req.param('id'),
      {
        name: body.name,
        email: body.email,
        role: body.role,
        active: body.active,
        complianceLead: body.flags?.complianceLead,
      },
      humanActor(auth),
    );
    return c.json({ user: service.getUserDto(user.id) });
  });

  // ── tokens ─────────────────────────────────────────────────────────────────
  app.post('/api/users/:id/tokens', async (c) => {
    const auth = requirePermission(c, 'users.manage');
    const body = await readJson(c, IdentityIssueTokenSchema);
    const issued = service.issueUserToken(
      c.req.param('id'),
      { label: body.label, expiresInDays: body.expiresInDays },
      humanActor(auth),
    );
    c.header('Cache-Control', 'no-store');
    return c.json(issued, 201);
  });

  app.get('/api/users/:id/tokens', (c) => {
    const auth = requireUser(c);
    const id = c.req.param('id');
    if (id !== auth.user.id) requirePermission(c, 'users.manage');
    if (!service.getUser(id)) throw new HttpError(404, 'user_not_found', 'User not found');
    return c.json({ tokens: service.listTokens({ userId: id }) });
  });

  app.get('/api/tokens', (c) => {
    requirePermission(c, 'users.manage');
    const kind = c.req.query('kind');
    if (kind !== undefined && !(IDENTITY_TOKEN_KINDS as readonly string[]).includes(kind))
      throw new HttpError(422, 'invalid', 'Unknown token kind');
    return c.json({ tokens: service.listTokens({ kind: kind as IdentityTokenKind | undefined }) });
  });

  app.delete('/api/tokens/:id', (c) => {
    const auth = requireUser(c);
    const token = service.getToken(c.req.param('id'));
    // Revoking only ever reduces access, so people may revoke their own credentials; others need users.manage.
    const own = token !== null && token.userId === auth.user.id;
    if (!own) requirePermission(c, 'users.manage');
    if (!token) throw new HttpError(404, 'token_not_found', 'Token not found');
    const revoked = service.revokeToken(
      token.tokenId,
      own ? 'revoked_by_owner' : 'revoked_by_admin',
      humanActor(auth),
    )!;
    return c.json({ ok: true, revoked });
  });

  app.post('/api/tokens/observer', async (c) => {
    const auth = requirePermission(c, 'users.manage');
    const body = await readJson(c, IdentityIssueTokenSchema);
    const issued = service.issueObserver(humanActor(auth), {
      label: body.label,
      expiresInDays: body.expiresInDays,
    });
    c.header('Cache-Control', 'no-store');
    return c.json(issued, 201);
  });

  // ── passkeys ───────────────────────────────────────────────────────────────
  app.post('/api/passkeys/register/options', async (c) => {
    const auth = requireUser(c);
    c.header('Cache-Control', 'no-store');
    return c.json(await service.passkeys.registrationOptions(auth.user));
  });

  app.post('/api/passkeys/register/verify', async (c) => {
    const auth = requireUser(c);
    const body = await readJson(c, PasskeyRegisterVerifySchema);
    const passkey = await service.passkeys.verifyRegistration(
      auth.user,
      auth.tokenId,
      body.response,
      body.label,
    );
    return c.json({ passkey }, 201);
  });

  app.get('/api/passkeys', (c) => {
    const auth = requireUser(c);
    const userId = c.req.query('userId') ?? auth.user.id;
    if (userId !== auth.user.id) requirePermission(c, 'users.manage');
    return c.json({ passkeys: service.passkeys.list(userId) });
  });

  app.delete('/api/passkeys/:id', (c) => {
    const auth = requireUser(c);
    service.passkeys.remove(c.req.param('id'), auth.user, service.can(auth.user, 'users.manage'));
    return c.json({ ok: true });
  });

  app.post('/api/passkeys/assert/options', async (c) => {
    const auth = requireUser(c);
    const body = await readJson(c, PasskeyAssertOptionsSchema);
    c.header('Cache-Control', 'no-store');
    return c.json(await service.passkeys.assertionOptions(auth.user, body.decisionId, body.optionId));
  });
}
