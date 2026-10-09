/** Identity events (owner: mod-identity, §6). */
import { z } from 'zod';
import { ROLES } from '../domain';
import { defineEvent, meta, payload, zId, zIso, zLabel } from './define';

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
    meta: meta({ userId: zId, role: z.enum(ROLES).nullable(), active: z.boolean().nullable(), complianceLead: z.boolean().nullable() }),
    payload: payload({ name: z.string().optional(), email: z.string().optional() }),
  }),
  defineEvent({
    type: 'token.issued',
    owner: 'identity',
    description: 'Bearer token issued (v1 bearer = attribution, not signed approval). Only a hash is stored.',
    meta: meta({ tokenId: zId, userId: zId.nullable(), kind: z.enum(['user', 'ingest_session', 'observer', 'system']), sessionId: zId.nullable(), expiresAt: zIso.nullable(), tokenHash: z.string() }),
    payload: payload({ label: z.string().optional() }),
  }),
  defineEvent({
    type: 'token.revoked',
    owner: 'identity',
    description: 'Token revoked.',
    meta: meta({ tokenId: zId, reason: zLabel }),
    payload: null,
  }),
  defineEvent({
    type: 'passkey.registered',
    owner: 'identity',
    description: 'WebAuthn passkey registered (per-decision passkey for go-live / rollback / break-glass).',
    meta: meta({ userId: zId, credentialIdHash: z.string() }),
    payload: payload({ credential: z.object({ id: z.string(), publicKey: z.string(), counter: z.number(), transports: z.array(z.string()).optional() }), label: z.string().optional() }),
  }),
  defineEvent({
    type: 'passkey.removed',
    owner: 'identity',
    description: 'Passkey removed.',
    meta: meta({ userId: zId, credentialIdHash: z.string() }),
    payload: null,
  }),
  defineEvent({
    type: 'passkey.counter_updated',
    owner: 'identity',
    description: 'Authenticator signature counter advanced after a verified assertion.',
    meta: meta({ userId: zId, credentialIdHash: z.string(), counter: z.number().int().min(0), decisionId: zId.nullable() }),
    payload: null,
  }),
] as const;
