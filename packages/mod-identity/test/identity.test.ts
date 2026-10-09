import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AocConfigSchema,
  validateEvent,
  type AuthLoginResponse,
  type AuthMeDto,
  type IdentityTokenDto,
  type IdentityUserDto,
  type IssuedTokenDto,
} from '@aoc/contracts';
import {
  AocRuntime,
  createLogger,
  createTestRuntime,
  FakeClock,
  HttpError,
  requireIngest,
  type AocModule,
} from '@aoc/kernel';
import {
  assertNotRequester,
  createIdentityModule,
  hashToken,
  identityServiceOf,
  separationOfDutiesViolation,
  userBodyScope,
} from '../src';
import { ip, sessionCookieFrom, setupIdentity } from './helpers/setup';

const T0 = '2026-10-09T02:00:00.000Z';

describe('bootstrap', () => {
  it('creates the first Approver once, writes its token 0600 and logs only the file path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aoc-idn-boot-'));
    const lines: string[] = [];
    const log = createLogger({ level: 'debug', sink: (l) => lines.push(l) });
    const config = AocConfigSchema.parse({ dataDir: dir });
    const masterKey = randomBytes(32);
    const boot = async () => {
      const mod = createIdentityModule({ env: {} });
      const rt = await AocRuntime.create({
        config,
        modules: [mod],
        clock: new FakeClock(T0),
        log,
        masterKey,
        dataDir: dir,
      });
      return { mod, rt };
    };
    try {
      const first = await boot();
      const file = join(dir, 'bootstrap-token');
      expect(first.mod.bootstrapResult).toMatchObject({ created: true, source: 'file', tokenFile: file });
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const token = readFileSync(file, 'utf8').trim();
      expect(token).toMatch(/^aoc_u_[0-9A-Za-z]{43}$/);
      const me = await first.rt
        .mount()
        .request('/api/auth/me', { headers: { authorization: `Bearer ${token}` } });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({
        user: { name: 'Owner', role: 'approver', active: true },
        method: 'bearer',
      });
      const logged = lines.join('\n');
      expect(logged).toContain(file);
      expect(logged).not.toContain(token);
      await first.rt.stop();

      const second = await boot();
      expect(second.mod.bootstrapResult).toMatchObject({ created: false });
      const svc = identityServiceOf(second.rt.services);
      expect(svc.listUsers()).toHaveLength(1);
      expect(readFileSync(file, 'utf8').trim()).toBe(token);
      expect(svc.authenticate(token)?.user.role).toBe('approver');
      expect(second.rt.store.list({ types: ['user.created', 'token.issued'] })).toHaveLength(2);
      expect(second.rt.store.verifyChain().ok).toBe(true);
      await second.rt.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('takes the first token from AOC_BOOTSTRAP_TOKEN without writing a file, and refuses weak ones', async () => {
    const envToken = `aoc_u_${'Zx9'.repeat(14)}`;
    const t = await createTestRuntime({
      modules: [createIdentityModule({ env: { AOC_BOOTSTRAP_TOKEN: envToken } })],
      onDisk: true,
    });
    try {
      expect(identityServiceOf(t.rt.services).authenticate(envToken)?.user).toMatchObject({
        name: 'Owner',
        role: 'approver',
      });
      expect(existsSync(join(t.dataDir, 'bootstrap-token'))).toBe(false);
      expect(t.rt.store.list({ types: ['token.issued'] })[0]!.meta).toMatchObject({
        kind: 'user',
        tokenHash: hashToken(envToken),
      });
    } finally {
      await t.close();
    }
    await expect(
      createTestRuntime({ modules: [createIdentityModule({ env: { AOC_BOOTSTRAP_TOKEN: 'hunter2' } })] }),
    ).rejects.toThrow(/AOC_BOOTSTRAP_TOKEN/);
  });

  it('skips bootstrap when a first token could not be delivered (in-memory data dir, no env)', async () => {
    const mod = createIdentityModule({ env: {} });
    const t = await createTestRuntime({ modules: [mod] });
    expect(mod.bootstrapResult).toMatchObject({ created: false });
    expect(identityServiceOf(t.rt.services).listUsers()).toEqual([]);
    await t.close();
  });
});

