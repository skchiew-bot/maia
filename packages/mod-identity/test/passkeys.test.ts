import { createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { cose, decodeCredentialPublicKey } from '@simplewebauthn/server/helpers';
import { describe, expect, it } from 'vitest';
import {
  PASSKEY_FAILURE_MESSAGE,
  type AuthLoginResponse,
  type AuthMeDto,
  type DecisionCard,
  type PasskeyAssertOptionsResponse,
  type PasskeyDto,
  type PasskeyOptionsResponse,
} from '@aoc/contracts';
import { sha256hex, type BroadcastMessage, type TestRuntime } from '@aoc/kernel';
import {
  decisionCardHash,
  decisionChallenge,
  userBodyScope,
  webauthnUserHandle,
  type DecisionBinding,
} from '../src';
import { FLAG_UP, SoftAuthenticator } from './helpers/authenticator';
import { sessionCookieFrom, setupIdentity } from './helpers/setup';

const T0 = '2026-10-09T02:00:00.000Z';
type RegOptions = {
  challenge: string;
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
};
type AssertOptions = { challenge: string; rpId?: string };
type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };

async function registerPasskey(
  t: TestRuntime,
  headers: Record<string, string>,
  authn: SoftAuthenticator,
  label = 'Touch ID',
) {
  const { options } = await t.json<PasskeyOptionsResponse>('POST', '/api/passkeys/register/options', {
    headers,
  });
  return t.json<{ passkey: PasskeyDto }>('POST', '/api/passkeys/register/verify', {
    headers,
    body: { response: authn.register(options as RegOptions), label },
    expect: 201,
  });
}

/** Ada (approver, passkey registered) approves go-live decisions raised by Bo (builder). */
async function world() {
  const env = await setupIdentity();
  const { t, h } = env;
  const decisions = t.decisions!;
  const ada = h.user('approver', 'Ada');
  const bo = h.user('builder', 'Bo');
  const authn = new SoftAuthenticator();
  await registerPasskey(t, ada.headers, authn);
  const goLive = (requesterId = bo.user.id, title = 'Promote build 42') =>
    decisions.request(
      {
        kind: 'go_live',
        title,
        question: 'Promote release 42 to production?',
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'reject', label: 'Reject' },
        ],
        subjectType: 'promotion',
        subjectId: 'prm_1',
        requesterId,
      },
      { kind: 'human', id: requesterId },
    );
  const assertOptions = async (headers: Record<string, string>, decisionId: string, optionId: string) =>
    t.json<PasskeyAssertOptionsResponse>('POST', '/api/passkeys/assert/options', {
      headers,
      body: { decisionId, optionId },
    });
  const verify = (decisionId: string, optionId: string, assertion: unknown, userId = ada.user.id) =>
    env.service.verifyDecisionPasskeyDetailed({ userId, decisionId, optionId, assertion });
  return { ...env, decisions, ada, bo, authn, goLive, assertOptions, verify };
}

