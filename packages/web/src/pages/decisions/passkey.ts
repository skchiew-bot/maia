import {
  WebAuthnError,
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type {
  DecisionCardView,
  PasskeyAssertOptionsResponse,
  PasskeyDto,
  PasskeyOptionsResponse,
} from '@aoc/contracts';
import { ApiError, apiPost } from '../../api/client';
import { describeError } from '../../components/EmptyState';

/** WebAuthn needs a secure context (https, or http://localhost) and browser support. */
export function passkeysAvailable(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext !== false && browserSupportsWebAuthn();
}

/** Registers a passkey on this device for the signed-in user (mod-identity `/api/passkeys/register/*`). */
export async function registerPasskey(label?: string): Promise<PasskeyDto> {
  const { options } = await apiPost<PasskeyOptionsResponse>('/api/passkeys/register/options');
  const response = await startRegistration({
    optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
  });
  const { passkey } = await apiPost<{ passkey: PasskeyDto }>('/api/passkeys/register/verify', {
    response,
    ...(label ? { label } : {}),
  });
  return passkey;
}

export interface SignedResolution {
  card: DecisionCardView;
  /** sha256 of the decision id, kind, title, question and options: what the signature committed to. */
  cardHash: string;
}

/**
 * Resolves a passkey-gated decision (go-live, rollback, break-glass): the server issues a single-use challenge
 * bound to this user, decision, option and card content; the authenticator signs it; the resolve call carries
 * the assertion, which the server verifies before recording `decision.resolved` with method `passkey`.
 */
export async function resolveWithPasskey(
  decisionId: string,
  optionId: string,
  comment: string | null,
): Promise<SignedResolution> {
  const challenge = await apiPost<PasskeyAssertOptionsResponse>('/api/passkeys/assert/options', {
    decisionId,
    optionId,
  });
  const assertion = await startAuthentication({
    optionsJSON: challenge.options as unknown as PublicKeyCredentialRequestOptionsJSON,
  });
  const card = await apiPost<DecisionCardView>(`/api/decisions/${encodeURIComponent(decisionId)}/resolve`, {
    optionId,
    comment,
    passkeyAssertion: assertion,
  });
  return { card, cardHash: challenge.cardHash };
}

export interface PasskeyProblem {
  title: string;
  body: string;
  /** The user has no passkey yet: offer registration. */
  needsRegistration: boolean;
}

function isCancelled(err: unknown): boolean {
  if (err instanceof WebAuthnError) return err.code === 'ERROR_CEREMONY_ABORTED' || err.name === 'NotAllowedError';
  return err instanceof Error && (err.name === 'NotAllowedError' || err.name === 'AbortError');
}

/** Plain-language explanation of a failed registration or signing attempt. */
export function describePasskeyError(err: unknown): PasskeyProblem {
  const problem = (title: string, body: string, needsRegistration = false): PasskeyProblem => ({
    title,
    body,
    needsRegistration,
  });
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'passkey_not_registered':
        return problem('Register a passkey first', 'Go-live, rollback and break-glass decisions must be signed with a passkey.', true);
      case 'passkey_invalid':
        return problem(
          'The signature was not accepted',
          'The server could not verify the passkey assertion: the challenge may have expired (5 minutes) or the decision changed. Nothing was recorded; sign again.',
        );
      case 'decision_not_open':
      case 'already_resolved':
      case 'not_open':
        return problem('This decision is already closed', 'Someone resolved or withdrew it meanwhile. The page shows its outcome.');
      case 'cannot_resolve':
      case 'separation_of_duties':
      case 'role':
      case 'not_eligible':
        return problem('You cannot resolve this decision', err.message);
      case 'passkey_exists':
        return problem('This passkey is already registered', 'Use it to sign the decision.');
      case 'passkey_registration_failed':
        return problem('The passkey could not be registered', err.message);
      case 'challenge_expired':
      case 'challenge_used':
      case 'challenge_unknown':
        return problem('The passkey request expired', 'Start again: each challenge is single-use and valid for 5 minutes.');
      default:
        return problem('The passkey step failed', describeError(err) ?? 'Try again.');
    }
  }
  if (isCancelled(err)) {
    return problem('No passkey response', 'The passkey prompt was cancelled or timed out. Nothing was signed.');
  }
  if (err instanceof WebAuthnError) {
    if (err.code === 'ERROR_INVALID_DOMAIN' || err.code === 'ERROR_INVALID_RP_ID')
      return problem(
        'Passkeys need the console address',
        `This page is open at ${window.location.origin}, which is not the address passkeys are issued for. Open the console at its configured URL.`,
      );
    if (err.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED')
      return problem('This device already holds your passkey', 'Use it to sign the decision.');
  }
  return problem('The passkey step failed', describeError(err) ?? 'Try again.');
}