describe('token storage', () => {
  it('keeps only sha256 hashes: no plaintext in events, bodies, projections, responses or DB files', async () => {
    const { t, service, h } = await setupIdentity({ onDisk: true });
    try {
      const owner = h.user('approver', 'Ada', { email: 'ada@example.com' });
      const personal = await t.json<IssuedTokenDto>('POST', `/api/users/${owner.user.id}/tokens`, {
        headers: owner.headers,
        body: { label: 'laptop', expiresInDays: 30 },
        expect: 201,
      });
      expect(personal).toMatchObject({
        kind: 'user',
        prefix: personal.token.slice(0, 14),
        expiresAt: '2026-11-08T02:00:00.000Z',
      });
      expect(personal.note).toMatch(/only once/);
      const login = await t.request('POST', '/api/auth/login', { body: { token: personal.token } });
      const loginBody = await login.text();
      const session = sessionCookieFrom(login)!;
      const observer = await t.json<IssuedTokenDto>('POST', '/api/tokens/observer', {
        headers: owner.headers,
        body: { label: 'dev box' },
        expect: 201,
      });
      const ingest = service.issueIngestToken('ses_TEST1', { kind: 'system', id: 'supervisor' });
      const system = service.issueSystemToken();
      const tokens = [owner.token, personal.token, session, observer.token, ingest, system];
      expect(tokens.map((x) => x.slice(0, 6))).toEqual([
        'aoc_u_',
        'aoc_u_',
        'aoc_w_',
        'aoc_o_',
        'aoc_i_',
        'aoc_s_',
      ]);
      for (const tok of tokens) expect(tok).toMatch(/^aoc_[uwios]_[0-9A-Za-z]{43}$/);

      const events = t.rt.store.list({ limit: 10_000 });
      const issued = events.filter((e) => e.type === 'token.issued');
      expect(issued.map((e) => e.meta.tokenHash).sort()).toEqual(tokens.map(hashToken).sort());
      const haystacks = [
        JSON.stringify(events),
        JSON.stringify(events.map((e) => t.rt.store.readPayload(e))),
        ...['idn_users', 'idn_tokens', 'idn_passkeys'].map((tbl) =>
          JSON.stringify(t.rt.store.db.prepare(`SELECT * FROM ${tbl}`).all()),
        ),
        loginBody,
        JSON.stringify(await t.json('GET', `/api/users/${owner.user.id}/tokens`, { headers: owner.headers })),
        JSON.stringify(await t.json('GET', '/api/tokens', { headers: owner.headers })),
      ];
      for (const f of readdirSync(t.dataDir)) {
        const p = join(t.dataDir, f);
        if (statSync(p).isFile()) haystacks.push(readFileSync(p).toString('latin1'));
      }
      // Only the 14-char display prefix may appear; the secret tail never does.
      for (const tok of tokens)
        for (const hs of haystacks)
          expect(hs.includes(tok.slice(14)), `secret of ${tok.slice(0, 14)} leaked`).toBe(false);

      const listed = await t.json<{ tokens: IdentityTokenDto[] }>('GET', '/api/tokens', {
        headers: owner.headers,
      });
      for (const row of listed.tokens) {
        expect(row).not.toHaveProperty('token');
        expect(row).not.toHaveProperty('hash');
      }
      expect(listed.tokens.find((x) => x.tokenId === personal.tokenId)).toMatchObject({
        label: 'laptop',
        prefix: personal.prefix,
        status: 'active',
        createdBy: owner.user.id,
      });
      const observers = await t.json<{ tokens: IdentityTokenDto[] }>('GET', '/api/tokens?kind=observer', {
        headers: owner.headers,
      });
      expect(observers.tokens.map((x) => x.tokenId)).toEqual([observer.tokenId]);
      for (const e of events) expect(validateEvent(e.type, e.meta, t.rt.store.readPayload(e))).toEqual([]);
      expect(t.rt.store.verifyChain().ok).toBe(true);
    } finally {
      await t.close();
    }
  });
});

