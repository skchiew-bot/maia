import { render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../src/api';
import { ToastProvider } from '../src/components';
import { decisionHref } from '../src/lib/links';
import { AppRoutes } from '../src/routes';
import { CEO, card } from './decisions/fixtures';
import { FakeEventSource, jsonResponse, mockFetch } from './helpers';

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search}</output>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialUser={CEO}>
        <ToastProvider>
          <AppRoutes />
          <Location />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('deep links to a decision', () => {
  beforeEach(() => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('spells every decision link as ?focus=, encoded', () => {
    expect(decisionHref('dec_01M4')).toBe('/decisions?focus=dec_01M4');
    expect(decisionHref('dec 1/2')).toBe('/decisions?focus=dec%201%2F2');
  });

  // /decisions/:id is what the daemon puts in notifications and webhook payloads (mod-decisions).
  it('sends /decisions/:id to the inbox with that card selected', { timeout: 20_000 }, async () => {
    const open = card({ id: 'dec_notified', title: 'Ship the retry fix to production?' });
    mockFetch((raw) => {
      const url = new URL(raw, 'http://aoc.test');
      if (url.pathname === '/api/decisions')
        return jsonResponse({
          generatedAt: new Date().toISOString(),
          decisions: url.searchParams.get('status') === 'open' ? [open] : [],
        });
      return jsonResponse({ error: { code: 'not_found', message: 'nope' } }, { status: 404 });
    });

    renderAt('/decisions/dec_notified');

    // jsdom has no wide viewport, so the selected card opens in the drawer.
    expect(await screen.findByRole('dialog', { name: open.title })).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/decisions?focus=dec_notified');
    expect(screen.getByRole('heading', { level: 1, name: 'Decisions' })).toBeInTheDocument();
  });
});
