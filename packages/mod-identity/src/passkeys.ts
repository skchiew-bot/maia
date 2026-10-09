import { createHash, randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { z } from 'zod';
import {
  PASSKEY_FAILURE_MESSAGE,
  type DecisionCard,
  type PasskeyAssertOptionsResponse,
  type PasskeyDto,
  type PasskeyFailureReason,
  type PasskeyOptionsResponse,
  type PasskeyVerificationResult,
  type User,
} from '@aoc/contracts';
import { canonicalJson, HttpError, sha256hex, type ModuleContext, type NewEvent } from '@aoc/kernel';
import type { PasskeyRow } from './projector';
import { assertNotRequester } from './sod';

export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_PASSKEYS_PER_USER = 10;
/** ES256, EdDSA, RS256. */
const SUPPORTED_ALGS = [-7, -8, -257];
const TRANSPORTS: readonly string[] = ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'];

/** Body-store scope for a person's identity data: erasing it crypto-shreds names, emails, labels and passkey keys. */
export const userBodyScope = (userId: string): string => `user:${userId}`;

/** What a decision passkey signature commits to: the WebAuthn challenge is sha256(canonicalJson(binding)). */
export interface DecisionBinding {
  v: 1;
  rpId: string;
  userId: string;
  decisionId: string;
  optionId: string;
  cardHash: string;
  nonce: string;
  expiresAt: string;
}

/** sha256 over what the approver is shown: decision id, kind, title, question and options. */
export function decisionCardHash(
  card: Pick<DecisionCard, 'id' | 'kind' | 'title' | 'question' | 'options'>,
): string {
  return sha256hex(
    canonicalJson({
      decisionId: card.id,
      kind: card.kind,
      title: card.title,
      question: card.question,
      options: card.options.map((o) => ({ id: o.id, label: o.label, description: o.description ?? null })),
    }),
  );
}

/** Raw 32-byte WebAuthn challenge for a binding (also used to re-verify recorded evidence offline). */
export function decisionChallenge(binding: DecisionBinding): Buffer {
  return createHash('sha256').update(canonicalJson(binding)).digest();
}

/** Opaque, stable WebAuthn user handle (no personal data reaches the authenticator through it). */
export function webauthnUserHandle(userId: string): Buffer {
  return createHash('sha256').update(`aoc:webauthn-user:${userId}`).digest();
}

interface ChallengeRecord {
  purpose: 'register' | 'assert';
  userId: string;
  expiresAt: number;
  usedAt: number | null;
  binding: DecisionBinding | null;
}

/** Single-use challenges, in memory: aocd is one process, and a restart just voids pending ceremonies. */
class ChallengeStore {
  private readonly records = new Map<string, ChallengeRecord>();

  constructor(
    private readonly now: () => number,
    private readonly max = 5_000,
    /** Per-user bound, so one account flooding option requests cannot evict other people's challenges. */
    private readonly perUser = 20,
  ) {}

  put(challenge: string, rec: ChallengeRecord): void {
    this.sweep();
    const own = [...this.records].filter(([, r]) => r.userId === rec.userId);
    if (own.length >= this.perUser) this.records.delete(own[0]![0]);
    while (this.records.size >= this.max) this.records.delete(this.records.keys().next().value!);
    this.records.set(challenge, rec);
  }

  get(challenge: string): ChallengeRecord | null {
    this.sweep();
    return this.records.get(challenge) ?? null;
  }

  // Used/expired records linger one extra TTL so replays are reported precisely, then they go.
  private sweep(): void {
    const cutoff = this.now() - PASSKEY_CHALLENGE_TTL_MS;
    for (const [k, r] of this.records) if (r.expiresAt < cutoff) this.records.delete(k);
  }
}

const zB64u = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+={0,2}$/, 'base64url');
const zAttachment = z.enum(['platform', 'cross-platform']).nullable().optional();