describe('login, cookie session, logout', () => {
  it('exchanges a user token for a separate HttpOnly SameSite=Strict cookie session; logout revokes it', async () => {
    const { t, h } = await setupIdentity();
    const ada = h.user('approver', 'Ada');
    const res = await t.request('POST', '/api/auth/login', { body: { token: ada.token } });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toMatch(
      /^aoc_session=aoc_w_[0-9A-Za-z]{43}; Max-Age=43200; Path=\/; HttpOnly; SameSite=Strict$/,
    );
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as AuthLoginResponse;
    expect(body).toMatchObject({
      user: { id: ada.user.id, role: 'approver' },
      method: 'cookie',
      hasPasskey: false,
      expiresAt: '2026-10-09T14:00:00.000Z',
    });
    expect(body.attribution).toMatchObject({ level: 'bearer_attribution' });
    expect(body.attribution.note).toMatch(/which token was used, not who/);
    expect(body.attribution.note).toMatch(/passkey/);
    expect(body.permissions).toContain('users.manage');
    const session = sessionCookieFrom(res)!;
    expect(session).not.toBe(ada.token);
    const cookie = { cookie: `aoc_session=${session}` };
    expect(await t.json<AuthMeDto>('GET', '/api/auth/me', { headers: cookie })).toMatchObject({
      method: 'cookie',
      tokenId: body.tokenId,
      user: { id: ada.user.id },
    });

    const out = await t.request('POST', '/api/auth/logout', { headers: cookie });
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toMatch(
      /^aoc_session=; Max-Age=0; Path=\/; HttpOnly; SameSite=Strict$/,
    );
    expect((await t.request('GET', '/api/auth/me', { headers: cookie })).status).toBe(401);
    expect(t.rt.store.list({ types: ['token.revoked'] }).map((e) => e.meta)).toEqual([
      { tokenId: body.tokenId, reason: 'logout' },
    ]);
    expect((await t.request('GET', '/api/auth/me', { headers: ada.headers })).status).toBe(200);
    await t.close();
  });

  it('sets Secure on https, expires after sessionTtlHours and dies with its user token', async () => {
    const { t, h } = await setupIdentity({
      config: {
        publicUrl: 'https://aoc.example.com',
        identity: { origin: 'https://aoc.example.com', rpId: 'aoc.example.com', sessionTtlHours: 2 },
      },
    });
    const bo = h.user('builder', 'Bo');
    const login = async () => {
      const res = await t.request('POST', '/api/auth/login', { body: { token: bo.token } });
      expect(res.status).toBe(200);
      return { res, headers: { cookie: `aoc_session=${sessionCookieFrom(res)}` } };
    };
    const first = await login();
    expect(first.res.headers.get('set-cookie')).toMatch(
      /Max-Age=7200; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
    );
    t.clock.advance(2 * 3_600_000 + 1);
    expect((await t.request('GET', '/api/auth/me', { headers: first.headers })).status).toBe(401);

    const second = await login();
    expect((await t.request('GET', '/api/auth/me', { headers: second.headers })).status).toBe(200);
    const revoke = await t.json<{ revoked: string[] }>('DELETE', `/api/tokens/${bo.tokenId}`, {
      headers: second.headers,
    });
    expect(revoke.revoked).toHaveLength(2);
    expect((await t.request('GET', '/api/auth/me', { headers: second.headers })).status).toBe(401);
    expect((await t.request('GET', '/api/auth/me', { headers: bo.headers })).status).toBe(401);
    expect(t.rt.store.list({ types: ['token.revoked'] }).map((e) => e.meta.reason)).toEqual([
      'revoked_by_owner',
      'parent_revoked',
    ]);
    await t.close();
  });

  it('only accepts live user tokens at login, and never outlives an expiring one', async () => {
    const { t, h, service } = await setupIdentity();
    const ada = h.user('approver');
    const session = h.cookieHeaders(ada.token).cookie.split('=')[1]!;
    const shortLived = h.token(ada.user.id, { expiresInDays: 1 });
    for (const token of [
      session,
      service.issueIngestToken('ses_X'),
      service.issueObserverToken(),
      'aoc_u_nope',
      'not-a-token',
    ]) {
      expect((await t.request('POST', '/api/auth/login', { body: { token } })).status).toBe(401);
    }
    const res = await t.request('POST', '/api/auth/login', {
      headers: ip('192.0.2.50'),
      body: { token: shortLived.token },
    });
    expect(((await res.json()) as AuthLoginResponse).expiresAt).toBe('2026-10-09T14:00:00.000Z');
    t.clock.advance(23 * 3_600_000);
    const late = await t.request('POST', '/api/auth/login', {
      headers: ip('192.0.2.50'),
      body: { token: shortLived.token },
    });
    expect(((await late.json()) as AuthLoginResponse).expiresAt).toBe('2026-10-10T02:00:00.000Z');
    expect(sessionCookieFrom(late)).toBeTruthy();
    expect(late.headers.get('set-cookie')).toContain('Max-Age=3600;');
    expect((await t.request('POST', '/api/auth/login', { body: {} })).status).toBe(422);
    await t.close();
  });

  it('refuses cross-origin logins and cookie-authenticated cross-origin writes', async () => {
    const { t, h } = await setupIdentity();
    const ada = h.user('approver');
    const evil = { origin: 'https://evil.example' };
    expect(
      (await t.request('POST', '/api/auth/login', { headers: evil, body: { token: ada.token } })).status,
    ).toBe(403);
    expect(
      (
        await t.request('POST', '/api/auth/login', {
          headers: { origin: 'http://localhost:7420' },
          body: { token: ada.token },
        })
      ).status,
    ).toBe(200);
    const cookie = h.cookieHeaders(ada.token);
    const create = { body: { name: 'Cy', role: 'builder' } };
    const bad = await t.request('POST', '/api/users', { headers: { ...cookie, ...evil }, ...create });
    expect(bad.status).toBe(403);
    expect(await bad.json()).toMatchObject({ error: { code: 'bad_origin' } });
    expect(
      (
        await t.request('POST', '/api/users', {
          headers: { ...cookie, origin: 'http://localhost:7420' },
          ...create,
        })
      ).status,
    ).toBe(201);
    // Bearer credentials are never attached by a browser cross-site, so they are not CSRF-able.
    expect(
      (
        await t.request('POST', '/api/users', {
          headers: { ...ada.headers, ...evil },
          body: { name: 'Di', role: 'builder' },
        })
      ).status,
    ).toBe(201);
    expect((await t.request('GET', '/api/users', { headers: { ...cookie, ...evil } })).status).toBe(200);
    await t.close();
  });
});

