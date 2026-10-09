import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, EventStreamProvider } from '../../src/api';
import { useOpenDecisionCount } from '../../src/pages/decisions/inbox';
import { describePasskeyError, registerPasskey, resolveWithPasskey } from '../../src/pages/decisions/passkey';
import { FakeEventSource, FakeEventSourceCtor, jsonResponse, mockFetch } from '../helpers';

const browser = vi.hoisted(() => ({
  startRegistration: vi.fn(),
  startAuthentication: vi.fn(),
}));

vi.mock('@simplewebauthn/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/browser')>();
  return {
    ...actual,
    startRegistration: browser.startRegistration,
    startAuthentication: browser.startAuthentication,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  browser.startRegistration.mockReset();
  browser.startAuthentication.mockReset();
});

describe('per-decision passkey ceremony', () => {
  it('binds the challenge to the decision and option, then resolves with the assertion', async () => {
    const calls: { url: string; body: unknown }[] = [];
    mockFetch((url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (url === '/api/passkeys/assert/options')
        return jsonResponse({
          options: { challenge: 'ch_1', rpId: 'localhost' },
          expiresAt: 'x',
          cardHash: 'ab'.repeat(32),
        });
      if (url === '/api/decisions/dec_bg/resolve')
        return jsonResponse({ id: 'dec_bg', status: 'resolved', resolution: { method: 'passkey' } });
      return jsonResponse({}, { status: 404 });
    });
    browser.startAuthentication.mockResolvedValue({ id: 'cred', type: 'public-key' });

    const r = await resolveWithPasskey('dec_bg', 'approve', 'Production is down; approved.');

    expect(browser.startAuthentication).toHaveBeenCalledWith({
      optionsJSON: { challenge: 'ch_1', rpId: 'localhost' },
    });
    expect(calls.map((c) => c.url)).toEqual([
      '/api/passkeys/assert/options',
      '/api/decisions/dec_bg/resolve',
    ]);
    expect(calls[0]!.body).toEqual({ decisionId: 'dec_bg', optionId: 'approve' });
    expect(calls[1]!.body).toEqual({
      optionId: 'approve',
      comment: 'Production is down; approved.',
      passkeyAssertion: { id: 'cred', type: 'public-key' },
    });
    expect(r.cardHash).toBe('ab'.repeat(32));
  });

  it('registers a passkey through the identity endpoints', async () => {
    const urls: string[] = [];
    mockFetch((url) => {
      urls.push(url);
      if (url === '/api/passkeys/register/options')
        return jsonResponse({ options: { challenge: 'reg' }, expiresAt: 'x' });
      return jsonResponse({ passkey: { id: 'pk_1' } }, { status: 201 });
    });
    browser.startRegistration.mockResolvedValue({ id: 'new-cred' });
    await expect(registerPasskey('AOC console')).resolves.toEqual({ id: 'pk_1' });
    expect(urls).toEqual(['/api/passkeys/register/options', '/api/passkeys/register/verify']);
  });

  it('explains failures in plain words and offers registration when there is no passkey', () => {
    expect(describePasskeyError(new ApiError(409, 'passkey_not_registered', 'x')).needsRegistration).toBe(
      true,
    );
    expect(describePasskeyError(new ApiError(403, 'passkey_invalid', 'x')).title).toBe(
      'The signature was not accepted',
    );
    const cancelled = new DOMException(
      'The operation either timed out or was not allowed.',
      'NotAllowedError',
    );
    expect(describePasskeyError(cancelled).body).toMatch(/cancelled or timed out\. Nothing was signed/);
  });
});

function Count() {
  const n = useOpenDecisionCount();
  return <output data-testid="count">{n === null ? 'unknown' : n}</output>;
}

// Render tests drive real React trees with user-event: allow for a loaded CI machine.
describe('open decision count (top bar, nav and tab title)', { timeout: 15_000 }, () => {
  beforeEach(() => FakeEventSource.reset());

  it('counts only what the viewer can resolve and refreshes on decision events', async () => {
    let resolvable = 2;
    mockFetch((url) =>
      url === '/api/decisions/summary'
        ? jsonResponse({
            open: 5,
            resolvableByMe: resolvable,
            oldestOpenAt: null,
            oldestResolvableByMeAt: null,
            byKind: {},
          })
        : jsonResponse({}, { status: 404 }),
    );
    render(
      <MemoryRouter>
        <EventStreamProvider eventSource={FakeEventSourceCtor}>
          <Count />
        </EventStreamProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('2'));
    resolvable = 1;
    act(() =>
      FakeEventSource.last.emit('aoc', { seq: 3, type: 'decision.resolved', ts: '', scope: {}, meta: {} }),
    );
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('1'));
  });

  it('stays unknown when the summary cannot be read', async () => {
    mockFetch(() => jsonResponse({ error: { code: 'forbidden', message: 'no' } }, { status: 403 }));
    render(
      <MemoryRouter>
        <Count />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('unknown'));
  });
});
