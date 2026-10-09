/**
 * Identity events (owner: mod-identity, §6). Token plaintext never appears anywhere: meta carries only a
 * sha256 and a short non-secret lookup prefix. Free text (names, emails, labels) and key material go in
 * the encrypted payload under the per-person body scope `user:<userId>`, so erasing that scope
 * crypto-shreds a person's identity data while the chain stays valid.
 */
import { z } from 'zod';
import { ROLES } from '../domain';
import { defineEvent, meta, payload, zHash, zId, zIso, zLabel } from './define';

export const IDENTITY_TOKEN_KINDS = ['user', 'web_session', 'ingest_session', 'observer', 'system'] as const;
/** Kind prefix + the first 8 chars of the random body. Displayed to identify a token; ~200 secret bits remain. */
export const zIdentityTokenPrefix = z.string().regex(/^aoc_[uwios]_[0-9A-Za-z]{8}$/, 'token prefix');

export const IDENTITY_EVENTS = [
  defineEvent({
    type: 'user.created',
    owner: 'identity',
    description: 'A person was given an identity and a role.',
    meta: meta({ userId: zId, role: z.enum(ROLES), complianceLead: z.boolean() }),
    payload: payload({ name: z.string(), email: z.string().optional() }),
  }),
  defineEvent({
    type: 'user.updated',
    owner: 'identity',
    description: 'Role / active flag / profile changed.',
    meta: meta({
      userId: zId,
      role: z.enum(ROLES).nullable(),
      active: z.boolean().nullable(),
      complianceLead: z.boolean().nullable(),
    }),
    /** email: null clears it; an absent key leaves it unchanged. */
    payload: payload({ name: z.string().optional(), email: z.string().nullable().optional() }),
  }),
  defineEvent({
    type: 'token.issued',
    owner: 'identity',
    description:
      'Bearer token issued (v1 bearer = attribution, not signed approval). Only its sha256 and lookup prefix are stored; web_session = console cookie session opened with the user token parentTokenId.',
    meta: meta({
      tokenId: zId,
      userId: zId.nullable(),
      kind: z.enum(IDENTITY_TOKEN_KINDS),
      sessionId: zId.nullable(),
      parentTokenId: zId.nullable(),
      expiresAt: zIso.nullable(),
      tokenHash: zHash,
      tokenPrefix: zIdentityTokenPrefix,
    }),
    payload: payload({ label: z.string().optional() }),
  }),
  defineEvent({
    type: 'token.revoked',
    owner: 'identity',
    description: 'Token revoked (logout, session end, admin action, user deactivated, parent token revoked).',
    meta: meta({ tokenId: zId, reason: zLabel }),
    payload: null,
  }),
  defineEvent({
    type: 'passkey.registered',
    owner: 'identity',
    description:
      'WebAuthn passkey registered (per-decision passkey for go-live / rollback / break-glass). viaTokenId = the bearer/cookie credential that authenticated the ceremony.',
    meta: meta({ userId: zId, credentialIdHash: zHash, viaTokenId: zId }),
    payload: payload({
      credential: z.object({
        id: z.string(),
        publicKey: z.string(),
        counter: z.number(),
        transports: z.array(z.string()).optional(),
      }),
      label: z.string().optional(),
      aaguid: z.string().optional(),
      deviceType: z.enum(['singleDevice', 'multiDevice']).optional(),
      backedUp: z.boolean().optional(),
    }),
  }),
  defineEvent({
    type: 'passkey.removed',
    owner: 'identity',
    description: 'Passkey removed.',
    meta: meta({ userId: zId, credentialIdHash: zHash }),
    payload: null,
  }),
  defineEvent({
    type: 'passkey.counter_updated',
    owner: 'identity',
    description: 'Authenticator signature counter advanced after a verified assertion.',
    meta: meta({
      userId: zId,
      credentialIdHash: zHash,
      counter: z.number().int().min(0),
      decisionId: zId.nullable(),
    }),
    payload: null,
  }),
  defineEvent({
    type: 'passkey.asserted',
    owner: 'identity',
    description:
      'Verified per-decision passkey assertion. The signed WebAuthn challenge is sha256 of the binding (user, decision, option, card hash, nonce, expiry), so the payload is independently re-verifiable signed-approval evidence.',
    meta: meta({
      userId: zId,
      credentialIdHash: zHash,
      decisionId: zId,
      optionId: zId,
      cardHash: zHash,
      challengeHash: zHash,
      counter: z.number().int().min(0),
      userVerified: z.boolean(),
    }),
    payload: payload({
      credentialId: z.string(),
      clientDataJSON: z.string(),
      authenticatorData: z.string(),
      signature: z.string(),
      userHandle: z.string().optional(),
      binding: z.object({
        v: z.literal(1),
        rpId: z.string(),
        userId: z.string(),
        decisionId: z.string(),
        optionId: z.string(),
        cardHash: z.string(),
        nonce: z.string(),
        expiresAt: z.string(),
      }),
    }),
  }),
] as const;