describe('brute-force protection', () => {
  const guess = () => `aoc_u_${randomBytes(32).toString('hex').slice(0, 43)}`;

  it('backs off per IP at login, refusing even a valid token while locked, then recovers', async () => {
    const { t, h } = await setupIdentity({ identity: { bruteForce: { threshold: 3, baseMs: 60_000 } } });
    const ada = h.user('approver');
    const attacker = ip('203.0.113.9');
    for (const token of [guess(), 'garbage', guess()]) {
      expect(
        (await t.request('POST', '/api/auth/login', { headers: attacker, body: { token } })).status,
      ).toBe(401);
    }
    const locked = await t.request('POST', '/api/auth/login', {
      headers: attacker,
      body: { token: ada.token },
    });
    expect(locked.status).toBe(429);
    expect(locked.headers.get('retry-after')).toBe('60');
    expect(await locked.json()).toMatchObject({
      error: { code: 'too_many_attempts', details: { retryAfterSeconds: 60 } },
    });
    expect(
      (
        await t.request('POST', '/api/auth/login', {
          headers: ip('203.0.113.10'),
          body: { token: ada.token },
        })
      ).status,
    ).toBe(200);
    t.clock.advance(59_000);
    expect(
      (await t.request('POST', '/api/auth/login', { headers: attacker, body: { token: ada.token } })).status,
    ).toBe(429);
    t.clock.advance(1_001);
    expect(
      (await t.request('POST', '/api/auth/login', { headers: attacker, body: { token: ada.token } })).status,
    ).toBe(200);
    // Backoff doubles with each further failure.
    expect(
      (await t.request('POST', '/api/auth/login', { headers: attacker, body: { token: guess() } })).status,
    ).toBe(401);
    expect(
      (
        await t.request('POST', '/api/auth/login', { headers: attacker, body: { token: ada.token } })
      ).headers.get('retry-after'),
    ).toBe('120');
    await t.close();
  });

  it('backs off per token prefix, stopping distributed guessing against one token', async () => {
    const { t, h } = await setupIdentity({ identity: { bruteForce: { threshold: 3, baseMs: 30_000 } } });
    const ada = h.user('approver');
    const prefix = ada.token.slice(0, 14);
    for (let i = 0; i < 3; i++) {
      const forged = prefix + randomBytes(32).toString('hex').slice(0, 35);
      expect(
        (
          await t.request('POST', '/api/auth/login', {
            headers: ip(`198.18.0.${i + 1}`),
            body: { token: forged },
          })
        ).status,
      ).toBe(401);
    }
    const res = await t.request('POST', '/api/auth/login', {
      headers: ip('198.18.0.99'),
      body: { token: ada.token },
    });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('30');
    t.clock.advance(30_001);
    expect(
      (await t.request('POST', '/api/auth/login', { headers: ip('198.18.0.99'), body: { token: ada.token } }))
        .status,
    ).toBe(200);
    await t.close();
  });

  it('counts unknown bearer tokens on any route, but never stale credentials', async () => {
    const { t, h } = await setupIdentity({ identity: { bruteForce: { threshold: 3, baseMs: 60_000 } } });
    const ada = h.user('approver');
    const scanner = ip('203.0.113.77');
    for (let i = 0; i < 3; i++) {
      expect(
        (
          await t.request('GET', '/api/auth/me', {
            headers: { ...scanner, authorization: `Bearer ${guess()}` },
          })
        ).status,
      ).toBe(401);
    }
    expect(
      (await t.request('GET', '/api/users', { headers: { ...scanner, authorization: `Bearer ${guess()}` } }))
        .status,
    ).toBe(429);
    expect(
      (
        await t.request('POST', '/ingest/hook', {
          headers: { ...scanner, authorization: 'Bearer aoc_i_nope' },
        })
      ).status,
    ).toBe(401); // the kernel refuses unknown ingest tokens before any module middleware or body parsing
    // Valid credentials from the same address still work outside login (no shared-IP lockout) ...
    expect((await t.request('GET', '/api/auth/me', { headers: { ...scanner, ...ada.headers } })).status).toBe(
      200,
    );
    // ... but login from it stays locked.
    expect(
      (await t.request('POST', '/api/auth/login', { headers: scanner, body: { token: ada.token } })).status,
    ).toBe(429);

    const stale = h.token(ada.user.id);
    await t.json('DELETE', `/api/tokens/${stale.tokenId}`, { headers: ada.headers });
    const pollster = ip('203.0.113.88');
    for (let i = 0; i < 10; i++) {
      expect(
        (await t.request('GET', '/api/auth/me', { headers: { ...pollster, ...stale.headers } })).status,
      ).toBe(401);
    }
    expect(
      (await t.request('POST', '/api/auth/login', { headers: pollster, body: { token: ada.token } })).status,
    ).toBe(200);
    await t.close();
  });
});