describe('passkey registration', () => {
  it('registers a user-verified passkey from a console session; the public key lives only in the encrypted payload', async () => {
    const { t, h } = await setupIdentity();
    const ada = h.user('approver', 'Ada', { email: 'ada@example.com' });
    const origin = { origin: 'http://localhost:7420' };
    const login = await t.request('POST', '/api/auth/login', { headers: origin, body: { token: ada.token } });
    const sessionId = ((await login.json()) as AuthLoginResponse).tokenId;
    const console = { ...origin, cookie: `aoc_session=${sessionCookieFrom(login)}` };

    const res = await t.json<PasskeyOptionsResponse>('POST', '/api/passkeys/register/options', {
      headers: console,
    });
    expect(res.expiresAt).toBe('2026-10-09T02:05:00.000Z');
    expect(res.options).toMatchObject({
      rp: { id: 'localhost', name: 'AOC — Agent Ops Console' },
      user: {
        id: webauthnUserHandle(ada.user.id).toString('base64url'),
        name: 'ada@example.com',
        displayName: 'Ada',
      },
      attestation: 'none',
      authenticatorSelection: { userVerification: 'required' },
      timeout: 300_000,
      excludeCredentials: [],
    });
    expect((res.options.pubKeyCredParams as { alg: number }[]).map((p) => p.alg)).toEqual([-7, -8, -257]);

    const authn = new SoftAuthenticator();
    const registration = authn.register(res.options as RegOptions);
    const created = await t.json<{ passkey: PasskeyDto }>('POST', '/api/passkeys/register/verify', {
      headers: console,
      body: { response: registration, label: 'Touch ID' },
      expect: 201,
    });
    const credentialIdHash = sha256hex(authn.id);
    expect(created.passkey).toEqual({
      id: credentialIdHash,
      userId: ada.user.id,
      label: 'Touch ID',
      counter: 0,
      transports: ['internal'],
      deviceType: 'singleDevice',
      backedUp: false,
      createdAt: T0,
      lastUsedAt: null,
    });
    expect(await t.json('GET', '/api/passkeys', { headers: console })).toEqual({
      passkeys: [created.passkey],
    });
    expect((await t.json<AuthMeDto>('GET', '/api/auth/me', { headers: console })).hasPasskey).toBe(true);

    const [ev] = t.rt.store.list({ types: ['passkey.registered'] });
    expect(ev!.meta).toEqual({ userId: ada.user.id, credentialIdHash, viaTokenId: sessionId });
    expect(ev!.bodyScope).toBe(userBodyScope(ada.user.id));
    const payload = t.rt.store.readPayload(ev!) as { credential: { id: string; publicKey: string } };
    expect(payload.credential).toMatchObject({
      id: authn.id,
      publicKey: authn.coseKey().toString('base64url'),
    });
    expect(JSON.stringify(ev)).not.toContain(payload.credential.publicKey);

    const replay = await t.json<ErrorBody>('POST', '/api/passkeys/register/verify', {
      headers: console,
      body: { response: registration },
      expect: 422,
    });
    expect(replay.error.code).toBe('challenge_used');
    const again = await t.json<PasskeyOptionsResponse>('POST', '/api/passkeys/register/options', {
      headers: console,
    });
    expect(again.options.excludeCredentials).toEqual([
      { id: authn.id, transports: ['internal'], type: 'public-key' },
    ]);
    const dup = await t.json<ErrorBody>('POST', '/api/passkeys/register/verify', {
      headers: console,
      body: { response: authn.register(again.options as RegOptions) },
      expect: 409,
    });
    expect(dup.error.code).toBe('passkey_exists');
    await t.close();
  });

  it('rejects another origin or RP, missing user verification, and foreign, unknown or stale challenges', async () => {
    const { t, h } = await setupIdentity();
    const ada = h.user('approver');
    const bo = h.user('builder');
    const options = async (who = ada) =>
      (
        await t.json<PasskeyOptionsResponse>('POST', '/api/passkeys/register/options', {
          headers: who.headers,
        })
      ).options as RegOptions;
    const verify = async (response: unknown) =>
      (
        await t.json<ErrorBody>('POST', '/api/passkeys/register/verify', {
          headers: ada.headers,
          body: { response },
          expect: 422,
        })
      ).error.code;
    const authn = new SoftAuthenticator();
    expect(await verify(authn.register(await options(), { origin: 'https://evil.example' }))).toBe(
      'passkey_registration_failed',
    );
    expect(await verify(authn.register(await options(), { rpId: 'evil.example' }))).toBe(
      'passkey_registration_failed',
    );
    expect(await verify(authn.register(await options(), { flags: FLAG_UP }))).toBe(
      'passkey_registration_failed',
    );
    expect(
      await verify(authn.register(await options(), { challenge: randomBytes(32).toString('base64url') })),
    ).toBe('challenge_unknown');
    expect(await verify(authn.register(await options(bo)))).toBe('challenge_unknown');
    const stale = await options();
    t.clock.advance(5 * 60_000);
    expect(await verify(authn.register(stale))).toBe('challenge_expired');
    expect(await verify({ id: 'x' })).toBe('invalid_registration');
    expect((await t.request('POST', '/api/passkeys/register/options')).status).toBe(401);
    expect(t.rt.store.list({ types: ['passkey.registered'] })).toEqual([]);
    await t.close();
  });
});