const AssertionSchema = z.object({
  id: zB64u,
  rawId: zB64u,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: zB64u,
    authenticatorData: zB64u,
    signature: zB64u,
    userHandle: zB64u.nullable().optional(),
  }),
  clientExtensionResults: z.record(z.unknown()).default({}),
  authenticatorAttachment: zAttachment,
});

const RegistrationSchema = z.object({
  id: zB64u,
  rawId: zB64u,
  type: z.literal('public-key'),
  response: z.object({
    clientDataJSON: zB64u,
    attestationObject: z
      .string()
      .min(1)
      .max(65_536)
      .regex(/^[A-Za-z0-9_-]+={0,2}$/, 'base64url'),
    transports: z.array(z.string().max(32)).max(10).optional(),
  }),
  clientExtensionResults: z.record(z.unknown()).default({}),
  authenticatorAttachment: zAttachment,
});

function clientChallenge(clientDataJSON: string): string | null {
  try {
    const cd = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as {
      challenge?: unknown;
    } | null;
    const ch = cd?.challenge;
    return typeof ch === 'string' && ch.length > 0 && ch.length <= 128 ? ch : null;
  } catch {
    return null;
  }
}

function knownTransports(list: readonly string[] | undefined): AuthenticatorTransportFuture[] {
  return (list ?? []).filter((t): t is AuthenticatorTransportFuture => TRANSPORTS.includes(t));
}

interface UsableCredential {
  /** credentialIdHash */
  id: string;
  credentialId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  transports: AuthenticatorTransportFuture[];
}

export interface PasskeyUserLookup {
  getUser(id: string): User | null;
}

/** WebAuthn registration and per-decision assertions (§6, §8). */
export class PasskeyService {
  private readonly challenges: ChallengeStore;

  constructor(
    private readonly ctx: ModuleContext,
    private readonly users: PasskeyUserLookup,
  ) {
    this.challenges = new ChallengeStore(() => ctx.clock.now());
  }

  private get rp() {
    return this.ctx.config.identity;
  }

  private row(id: string): PasskeyRow | null {
    return (
      (this.ctx.db.prepare('SELECT * FROM idn_passkeys WHERE id = ?').get(id) as PasskeyRow | undefined) ??
      null
    );
  }

  list(userId: string): PasskeyDto[] {
    const rows = this.ctx.db
      .prepare('SELECT * FROM idn_passkeys WHERE user_id = ? AND removed_at IS NULL ORDER BY created_at, id')
      .all(userId) as unknown as PasskeyRow[];
    return rows.map(toPasskeyDto);
  }

  private usable(userId: string): UsableCredential[] {
    const rows = this.ctx.db
      .prepare(
        'SELECT * FROM idn_passkeys WHERE user_id = ? AND removed_at IS NULL AND public_key IS NOT NULL AND credential_id IS NOT NULL ORDER BY created_at, id',
      )
      .all(userId) as unknown as PasskeyRow[];
    return rows.map((r) => ({
      id: r.id,
      credentialId: r.credential_id!,
      publicKey: new Uint8Array(Buffer.from(r.public_key!, 'base64url')),
      transports: knownTransports(r.transports ? (JSON.parse(r.transports) as string[]) : []),
    }));
  }

  hasPasskey(userId: string): boolean {
    return this.usable(userId).length > 0;
  }