describe('admin routes', () => {
  it('require users.manage (401 anonymous, 403 builder/requester)', async () => {
    const { t, h } = await setupIdentity();
    const owner = h.user('approver');
    const builder = h.user('builder');
    const requester = h.user('requester');
    const ownerToken = h.token(owner.user.id);
    const routes: [string, string, unknown?][] = [
      ['GET', '/api/users'],
      ['POST', '/api/users', { name: 'X', role: 'approver' }],
      ['PATCH', `/api/users/${builder.user.id}`, { role: 'approver' }],
      ['POST', `/api/users/${builder.user.id}/tokens`, {}],
      ['GET', `/api/users/${owner.user.id}/tokens`],
      ['GET', '/api/tokens'],
      ['POST', '/api/tokens/observer', {}],
      ['DELETE', `/api/tokens/${ownerToken.tokenId}`],
      ['DELETE', '/api/tokens/tok_DOESNOTEXIST'],
    ];
    for (const [method, path, body] of routes) {
      expect((await t.request(method, path, { body })).status, `${method} ${path} anonymous`).toBe(401);
      for (const who of [builder, requester]) {
        expect(
          (await t.request(method, path, { headers: who.headers, body })).status,
          `${method} ${path} as ${who.user.role}`,
        ).toBe(403);
      }
    }
    expect(h.service.getUser(builder.user.id)?.role).toBe('builder');
    expect(h.service.authenticate(ownerToken.token)).not.toBeNull();
    expect(t.rt.store.list({ types: ['user.updated', 'token.revoked'] })).toEqual([]);
    await t.close();
  });

  it('lets the approver create and edit users and issue, list and revoke tokens', async () => {
    const { t, h } = await setupIdentity();
    const owner = h.user('approver', 'Owner');
    const created = await t.json<{ user: IdentityUserDto }>('POST', '/api/users', {
      headers: owner.headers,
      body: { name: '  Ben  ', email: 'Ben@Example.com', role: 'builder', flags: { complianceLead: true } },
      expect: 201,
    });
    expect(created.user).toMatchObject({
      name: 'Ben',
      email: 'ben@example.com',
      role: 'builder',
      flags: { complianceLead: true },
      active: true,
    });
    const ben = created.user.id;
    expect(t.rt.store.list({ types: ['user.created'] }).at(-1)!.meta).toEqual({
      userId: ben,
      role: 'builder',
      complianceLead: true,
    });
    await t.json('POST', '/api/users', {
      headers: owner.headers,
      body: { name: 'Dup', email: 'ben@example.com', role: 'builder' },
      expect: 409,
    });
    await t.json('POST', '/api/users', {
      headers: owner.headers,
      body: { name: 'X', role: 'admin' },
      expect: 422,
    });
    await t.json('POST', '/api/users', {
      headers: owner.headers,
      body: { name: 'X', role: 'builder', id: 'usr_mine' },
      expect: 422,
    });
    await t.json('PATCH', `/api/users/${ben}`, { headers: owner.headers, body: {}, expect: 422 });
    await t.json('PATCH', '/api/users/usr_NOPE', {
      headers: owner.headers,
      body: { name: 'Y' },
      expect: 404,
    });

    const patched = await t.json<{ user: IdentityUserDto }>('PATCH', `/api/users/${ben}`, {
      headers: owner.headers,
      body: { name: 'Ben Ng', role: 'approver', flags: { complianceLead: false }, email: null },
    });
    expect(patched.user).toMatchObject({
      name: 'Ben Ng',
      role: 'approver',
      email: null,
      flags: { complianceLead: false },
    });
    expect(t.rt.store.list({ types: ['user.updated'] }).at(-1)!.meta).toEqual({
      userId: ben,
      role: 'approver',
      active: null,
      complianceLead: false,
    });
    const users = await t.json<{ users: IdentityUserDto[] }>('GET', '/api/users', { headers: owner.headers });
    expect(users.users.map((u) => u.name)).toEqual(['Owner', 'Ben Ng']);

    const issued = await t.json<IssuedTokenDto>('POST', `/api/users/${ben}/tokens`, {
      headers: owner.headers,
      body: { label: 'ci' },
      expect: 201,
    });
    expect(issued.expiresAt).toBeNull();
    const benHeaders = { authorization: `Bearer ${issued.token}` };
    expect(await t.json<AuthMeDto>('GET', '/api/auth/me', { headers: benHeaders })).toMatchObject({
      user: { id: ben, role: 'approver' },
    });
    await t.json('POST', `/api/users/${ben}/tokens`, {
      headers: owner.headers,
      body: { expiresInDays: 0 },
      expect: 422,
    });
    await t.json('POST', '/api/users/usr_NOPE/tokens', { headers: owner.headers, body: {}, expect: 404 });

    const benTokens = await t.json<{ tokens: IdentityTokenDto[] }>('GET', `/api/users/${ben}/tokens`, {
      headers: benHeaders,
    });
    expect(benTokens.tokens).toEqual([
      expect.objectContaining({
        tokenId: issued.tokenId,
        kind: 'user',
        label: 'ci',
        status: 'active',
        createdBy: owner.user.id,
      }),
    ]);
    await t.json('DELETE', `/api/tokens/${issued.tokenId}`, { headers: owner.headers });
    await t.json('DELETE', `/api/tokens/${issued.tokenId}`, { headers: owner.headers });
    await t.json('DELETE', '/api/tokens/tok_DOESNOTEXIST', { headers: owner.headers, expect: 404 });
    expect((await t.request('GET', '/api/auth/me', { headers: benHeaders })).status).toBe(401);
    expect(t.rt.store.list({ types: ['token.revoked'] }).map((e) => e.meta)).toEqual([
      { tokenId: issued.tokenId, reason: 'revoked_by_admin' },
    ]);
    await t.close();
  });

  it('never demotes or deactivates the last active approver', async () => {
    const { t, h } = await setupIdentity();
    const owner = h.user('approver', 'Owner');
    for (const body of [{ role: 'builder' }, { active: false }]) {
      const res = await t.json<{ error: { code: string } }>('PATCH', `/api/users/${owner.user.id}`, {
        headers: owner.headers,
        body,
        expect: 409,
      });
      expect(res.error.code).toBe('last_approver');
    }
    const second = h.user('approver', 'Second');
    await t.json('PATCH', `/api/users/${owner.user.id}`, {
      headers: second.headers,
      body: { role: 'builder' },
    });
    const res = await t.json<{ error: { code: string } }>('PATCH', `/api/users/${second.user.id}`, {
      headers: second.headers,
      body: { active: false },
      expect: 409,
    });
    expect(res.error.code).toBe('last_approver');
    // A deactivated approver does not count: promote back, deactivate one, the other is protected again.
    await t.json('PATCH', `/api/users/${owner.user.id}`, {
      headers: second.headers,
      body: { role: 'approver' },
    });
    await t.json('PATCH', `/api/users/${second.user.id}`, {
      headers: owner.headers,
      body: { active: false },
    });
    await t.json('PATCH', `/api/users/${owner.user.id}`, {
      headers: owner.headers,
      body: { role: 'requester' },
      expect: 409,
    });
    expect(h.service.activeApproverCount()).toBe(1);
    await t.close();
  });

  it('deactivation revokes all tokens and sessions; reactivation does not revive them', async () => {
    const { t, h } = await setupIdentity();
    const owner = h.user('approver');
    const bo = h.user('builder', 'Bo');
    const cookie = h.cookieHeaders(bo.token);
    const ingest = h.ingestHeaders('ses_BO');
    await t.json('PATCH', `/api/users/${bo.user.id}`, { headers: owner.headers, body: { active: false } });
    expect((await t.request('GET', '/api/auth/me', { headers: bo.headers })).status).toBe(401);
    expect((await t.request('GET', '/api/auth/me', { headers: cookie })).status).toBe(401);
    expect((await t.request('POST', '/api/auth/login', { body: { token: bo.token } })).status).toBe(401);
    expect(t.rt.store.list({ types: ['token.revoked'] }).map((e) => e.meta.reason)).toEqual([
      'user_deactivated',
      'user_deactivated',
    ]);
    expect(h.service.verifyIngestToken(ingest.authorization!.slice(7))).not.toBeNull();
    expect(h.service.can(h.service.getUser(bo.user.id)!, 'session.view')).toBe(false);
    await t.json('PATCH', `/api/users/${bo.user.id}`, { headers: owner.headers, body: { active: true } });
    expect((await t.request('GET', '/api/auth/me', { headers: bo.headers })).status).toBe(401);
    const fresh = await t.json<IssuedTokenDto>('POST', `/api/users/${bo.user.id}/tokens`, {
      headers: owner.headers,
      body: {},
      expect: 201,
    });
    expect(
      (await t.request('GET', '/api/auth/me', { headers: { authorization: `Bearer ${fresh.token}` } }))
        .status,
    ).toBe(200);
    await t.close();
  });

  it('lets anyone list and revoke their own tokens, but nobody else’s', async () => {
    const { t, h } = await setupIdentity();
    const owner = h.user('approver');
    const bo = h.user('builder');
    const spare = h.token(bo.user.id, { label: 'spare' });
    const listed = await t.json<{ tokens: IdentityTokenDto[] }>('GET', `/api/users/${bo.user.id}/tokens`, {
      headers: bo.headers,
    });
    expect(listed.tokens.map((x) => x.tokenId).sort()).toEqual([bo.tokenId, spare.tokenId].sort());
    await t.json('DELETE', `/api/tokens/${spare.tokenId}`, { headers: bo.headers });
    expect(h.service.authenticate(spare.token)).toBeNull();
    expect((await t.request('DELETE', `/api/tokens/${owner.tokenId}`, { headers: bo.headers })).status).toBe(
      403,
    );
    expect(h.service.authenticate(owner.token)).not.toBeNull();
    await t.close();
  });
});