describe('per-decision passkey assertion', () => {
  it('approves a go-live and records evidence that re-verifies from the log alone', async () => {
    const w = await world();
    const { t, decisions, ada, authn } = w;
    const card = w.goLive();
    const opts = await w.assertOptions(ada.headers, card.id, 'approve');
    expect(opts.cardHash).toBe(decisionCardHash(card));
    expect(opts.expiresAt).toBe('2026-10-09T02:05:00.000Z');
    expect(opts.options).toMatchObject({
      rpId: 'localhost',
      userVerification: 'required',
      timeout: 300_000,
      allowCredentials: [{ id: authn.id, type: 'public-key' }],
    });

    const resolved = await decisions.resolve(
      card.id,
      { optionId: 'approve', passkeyAssertion: authn.assert(opts.options as AssertOptions) },
      ada.user,
    );
    expect(resolved.resolution).toMatchObject({
      optionId: 'approve',
      method: 'passkey',
      passkeyVerified: true,
      resolvedBy: ada.user.id,
    });
    const credentialIdHash = sha256hex(authn.id);
    const [asserted] = t.rt.store.list({ types: ['passkey.asserted'] });
    expect(asserted!.meta).toMatchObject({
      userId: ada.user.id,
      credentialIdHash,
      decisionId: card.id,
      optionId: 'approve',
      cardHash: opts.cardHash,
      counter: 1,
      userVerified: true,
    });
    expect(asserted!.scope).toEqual({ userId: ada.user.id, decisionId: card.id });
    expect(t.rt.store.list({ types: ['passkey.counter_updated'] }).map((e) => e.meta)).toEqual([
      { userId: ada.user.id, credentialIdHash, counter: 1, decisionId: card.id },
    ]);

    // An auditor needs only the log: registered public key + assertion evidence + the decision as requested.
    const evidence = t.rt.store.readPayload(asserted!) as unknown as {
      binding: DecisionBinding;
      clientDataJSON: string;
      authenticatorData: string;
      signature: string;
    };
    const challenge = decisionChallenge(evidence.binding);
    const clientDataBytes = Buffer.from(evidence.clientDataJSON, 'base64url');
    expect(JSON.parse(clientDataBytes.toString('utf8'))).toMatchObject({
      type: 'webauthn.get',
      challenge: challenge.toString('base64url'),
      origin: 'http://localhost:7420',
    });
    expect(asserted!.meta.challengeHash).toBe(challenge.toString('hex'));
    const registered = t.rt.store.readPayload(t.rt.store.list({ types: ['passkey.registered'] })[0]!) as {
      credential: { publicKey: string };
    };
    const coseKey = decodeCredentialPublicKey(
      new Uint8Array(Buffer.from(registered.credential.publicKey, 'base64url')),
    );
    if (!cose.isCOSEPublicKeyEC2(coseKey)) throw new Error('expected an EC2 key');
    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: Buffer.from(coseKey.get(cose.COSEKEYS.x)!).toString('base64url'),
        y: Buffer.from(coseKey.get(cose.COSEKEYS.y)!).toString('base64url'),
      },
      format: 'jwk',
    });
    const signedData = Buffer.concat([
      Buffer.from(evidence.authenticatorData, 'base64url'),
      createHash('sha256').update(clientDataBytes).digest(),
    ]);
    expect(
      verifySignature('sha256', signedData, publicKey, Buffer.from(evidence.signature, 'base64url')),
    ).toBe(true);
    const requested = t.rt.store.list({ types: ['decision.requested'], decisionId: card.id })[0]!;
    const asRequested = t.rt.store.readPayload(requested) as unknown as Pick<
      DecisionCard,
      'title' | 'question' | 'options'
    >;
    expect(decisionCardHash({ id: card.id, kind: 'go_live', ...asRequested })).toBe(
      evidence.binding.cardHash,
    );
    expect(evidence.binding).toMatchObject({
      v: 1,
      rpId: 'localhost',
      userId: ada.user.id,
      decisionId: card.id,
      optionId: 'approve',
    });

    const [pk] = (await t.json<{ passkeys: PasskeyDto[] }>('GET', '/api/passkeys', { headers: ada.headers }))
      .passkeys;
    expect(pk).toMatchObject({ counter: 1, lastUsedAt: T0 });
    expect(t.rt.store.verifyChain().ok).toBe(true);
    await t.close();
  });

  it('binds each challenge to one decision and one option', async () => {
    const w = await world();
    const { t, decisions, ada, authn } = w;
    const x = w.goLive();
    const y = w.goLive(undefined, 'Promote build 43');
    const forX = await w.assertOptions(ada.headers, x.id, 'approve');
    const signed = authn.assert(forX.options as AssertOptions);
    expect(await w.verify(x.id, 'reject', signed)).toMatchObject({
      ok: false,
      reason: 'challenge_binding_mismatch',
    });
    // The failed attempt consumed the challenge: it cannot be retried for the right option either.
    expect(await w.verify(x.id, 'approve', signed)).toMatchObject({ ok: false, reason: 'challenge_used' });

    const forX2 = await w.assertOptions(ada.headers, x.id, 'approve');
    await expect(
      decisions.resolve(
        y.id,
        { optionId: 'approve', passkeyAssertion: authn.assert(forX2.options as AssertOptions) },
        ada.user,
      ),
    ).rejects.toThrow(/passkey/);
    const forX3 = await w.assertOptions(ada.headers, x.id, 'approve');
    await expect(
      decisions.resolve(
        x.id,
        { optionId: 'reject', passkeyAssertion: authn.assert(forX3.options as AssertOptions) },
        ada.user,
      ),
    ).rejects.toThrow(/passkey/);
    expect([decisions.get(x.id)!.status, decisions.get(y.id)!.status]).toEqual(['open', 'open']);
    expect(t.rt.store.list({ types: ['passkey.asserted', 'decision.resolved'] })).toEqual([]);
    await t.close();
  });

  it('refuses replayed, expired, never-issued and malformed assertions', async () => {
    const w = await world();
    const { t, decisions, ada, authn } = w;
    const card = w.goLive();
    const opts = await w.assertOptions(ada.headers, card.id, 'approve');
    const signed = authn.assert(opts.options as AssertOptions);
    expect(await w.verify(card.id, 'approve', signed)).toEqual({
      ok: true,
      credentialIdHash: sha256hex(authn.id),
      counter: 1,
    });
    expect(await w.verify(card.id, 'approve', signed)).toEqual({
      ok: false,
      reason: 'challenge_used',
      message: PASSKEY_FAILURE_MESSAGE.challenge_used,
    });

    const late = await w.assertOptions(ada.headers, card.id, 'approve');
    t.clock.advance(5 * 60_000);
    expect(await w.verify(card.id, 'approve', authn.assert(late.options as AssertOptions))).toMatchObject({
      ok: false,
      reason: 'challenge_expired',
    });
    expect(
      await w.verify(card.id, 'approve', authn.assert({ challenge: randomBytes(32).toString('base64url') })),
    ).toMatchObject({ ok: false, reason: 'challenge_unknown' });
    expect(await w.verify(card.id, 'approve', { id: 'nope' })).toMatchObject({
      ok: false,
      reason: 'malformed_assertion',
    });
    await expect(decisions.resolve(card.id, { optionId: 'approve' }, ada.user)).rejects.toThrow(/passkey/);
    expect(t.rt.store.list({ types: ['passkey.asserted'] })).toHaveLength(1);
    await t.close();
  });

  it('refuses a signature counter that does not increase and alerts approvers', async () => {
    const w = await world();
    const { t, ada, authn } = w;
    const seen: BroadcastMessage[] = [];
    t.rt.broadcaster.subscribe({ role: 'approver', send: (m) => seen.push(m) });
    const card = w.goLive();
    authn.counter = 41;
    expect(
      await w.verify(
        card.id,
        'approve',
        authn.assert((await w.assertOptions(ada.headers, card.id, 'approve')).options as AssertOptions),
      ),
    ).toMatchObject({ ok: true, counter: 42 });
    for (const counter of [42, 7, 0]) {
      const opts = await w.assertOptions(ada.headers, card.id, 'approve');
      expect(
        await w.verify(card.id, 'approve', authn.assert(opts.options as AssertOptions, { counter })),
      ).toMatchObject({ ok: false, reason: 'counter_regression' });
    }
    // A stale counter without a valid signature is just an invalid assertion: no clone alarm.
    const unsigned = authn.assert(
      (await w.assertOptions(ada.headers, card.id, 'approve')).options as AssertOptions,
      { counter: 3 },
    );
    unsigned.response.signature = Buffer.alloc(70, 1).toString('base64url');
    expect(await w.verify(card.id, 'approve', unsigned)).toMatchObject({
      ok: false,
      reason: 'assertion_invalid',
    });
    const alerts = seen.filter(
      (m): m is Extract<BroadcastMessage, { event: 'notification' }> => m.event === 'notification',
    );
    expect(alerts.map((m) => [m.data.severity, m.data.refs?.userId])).toEqual([
      ['danger', ada.user.id],
      ['danger', ada.user.id],
      ['danger', ada.user.id],
    ]);
    expect(
      await w.verify(
        card.id,
        'approve',
        authn.assert((await w.assertOptions(ada.headers, card.id, 'approve')).options as AssertOptions),
      ),
    ).toMatchObject({ ok: true, counter: 43 });
    expect(t.rt.store.list({ types: ['passkey.counter_updated'] }).map((e) => e.meta.counter)).toEqual([
      42, 43,
    ]);
    await t.close();
  });

  it('users without a registered passkey cannot approve passkey-gated kinds, with a reason the API surfaces', async () => {
    const w = await world();
    const { t, h, decisions } = w;
    const cy = h.user('approver', 'Cy');
    const card = w.goLive();
    const res = await t.json<ErrorBody>('POST', '/api/passkeys/assert/options', {
      headers: cy.headers,
      body: { decisionId: card.id, optionId: 'approve' },
      expect: 409,
    });
    expect(res.error).toEqual({
      code: 'passkey_not_registered',
      message: PASSKEY_FAILURE_MESSAGE.passkey_not_registered,
    });
    // Even holding Ada's perfectly valid assertion.
    const stolen = w.authn.assert(
      (await w.assertOptions(w.ada.headers, card.id, 'approve')).options as AssertOptions,
    );
    expect(await w.verify(card.id, 'approve', stolen, cy.user.id)).toEqual({
      ok: false,
      reason: 'passkey_not_registered',
      message: PASSKEY_FAILURE_MESSAGE.passkey_not_registered,
    });
    await expect(
      decisions.resolve(card.id, { optionId: 'approve', passkeyAssertion: stolen }, cy.user),
    ).rejects.toThrow(/passkey/);
    expect((await t.json<AuthMeDto>('GET', '/api/auth/me', { headers: cy.headers })).hasPasskey).toBe(false);
    await t.close();
  });

  it('issues no challenge to the requester, the wrong role, or for unknown, closed or malformed targets', async () => {
    const w = await world();
    const { t, h, ada, bo, decisions, authn } = w;
    const ask = (headers: Record<string, string>, body: unknown, expect: number) =>
      t.json<ErrorBody>('POST', '/api/passkeys/assert/options', { headers, body, expect });
    const own = w.goLive(ada.user.id);
    expect((await ask(ada.headers, { decisionId: own.id, optionId: 'approve' }, 403)).error).toMatchObject({
      code: 'separation_of_duties',
    });
    const card = w.goLive();
    expect((await ask(bo.headers, { decisionId: card.id, optionId: 'approve' }, 403)).error).toMatchObject({
      code: 'separation_of_duties',
    });
    const dee = h.user('builder', 'Dee');
    expect((await ask(dee.headers, { decisionId: card.id, optionId: 'approve' }, 403)).error).toMatchObject({
      code: 'cannot_resolve',
      details: { reason: 'role' },
    });
    expect((await ask(ada.headers, { decisionId: 'dec_NOPE', optionId: 'approve' }, 404)).error.code).toBe(
      'decision_not_found',
    );
    expect((await ask(ada.headers, { decisionId: card.id, optionId: 'maybe' }, 422)).error.code).toBe(
      'unknown_option',
    );
    expect(
      (await ask(ada.headers, { decisionId: card.id, optionId: 'approve', userId: bo.user.id }, 422)).error
        .code,
    ).toBe('invalid');
    expect(
      (
        await t.request('POST', '/api/passkeys/assert/options', {
          body: { decisionId: card.id, optionId: 'approve' },
        })
      ).status,
    ).toBe(401);
    const opts = await w.assertOptions(ada.headers, card.id, 'approve');
    await decisions.resolve(
      card.id,
      { optionId: 'approve', passkeyAssertion: authn.assert(opts.options as AssertOptions) },
      ada.user,
    );
    expect((await ask(ada.headers, { decisionId: card.id, optionId: 'approve' }, 409)).error.code).toBe(
      'decision_not_open',
    );
    await t.close();
  });

  it("accepts only a user-verified signature by the user's own credential, from our origin and RP, over an unchanged card", async () => {
    const w = await world();
    const { t, h, ada, authn, decisions } = w;
    const eve = h.user('approver', 'Eve');
    const eveAuthn = new SoftAuthenticator();
    await registerPasskey(t, eve.headers, eveAuthn);
    const card = w.goLive();
    const attempt = async (sign: (o: AssertOptions) => unknown, userId = ada.user.id) => {
      const { options } = await w.assertOptions(ada.headers, card.id, 'approve');
      return (await w.verify(card.id, 'approve', sign(options as AssertOptions), userId)) as {
        ok: boolean;
        reason?: string;
      };
    };
    expect((await attempt((o) => eveAuthn.assert(o))).reason).toBe('credential_unknown');
    expect(
      (
        await attempt((o) =>
          authn.assert(o, { userHandle: webauthnUserHandle(eve.user.id).toString('base64url') }),
        )
      ).reason,
    ).toBe('user_handle_mismatch');
    expect((await attempt((o) => authn.assert(o, { origin: 'https://evil.example' }))).reason).toBe(
      'assertion_invalid',
    );
    expect((await attempt((o) => authn.assert(o, { rpId: 'evil.example' }))).reason).toBe(
      'assertion_invalid',
    );
    expect((await attempt((o) => authn.assert(o, { flags: FLAG_UP }))).reason).toBe('assertion_invalid');
    const tampered = (o: AssertOptions) => {
      const a = authn.assert(o);
      const sig = Buffer.from(a.response.signature, 'base64url');
      sig[sig.length - 1]! ^= 0x01;
      return { ...a, response: { ...a.response, signature: sig.toString('base64url') } };
    };
    expect((await attempt(tampered)).reason).toBe('assertion_invalid');
    expect((await attempt((o) => authn.assert(o), eve.user.id)).reason).toBe('challenge_user_mismatch');

    const { options } = await w.assertOptions(ada.headers, card.id, 'approve');
    decisions.cards.set(card.id, { ...card, question: 'Promote release 42 and drop the users table?' });
    expect(
      (await w.verify(card.id, 'approve', authn.assert(options as AssertOptions))) as { reason?: string },
    ).toMatchObject({ reason: 'decision_changed' });
    expect(t.rt.store.list({ types: ['passkey.asserted'] })).toEqual([]);
    await t.close();
  });
});

