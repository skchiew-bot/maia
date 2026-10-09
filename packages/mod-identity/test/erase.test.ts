/**
 * Crypto-shredding a person's scope (§13) must leave the identity projection exactly as a rebuild of the log makes it:
 * the live scrub and the replay with a missing body are two routes to one state, and every column that came out of the
 * erased body is empty on both. (Found by the daemon's projection-purity test on a history with registered passkeys.)
 */
import { afterEach, describe, expect, it } from 'vitest';
import { userBodyScope } from '../src';
import { setupIdentity } from './helpers/setup';

let close: (() => Promise<void>) | undefined;
afterEach(async () => close?.());

describe('erasing a person', () => {
  it('empties every column that came from their passkey registration, and a rebuild agrees', async () => {
    const { t, h } = await setupIdentity();
    close = () => t.close();
    const ada = h.user('builder', 'Ada Lovelace', { email: 'ada@example.com' });
    const credentialIdHash = 'a'.repeat(64);
    const store = t.rt.store;
    store.append({
      type: 'passkey.registered',
      actor: { kind: 'human', id: ada.user.id },
      scope: { userId: ada.user.id },
      meta: { userId: ada.user.id, credentialIdHash, viaTokenId: ada.tokenId },
      payload: {
        credential: { id: 'Y3JlZC1hZGE', publicKey: 'cHVibGljLWtleS1hZGE', counter: 7, transports: ['internal', 'hybrid'] },
        label: "Ada's laptop",
        deviceType: 'multiDevice',
        backedUp: true,
      },
      source: 'api',
      bodyScope: userBodyScope(ada.user.id),
    });
    store.append({
      type: 'passkey.counter_updated',
      actor: { kind: 'human', id: ada.user.id },
      scope: { userId: ada.user.id },
      meta: { userId: ada.user.id, credentialIdHash, counter: 9, decisionId: 'dec_x' },
      source: 'api',
    });
    const dump = () => ({
      users: store.db.prepare('SELECT * FROM idn_users ORDER BY id').all(),
      passkeys: store.db.prepare('SELECT * FROM idn_passkeys ORDER BY id').all(),
      tokens: store.db.prepare('SELECT * FROM idn_tokens ORDER BY id').all(),
    });

    store.eraseScope(userBodyScope(ada.user.id), { actor: { kind: 'human', id: 'usr_dpo' }, reason: 'pdpa_request' });
    const live = dump();
    expect(live.passkeys).toEqual([
      expect.objectContaining({ id: credentialIdHash, credential_id: null, public_key: null, label: null, transports: null, device_type: null, backed_up: null, counter: 9 }),
    ]);
    expect(live.users).toEqual([expect.objectContaining({ name: '[erased]', email: null })]);

    store.rebuildProjections(['identity']);
    expect(dump()).toEqual(live);
  });

  it('a registration whose counter nothing advanced afterwards also matches its rebuild', async () => {
    const { t, h } = await setupIdentity();
    close = () => t.close();
    const grace = h.user('approver', 'Grace Hopper');
    const store = t.rt.store;
    store.append({
      type: 'passkey.registered',
      actor: { kind: 'human', id: grace.user.id },
      scope: { userId: grace.user.id },
      meta: { userId: grace.user.id, credentialIdHash: 'b'.repeat(64), viaTokenId: grace.tokenId },
      payload: { credential: { id: 'Y3JlZC1ncmFjZQ', publicKey: 'cHVibGljLWtleS1ncmFjZQ', counter: 3 } },
      source: 'api',
      bodyScope: userBodyScope(grace.user.id),
    });
    store.eraseScope(userBodyScope(grace.user.id), { actor: { kind: 'human', id: 'usr_dpo' }, reason: 'pdpa_request' });
    const live = store.db.prepare('SELECT * FROM idn_passkeys').all();
    store.rebuildProjections(['identity']);
    expect(store.db.prepare('SELECT * FROM idn_passkeys').all()).toEqual(live);
  });
});