describe('ingest tokens', () => {
  it('are scoped to their session and kind, never authenticate users, and die with the session', async () => {
    const probe: AocModule = {
      name: 'probe',
      routes(app) {
        app.post('/ingest/probe/:sessionId', (c) =>
          c.json(requireIngest(c, { sessionId: c.req.param('sessionId') })),
        );
        app.post('/ingest/probe-observed', (c) =>
          c.json(requireIngest(c, { allowObserver: true, allowSystem: false })),
        );
      },
    };
    const mod = createIdentityModule({ bootstrap: false });
    const t = await createTestRuntime({ modules: [mod, probe] });
    const service = identityServiceOf(t.rt.services);
    const supervisor = { kind: 'system' as const, id: 'supervisor' };
    const a = service.issueIngestToken('ses_A', supervisor);
    const a2 = service.issueIngestToken('ses_A', supervisor);
    const b = service.issueIngestToken('ses_B', supervisor);
    const observer = service.issueObserverToken();
    const system = service.issueSystemToken();
    const user = service.createUserWithToken({ role: 'approver' }, {}).issued.token;
    const bearer = (tok: string) => ({ authorization: `Bearer ${tok}` });

    expect(service.verifyIngestToken(a)).toMatchObject({ kind: 'session', sessionId: 'ses_A' });
    expect(service.verifyIngestToken(observer)).toMatchObject({ kind: 'observer' });
    expect(service.verifyIngestToken(system)).toMatchObject({ kind: 'system' });
    expect(service.verifyIngestToken(user)).toBeNull();
    for (const tok of [a, observer, system]) {
      expect(service.authenticate(tok)).toBeNull();
      expect((await t.request('GET', '/api/auth/me', { headers: bearer(tok) })).status).toBe(401);
    }
    expect((await t.request('POST', '/ingest/probe/ses_A', { headers: bearer(a) })).status).toBe(200);
    expect((await t.request('POST', '/ingest/probe/ses_B', { headers: bearer(a) })).status).toBe(403);
    expect((await t.request('POST', '/ingest/probe/ses_A', { headers: bearer(user) })).status).toBe(401);
    expect((await t.request('POST', '/ingest/probe/ses_A', { headers: bearer(observer) })).status).toBe(403);
    expect((await t.request('POST', '/ingest/probe-observed', { headers: bearer(observer) })).status).toBe(
      200,
    );
    expect((await t.request('POST', '/ingest/probe-observed', { headers: bearer(system) })).status).toBe(403);

    service.revokeIngestTokensFor('ses_A', supervisor);
    expect(service.verifyIngestToken(a)).toBeNull();
    expect(service.verifyIngestToken(a2)).toBeNull();
    expect(service.verifyIngestToken(b)).toMatchObject({ sessionId: 'ses_B' });
    expect((await t.request('POST', '/ingest/probe/ses_A', { headers: bearer(a) })).status).toBe(401);
    const revoked = t.rt.store.list({ types: ['token.revoked'] });
    expect(revoked.map((e) => [e.meta.reason, e.scope.sessionId, e.actor.id])).toEqual([
      ['session_ended', 'ses_A', 'supervisor'],
      ['session_ended', 'ses_A', 'supervisor'],
    ]);
    await t.close();
  });
});