describe('challenge store bounds', () => {
  it("caps outstanding challenges per user, so one account cannot evict another's", async () => {
    const w = await world();
    const { t, h, ada, authn } = w;
    const eve = h.user('approver', 'Eve');
    const eveAuthn = new SoftAuthenticator();
    await registerPasskey(t, eve.headers, eveAuthn);
    const card = w.goLive();
    const evePending = await w.assertOptions(eve.headers, card.id, 'approve');
    const adaFirst = await w.assertOptions(ada.headers, card.id, 'approve');
    for (let i = 0; i < 20; i++) await w.assertOptions(ada.headers, card.id, 'approve');
    expect(await w.verify(card.id, 'approve', authn.assert(adaFirst.options as AssertOptions))).toMatchObject(
      { ok: false, reason: 'challenge_unknown' },
    );
    expect(
      await w.verify(card.id, 'approve', eveAuthn.assert(evePending.options as AssertOptions), eve.user.id),
    ).toMatchObject({ ok: true });
    await t.close();
  });
});

describe('passkey lifecycle', () => {
  it('owners (or users.manage) remove passkeys; a removed or erased passkey cannot sign', async () => {
    const w = await world();
    const { t, h, ada, authn } = w;
    const dee = h.user('builder', 'Dee');
    const [pk] = (await t.json<{ passkeys: PasskeyDto[] }>('GET', '/api/passkeys', { headers: ada.headers }))
      .passkeys;
    await t.json('DELETE', `/api/passkeys/${pk!.id}`, { headers: dee.headers, expect: 404 });
    await t.json('GET', `/api/passkeys?userId=${ada.user.id}`, { headers: dee.headers, expect: 403 });

    const card = w.goLive();
    const pending = await w.assertOptions(ada.headers, card.id, 'approve');
    await t.json('DELETE', `/api/passkeys/${pk!.id}`, { headers: ada.headers });
    expect(await w.verify(card.id, 'approve', authn.assert(pending.options as AssertOptions))).toMatchObject({
      ok: false,
      reason: 'passkey_not_registered',
    });
    expect(
      (await t.json<{ passkeys: PasskeyDto[] }>('GET', '/api/passkeys', { headers: ada.headers })).passkeys,
    ).toEqual([]);

    await registerPasskey(t, ada.headers, authn);
    const admin = h.user('approver', 'Admin');
    expect(
      (
        await t.json<{ passkeys: PasskeyDto[] }>('GET', `/api/passkeys?userId=${ada.user.id}`, {
          headers: admin.headers,
        })
      ).passkeys,
    ).toHaveLength(1);
    t.rt.store.eraseScope(userBodyScope(ada.user.id), {
      actor: { kind: 'human', id: admin.user.id },
      reason: 'pdpa_request',
    });
    expect(w.service.passkeys.hasPasskey(ada.user.id)).toBe(false);
    await t.json('POST', '/api/passkeys/assert/options', {
      headers: ada.headers,
      body: { decisionId: card.id, optionId: 'approve' },
      expect: 409,
    });
    t.rt.store.rebuildProjections(['identity']);
    expect(w.service.passkeys.hasPasskey(ada.user.id)).toBe(false);

    await t.json('DELETE', `/api/passkeys/${pk!.id}`, { headers: admin.headers });
    await t.json('DELETE', `/api/passkeys/${pk!.id}`, { headers: admin.headers, expect: 404 });
    expect(t.rt.store.list({ types: ['passkey.removed'] }).map((e) => e.actor.id)).toEqual([
      ada.user.id,
      admin.user.id,
    ]);
    await t.close();
  });
});
