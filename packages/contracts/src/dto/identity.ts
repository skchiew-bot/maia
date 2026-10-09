/** Read models / DTOs for mod-identity (§6). Token plaintext appears only in IssuedTokenDto, exactly once. */
import { z } from 'zod';
import { ROLES, type Role } from '../domain';
import { IDENTITY_TOKEN_KINDS } from '../events/identity';
import type { Permission } from '../roles';

export type IdentityTokenKind = (typeof IDENTITY_TOKEN_KINDS)[number];
export const IDENTITY_TOKEN_PREFIX: Record<IdentityTokenKind, string> = {
  user: 'aoc_u_',
  web_session: 'aoc_w_',
  ingest_session: 'aoc_i_',
  ingest_sidecar: 'aoc_c_',
  observer: 'aoc_o_',
  system: 'aoc_s_',
};

/** Shown on login: what a v1 bearer credential does and does not prove (§6). */
export const BEARER_ATTRIBUTION_NOTE =
  'v1 bearer tokens prove which token was used, not who used it (attribution only). Go-live, rollback and break-glass need a per-decision passkey assertion: the path to signed approval.';

export interface IdentityUserDto {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  flags: { complianceLead: boolean };
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuthMeDto {
  user: IdentityUserDto;
  permissions: Permission[];
  method: 'bearer' | 'cookie';
  tokenId: string;
  /** False → the user cannot approve passkey-gated decisions until they register one. */
  hasPasskey: boolean;
}

export interface AuthLoginResponse extends AuthMeDto {
  /** Cookie session expiry (never later than the user token it was opened with). */
  expiresAt: string;
  attribution: { level: 'bearer_attribution'; note: string };
}

export interface IdentityTokenDto {
  tokenId: string;
  kind: IdentityTokenKind;
  /** Non-secret identifying prefix, e.g. "aoc_u_7fK2mQ9a". */
  prefix: string;
  userId: string | null;
  sessionId: string | null;
  parentTokenId: string | null;
  label: string | null;
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  status: 'active' | 'expired' | 'revoked';
}

/** The only response that ever carries a token's plaintext. */
export interface IssuedTokenDto {
  token: string;
  tokenId: string;
  kind: IdentityTokenKind;
  prefix: string;
  expiresAt: string | null;
  note: string;
}

export interface PasskeyDto {
  /** sha256 of the credential id (hex). */
  id: string;
  userId: string;
  label: string | null;
  counter: number;
  transports: string[];
  deviceType: 'singleDevice' | 'multiDevice' | null;
  backedUp: boolean | null;
  createdAt: string;
  lastUsedAt: string | null;
}

/** PublicKeyCredential{Creation,Request}OptionsJSON — passed verbatim to @simplewebauthn/browser. */
export interface PasskeyOptionsResponse {
  options: Record<string, unknown>;
  expiresAt: string;
}
export interface PasskeyAssertOptionsResponse extends PasskeyOptionsResponse {
  /** sha256 of the card's decision id, kind, title, question and options: what the signature commits to. */
  cardHash: string;
}

export const PASSKEY_FAILURE_REASONS = [
  'malformed_assertion',
  'user_inactive',
  'passkey_not_registered',
  'challenge_unknown',
  'challenge_used',
  'challenge_expired',
  'challenge_user_mismatch',
  'challenge_binding_mismatch',
  'decision_changed',
  'credential_unknown',
  'user_handle_mismatch',
  'counter_regression',
  'assertion_invalid',
] as const;
export type PasskeyFailureReason = (typeof PASSKEY_FAILURE_REASONS)[number];
export const PASSKEY_FAILURE_MESSAGE: Record<PasskeyFailureReason, string> = {
  malformed_assertion: 'The passkey response is not a valid WebAuthn assertion.',
  user_inactive: 'This account is not active.',
  passkey_not_registered: 'Register a passkey before approving go-live, rollback or break-glass decisions.',
  challenge_unknown: 'No passkey challenge was issued for this assertion. Request a new one.',
  challenge_used: 'This passkey challenge was already used. Request a new one.',
  challenge_expired: 'The passkey challenge expired (5 minutes). Request a new one.',
  challenge_user_mismatch: 'The passkey challenge was issued to a different user.',
  challenge_binding_mismatch: 'The passkey challenge was issued for a different decision or option.',
  decision_changed:
    'The decision changed or closed after the challenge was issued. Review it and sign again.',
  credential_unknown: 'The passkey is not registered to this user.',
  user_handle_mismatch: 'The passkey belongs to a different account.',
  counter_regression: 'The authenticator signature counter went backwards (possible cloned authenticator).',
  assertion_invalid: 'The passkey signature, origin, RP ID or user verification check failed.',
};
export type PasskeyVerificationResult =
  | { ok: true; credentialIdHash: string; counter: number }
  | { ok: false; reason: PasskeyFailureReason; message: string };

// ── request schemas ─────────────────────────────────────────────────────────
const zName = z.string().trim().min(1).max(120);
const zEmail = z.string().trim().toLowerCase().email().max(254);
const zLabelText = z.string().trim().min(1).max(80);

export const AuthLoginRequestSchema = z.object({ token: z.string().min(1).max(512) }).strict();
export type AuthLoginRequest = z.infer<typeof AuthLoginRequestSchema>;

export const IdentityCreateUserSchema = z
  .object({
    name: zName,
    email: zEmail.nullable().optional(),
    role: z.enum(ROLES),
    flags: z.object({ complianceLead: z.boolean().optional() }).strict().optional(),
  })
  .strict();
export type IdentityCreateUserRequest = z.infer<typeof IdentityCreateUserSchema>;

export const IdentityUpdateUserSchema = z
  .object({
    name: zName.optional(),
    email: zEmail.nullable().optional(),
    role: z.enum(ROLES).optional(),
    active: z.boolean().optional(),
    flags: z.object({ complianceLead: z.boolean().optional() }).strict().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'no changes');
export type IdentityUpdateUserRequest = z.infer<typeof IdentityUpdateUserSchema>;

export const IdentityIssueTokenSchema = z
  .object({ label: zLabelText.optional(), expiresInDays: z.number().int().min(1).max(3650).optional() })
  .strict();
export type IdentityIssueTokenRequest = z.infer<typeof IdentityIssueTokenSchema>;

export const PasskeyRegisterVerifySchema = z
  .object({ response: z.record(z.unknown()), label: zLabelText.optional() })
  .strict();
export type PasskeyRegisterVerifyRequest = z.infer<typeof PasskeyRegisterVerifySchema>;

export const PasskeyAssertOptionsSchema = z
  .object({ decisionId: z.string().min(1).max(64), optionId: z.string().min(1).max(64) })
  .strict();
export type PasskeyAssertOptionsRequest = z.infer<typeof PasskeyAssertOptionsSchema>;