describe('separation of duties', () => {
  const card = {
    kind: 'go_live' as const,
    requesterId: 'usr_REQ',
    excludedApproverIds: ['usr_REQ', 'usr_X'],
  };
  it('assertNotRequester refuses the requester and excluded users', () => {
    expect(() => assertNotRequester(card, { id: 'usr_REQ' })).toThrow(/requester cannot resolve/);
    expect(() => assertNotRequester({ ...card, excludedApproverIds: [] }, { id: 'usr_REQ' })).toThrow(
      /requester/,
    );
    expect(() => assertNotRequester(card, { id: 'usr_X' })).toThrow(/excluded/);
    expect(() => assertNotRequester(card, { id: 'usr_OK' })).not.toThrow();
    let caught: unknown = null;
    try {
      assertNotRequester(card, { id: 'usr_REQ' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught).toMatchObject({
      status: 403,
      code: 'separation_of_duties',
      details: { violation: 'requester' },
    });
    expect(
      separationOfDutiesViolation(
        { kind: 'uat_signoff', requesterId: 'usr_U', excludedApproverIds: [] },
        { id: 'usr_U' },
      ),
    ).toBeNull();
    expect(
      separationOfDutiesViolation(
        { kind: 'uat_signoff', requesterId: 'usr_U', excludedApproverIds: ['usr_U'] },
        { id: 'usr_U' },
      ),
    ).toBe('excluded');
  });
});

describe('event sourcing', () => {
  it('rebuilds identical projections from the log and degrades gracefully after erasure', async () => {
    const { t, h } = await setupIdentity();
    const owner = h.user('approver', 'Ada', { email: 'ada@example.com' });
    const bo = h.user('builder', 'Bo');
    h.token(bo.user.id, { label: 'laptop' });
    h.cookieHeaders(bo.token);
    await t.json('PATCH', `/api/users/${bo.user.id}`, {
      headers: owner.headers,
      body: { role: 'approver', name: 'Bo Tan' },
    });
    const snapshot = () =>
      ['idn_users', 'idn_tokens', 'idn_passkeys'].map((tbl) =>
        t.rt.store.db.prepare(`SELECT * FROM ${tbl} ORDER BY id`).all(),
      );
    const before = snapshot();
    t.rt.store.rebuildProjections(['identity']);
    expect(snapshot()).toEqual(before);

    t.rt.store.eraseScope(userBodyScope(bo.user.id), {
      actor: { kind: 'human', id: owner.user.id },
      reason: 'pdpa_request',
    });
    const erased = h.service.getUserDto(bo.user.id)!;
    expect(erased).toMatchObject({ name: '[erased]', email: null, role: 'approver' });
    expect(h.service.listTokens({ userId: bo.user.id }).map((x) => x.label)).toEqual([null, null, null]);
    expect(h.service.authenticate(bo.token)?.user.id).toBe(bo.user.id);
    const afterErase = snapshot();
    t.rt.store.rebuildProjections(['identity']);
    expect(snapshot()).toEqual(afterErase);
    expect(h.service.getUserDto(owner.user.id)).toMatchObject({ name: 'Ada', email: 'ada@example.com' });
    expect(t.rt.store.verifyChain().ok).toBe(true);
    await t.close();
  });
});