  async registrationOptions(user: User): Promise<PasskeyOptionsResponse> {
    const existing = this.usable(user.id);
    if (existing.length >= MAX_PASSKEYS_PER_USER)
      throw new HttpError(409, 'passkey_limit', `At most ${MAX_PASSKEYS_PER_USER} passkeys per user`);
    const expiresAt = this.ctx.clock.now() + PASSKEY_CHALLENGE_TTL_MS;
    const options = await generateRegistrationOptions({
      rpName: this.rp.rpName,
      rpID: this.rp.rpId,
      userName: user.email ?? user.name,
      userDisplayName: user.name,
      userID: new Uint8Array(webauthnUserHandle(user.id)),
      timeout: PASSKEY_CHALLENGE_TTL_MS,
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      supportedAlgorithmIDs: SUPPORTED_ALGS,
    });
    this.challenges.put(options.challenge, {
      purpose: 'register',
      userId: user.id,
      expiresAt,
      usedAt: null,
      binding: null,
    });
    return {
      options: options as unknown as Record<string, unknown>,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async verifyRegistration(
    user: User,
    viaTokenId: string,
    response: unknown,
    label?: string,
  ): Promise<PasskeyDto> {
    const parsed = RegistrationSchema.safeParse(response);
    if (!parsed.success)
      throw new HttpError(422, 'invalid_registration', 'Malformed WebAuthn registration response');
    const challenge = clientChallenge(parsed.data.response.clientDataJSON);
    const rec = challenge ? this.challenges.get(challenge) : null;
    if (!challenge || !rec || rec.purpose !== 'register' || rec.userId !== user.id) {
      throw new HttpError(422, 'challenge_unknown', PASSKEY_FAILURE_MESSAGE.challenge_unknown);
    }
    if (rec.usedAt !== null)
      throw new HttpError(422, 'challenge_used', PASSKEY_FAILURE_MESSAGE.challenge_used);
    const now = this.ctx.clock.now();
    rec.usedAt = now;
    if (rec.expiresAt <= now)
      throw new HttpError(422, 'challenge_expired', PASSKEY_FAILURE_MESSAGE.challenge_expired);
    let info;
    try {
      const result = await verifyRegistrationResponse({
        response: parsed.data as unknown as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: this.rp.origin,
        expectedRPID: this.rp.rpId,
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: SUPPORTED_ALGS,
      });
      if (!result.verified) throw new Error('attestation not verified');
      info = result.registrationInfo;
    } catch (err) {
      this.ctx.log.warn('passkey registration rejected', { userId: user.id, err: String(err).slice(0, 200) });
      throw new HttpError(
        422,
        'passkey_registration_failed',
        'The passkey registration could not be verified (origin, RP ID, user verification or attestation)',
      );
    }
    const credentialIdHash = sha256hex(info.credential.id);
    const existing = this.row(credentialIdHash);
    if (existing && existing.removed_at === null)
      throw new HttpError(409, 'passkey_exists', 'This passkey is already registered');
    const transports = knownTransports(parsed.data.response.transports);
    const event: NewEvent<'passkey.registered'> = {
      type: 'passkey.registered',
      actor: { kind: 'human', id: user.id },
      scope: { userId: user.id },
      meta: { userId: user.id, credentialIdHash, viaTokenId },
      payload: {
        credential: {
          id: info.credential.id,
          publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
          counter: info.credential.counter,
          ...(transports.length ? { transports } : {}),
        },
        ...(label ? { label } : {}),
        aaguid: info.aaguid,
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
      },
      source: 'api',
      bodyScope: userBodyScope(user.id),
    };
    this.ctx.store.append(event);
    return toPasskeyDto(this.row(credentialIdHash)!);
  }

  remove(id: string, by: User, asAdmin: boolean): void {
    const row = this.row(id);
    if (!row || row.removed_at !== null || (row.user_id !== by.id && !asAdmin))
      throw new HttpError(404, 'passkey_not_found', 'Passkey not found');
    this.ctx.store.append({
      type: 'passkey.removed',
      actor: { kind: 'human', id: by.id },
      scope: { userId: row.user_id },
      meta: { userId: row.user_id, credentialIdHash: row.id },
      source: 'api',
    });
  }

  /** Issue a challenge bound to (user, decision, option, card content), valid 5 minutes, single use. */
  async assertionOptions(
    user: User,
    decisionId: string,
    optionId: string,
  ): Promise<PasskeyAssertOptionsResponse> {
    const decisions = this.ctx.services.maybe('decisions');
    if (!decisions) throw new HttpError(503, 'decisions_unavailable', 'Decision service unavailable');
    const card = decisions.get(decisionId);
    if (!card) throw new HttpError(404, 'decision_not_found', 'Decision not found');
    if (card.status !== 'open') throw new HttpError(409, 'decision_not_open', 'Decision is not open');
    if (!card.options.some((o) => o.id === optionId))
      throw new HttpError(422, 'unknown_option', 'Unknown option for this decision');
    assertNotRequester(card, user);
    const can = decisions.canResolve(card, user);
    if (!can.ok)
      throw new HttpError(
        403,
        'cannot_resolve',
        `You cannot resolve this decision (${can.reason ?? 'not allowed'})`,
        { reason: can.reason },
      );
    const creds = this.usable(user.id);
    if (!creds.length)
      throw new HttpError(409, 'passkey_not_registered', PASSKEY_FAILURE_MESSAGE.passkey_not_registered);
    const expiresAt = this.ctx.clock.now() + PASSKEY_CHALLENGE_TTL_MS;
    const binding: DecisionBinding = {
      v: 1,
      rpId: this.rp.rpId,
      userId: user.id,
      decisionId,
      optionId,
      cardHash: decisionCardHash(card),
      nonce: randomBytes(16).toString('base64url'),
      expiresAt: new Date(expiresAt).toISOString(),
    };
    const options = await generateAuthenticationOptions({
      rpID: this.rp.rpId,
      allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports })),
      challenge: new Uint8Array(decisionChallenge(binding)),
      timeout: PASSKEY_CHALLENGE_TTL_MS,
      userVerification: 'required',
    });
    this.challenges.put(options.challenge, {
      purpose: 'assert',
      userId: user.id,
      expiresAt,
      usedAt: null,
      binding,
    });
    return {
      options: options as unknown as Record<string, unknown>,
      expiresAt: binding.expiresAt,
      cardHash: binding.cardHash,
    };
  }

  /**
   * Verify a per-decision assertion: signature, origin, RP ID, user verification, challenge binding
   * (user, decision, option, unchanged card), single use, expiry and counter increase. On success the
   * assertion is recorded as passkey.asserted evidence (+ passkey.counter_updated when it advanced).
   */
  async verifyDecision(input: {
    userId: string;
    decisionId: string;
    optionId: string;
    assertion: unknown;
  }): Promise<PasskeyVerificationResult> {
    const fail = (reason: PasskeyFailureReason): PasskeyVerificationResult => {
      this.ctx.log.warn('passkey assertion rejected', {
        userId: input.userId,
        decisionId: input.decisionId,
        reason,
      });
      return { ok: false, reason, message: PASSKEY_FAILURE_MESSAGE[reason] };
    };
    const parsed = AssertionSchema.safeParse(input.assertion);
    if (!parsed.success) return fail('malformed_assertion');
    const assertion = parsed.data;
    const user = this.users.getUser(input.userId);
    if (!user || !user.active) return fail('user_inactive');
    const creds = this.usable(user.id);
    if (!creds.length) return fail('passkey_not_registered');
    const challenge = clientChallenge(assertion.response.clientDataJSON);
    if (!challenge) return fail('malformed_assertion');
    const rec = this.challenges.get(challenge);
    if (!rec || rec.purpose !== 'assert' || !rec.binding) return fail('challenge_unknown');
    if (rec.userId !== user.id) return fail('challenge_user_mismatch');
    if (rec.usedAt !== null) return fail('challenge_used');
    const now = this.ctx.clock.now();
    // Consumed before any await, whatever the outcome: a challenge can never be tried twice.
    rec.usedAt = now;
    if (rec.expiresAt <= now) return fail('challenge_expired');
    const binding = rec.binding;
    if (binding.decisionId !== input.decisionId || binding.optionId !== input.optionId)
      return fail('challenge_binding_mismatch');
    const card = this.ctx.services.maybe('decisions')?.get(input.decisionId) ?? null;
    if (!card || card.status !== 'open' || decisionCardHash(card) !== binding.cardHash)
      return fail('decision_changed');
    const cred = creds.find((c) => c.credentialId === assertion.id && assertion.rawId === assertion.id);
    if (!cred) return fail('credential_unknown');
    const userHandle = assertion.response.userHandle ?? undefined;
    if (userHandle && userHandle !== webauthnUserHandle(user.id).toString('base64url'))
      return fail('user_handle_mismatch');
    let verified = false;
    let userVerified = false;
    let counter = 0;
    try {
      const result = await verifyAuthenticationResponse({
        response: {
          ...assertion,
          response: { ...assertion.response, userHandle },
        } as unknown as AuthenticationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: this.rp.origin,
        expectedRPID: this.rp.rpId,
        // Counter 0 turns off the library's counter check, which runs before the signature check: the
        // counter is compared below, only for a genuinely signed assertion (the real clone signal), so an
        // unsigned replay can never raise the cloned-authenticator alarm.
        credential: {
          id: cred.credentialId,
          publicKey: cred.publicKey,
          counter: 0,
          transports: cred.transports,
        },
        requireUserVerification: true,
      });
      verified = result.verified;
      userVerified = result.authenticationInfo.userVerified;
      counter = result.authenticationInfo.newCounter;
    } catch {
      verified = false;
    }
    if (!verified || !userVerified) return fail('assertion_invalid');
    // Read after the await: a concurrent assertion may have advanced the counter meanwhile.
    const latest = this.row(cred.id);
    if (!latest || latest.removed_at !== null || latest.public_key === null)
      return fail('credential_unknown');
    if ((counter > 0 || latest.counter > 0) && counter <= latest.counter)
      return this.counterRegression(user, cred.id, fail);

    const actor = { kind: 'human' as const, id: user.id };
    const scope = { userId: user.id, decisionId: binding.decisionId };
    const events: NewEvent[] = [
      {
        type: 'passkey.asserted',
        actor,
        scope,
        meta: {
          userId: user.id,
          credentialIdHash: cred.id,
          decisionId: binding.decisionId,
          optionId: binding.optionId,
          cardHash: binding.cardHash,
          challengeHash: Buffer.from(challenge, 'base64url').toString('hex'),
          counter,
          userVerified,
        },
        payload: {
          credentialId: assertion.id,
          clientDataJSON: assertion.response.clientDataJSON,
          authenticatorData: assertion.response.authenticatorData,
          signature: assertion.response.signature,
          ...(userHandle ? { userHandle } : {}),
          binding: { ...binding },
        },
        source: 'api',
        bodyScope: userBodyScope(user.id),
      },
    ];
    if (counter > latest.counter) {
      events.push({
        type: 'passkey.counter_updated',
        actor,
        scope,
        meta: { userId: user.id, credentialIdHash: cred.id, counter, decisionId: binding.decisionId },
        source: 'api',
      });
    }
    this.ctx.store.appendMany(events);
    return { ok: true, credentialIdHash: cred.id, counter };
  }

  private counterRegression(
    user: User,
    credentialIdHash: string,
    fail: (r: PasskeyFailureReason) => PasskeyVerificationResult,
  ): PasskeyVerificationResult {
    this.ctx.notify({
      kind: 'info',
      title: 'Passkey signature counter went backwards: possible cloned authenticator',
      audience: ['approver'],
      severity: 'danger',
      refs: { userId: user.id, credentialIdHash },
    });
    return fail('counter_regression');
  }
}

function toPasskeyDto(r: PasskeyRow): PasskeyDto {
  return {
    id: r.id,
    userId: r.user_id,
    label: r.label,
    counter: r.counter,
    transports: r.transports ? (JSON.parse(r.transports) as string[]) : [],
    deviceType: r.device_type,
    backedUp: r.backed_up === null ? null : r.backed_up === 1,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}
