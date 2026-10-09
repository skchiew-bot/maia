import type { DecisionCard } from '@aoc/contracts';
import { SoftAuthenticator } from './authenticator';
import type { PersonKey, SeedWorld } from './world';

interface RegistrationOptions {
  options: { challenge: string; rp: { id?: string }; user: { id: string } };
}
interface AssertionOptions {
  options: { challenge: string; rpId?: string };
}

/**
 * Signs the passkey-gated decisions of the seeded history (go-live, rollback, break-glass) as the CEO, through the
 * ceremony the console runs: options bound to the decision → assertion → `POST /api/decisions/:id/resolve`. The
 * authenticator is registered on first use and removed by `retire` when the seed ends.
 */
export class PasskeySigner {
  private authenticator: SoftAuthenticator | null = null;
  private passkeyId: string | null = null;

  constructor(private readonly w: () => SeedWorld) {}

  private async enroll(): Promise<SoftAuthenticator> {
    if (this.authenticator) return this.authenticator;
    const w = this.w();
    const { identity } = w.config;
    const authenticator = new SoftAuthenticator(identity.origin, identity.rpId);
    const options = await w.ok<RegistrationOptions>('POST', '/api/passkeys/register/options', 'ceo');
    const registered = await w.ok<{ passkey: { id: string } }>('POST', '/api/passkeys/register/verify', 'ceo', {
      response: authenticator.register(options.options),
      label: 'Seed history signer (software)',
    });
    this.authenticator = authenticator;
    this.passkeyId = registered.passkey.id;
    return authenticator;
  }

  /** Resolve a passkey-gated decision with a verified, decision-bound assertion. */
  async resolve(decisionId: string, optionId: string, who: PersonKey = 'ceo', comment?: string): Promise<DecisionCard> {
    const w = this.w();
    const authenticator = await this.enroll();
    const options = await w.ok<AssertionOptions>('POST', '/api/passkeys/assert/options', who, { decisionId, optionId });
    await w.ok('POST', `/api/decisions/${decisionId}/resolve`, who, {
      optionId,
      ...(comment ? { comment } : {}),
      passkeyAssertion: authenticator.assert(options.options),
    });
    await w.settle();
    return w.rt.services.get('decisions').get(decisionId)!;
  }

  /** Remove the seeded credential: the demo's CEO registers a real passkey in Admin (the history keeps its record). */
  async retire(): Promise<void> {
    if (!this.passkeyId) return;
    await this.w().ok('DELETE', `/api/passkeys/${this.passkeyId}`, 'ceo');
    this.passkeyId = null;
    this.authenticator = null;
  }
}
