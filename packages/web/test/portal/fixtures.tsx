import type { PublicTicket } from '@aoc/contracts';
import { render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { AuthProvider, type AuthUser } from '../../src/api';
import { ClockProvider, fixedClock, ToastProvider } from '../../src/components';
import { AppRoutes } from '../../src/routes';
import { jsonResponse, mockFetch } from '../helpers';

export const NOW = Date.parse('2026-10-09T05:42:00Z');

export const REQUESTER: AuthUser = { id: 'usr_dan', name: 'Daniel Lim', role: 'requester', flags: {} };
export const APPROVER: AuthUser = { id: 'usr_ceo', name: 'Chiew Sin Kwang', role: 'approver', flags: {} };
export const BUILDER: AuthUser = { id: 'usr_ais', name: 'Aisyah Rahman', role: 'builder', flags: {} };

export function ticket(overrides: Partial<PublicTicket> = {}): PublicTicket {
  return {
    ticketId: 'tkt_1',
    title: 'Claim form goes blank after I attach a PDF',
    description: 'When I attach a police report the page turns white.',
    comment: null,
    severity: 'high',
    status: 'being_worked_on',
    statusLabel: 'Being worked on',
    submittedAt: '2026-10-09T02:00:00Z',
    updatedAt: '2026-10-09T05:00:00Z',
    attachments: [],
    canSignOffUat: false,
    ...overrides,
  };
}

export function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search}</output>;
}

export function renderPortal(path: string, user: AuthUser | null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ClockProvider clock={fixedClock(NOW)}>
        <AuthProvider initialUser={user}>
          <ToastProvider>
            <AppRoutes />
            <Location />
          </ToastProvider>
        </AuthProvider>
      </ClockProvider>
    </MemoryRouter>,
  );
}

export type Route = (url: string, init: RequestInit) => Response | Promise<Response> | undefined;

/** fetch mock: the first route that answers wins; anything else is a 404 so stray calls show up. */
export function routes(...handlers: Route[]) {
  return mockFetch(async (url, init) => {
    for (const h of handlers) {
      const res = await h(url, init);
      if (res) return res;
    }
    return jsonResponse({ error: { code: 'not_found', message: `no mock for ${url}` } }, { status: 404 });
  });
}

export const get = (path: string, body: unknown, status = 200): Route => (url, init) =>
  url === path && (init.method ?? 'GET') === 'GET' ? jsonResponse(body, { status }) : undefined;

/** Words a requester must never see (§7): internal gates, roles, machinery or timelines. */
export const INTERNAL_TERMS = /decision|session|approver|\bgates?\b|triage|\bqueue\b|\buat\b|fix plan|go-live|go live|\beta\b|daemon/i;
