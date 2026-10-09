import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useDocumentBadge, type AuthUser } from '../src/api';
import { ToastProvider } from '../src/components';
import { AppRoutes } from '../src/routes';
import { FakeEventSource, jsonResponse, mockFetch } from './helpers';

const APPROVER: AuthUser = { id: 'usr_1', name: 'Aisyah Rahman', role: 'approver', flags: {} };
const BUILDER: AuthUser = { id: 'usr_2', name: 'Wei Jie Tan', role: 'builder', flags: {} };
const REQUESTER: AuthUser = { id: 'usr_3', name: 'Nur Iman', role: 'requester', flags: {} };

function Location() {
  const l = useLocation();
  return <output data-testid="location">{l.pathname + l.search}</output>;
}

function renderApp(path: string, user: AuthUser | null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider initialUser={user}>
        <ToastProvider>
          <AppRoutes />
          <Location />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
}

const location = () => screen.getByTestId('location').textContent;

describe('operator shell', () => {
  beforeEach(() => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('has a skip link, primary nav with aria-current, and the console page', async () => {
    renderApp('/console', APPROVER);
    expect(await screen.findByRole('heading', { level: 1, name: 'Console' })).toBeInTheDocument();
    const skip = screen.getByRole('link', { name: 'Skip to content' });
    expect(skip).toHaveAttribute('href', '#main');
    expect(document.getElementById('main')).toContainElement(screen.getByRole('heading', { level: 1 }));

    const nav = screen.getAllByRole('navigation', { name: 'Primary' })[0]!;
    const links = within(nav).getAllByRole('link');
    expect(links[0]).toHaveTextContent('Control Tower');
    expect(links.map((l) => l.textContent)).toEqual(
      expect.arrayContaining(['Console', 'Projects', 'Decisions', 'Audit', 'Admin', 'Showcase']),
    );
    expect(links[links.length - 1]).toHaveTextContent('Showcase');
    expect(within(nav).getByRole('link', { name: 'Console' })).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Projects' })).not.toHaveAttribute('aria-current');
  });

  it('shows the live connection as a word and the user with their role chip', async () => {
    renderApp('/console', APPROVER);
    await screen.findByRole('heading', { level: 1, name: 'Console' });
    expect(screen.getByText('Connecting…')).toBeInTheDocument();
    act(() => FakeEventSource.last.open());
    expect(screen.getByText('Live')).toBeInTheDocument();
    act(() => FakeEventSource.last.fail());
    expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Account: Aisyah Rahman, Approver/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Decisions inbox/ })).toHaveAttribute('href', '/decisions');
  });

  it('lands Approvers on the Control Tower and Builders on the Console', async () => {
    const { unmount } = renderApp('/', APPROVER);
    expect(await screen.findByRole('heading', { level: 1, name: 'Control Tower' })).toBeInTheDocument();
    expect(location()).toBe('/tower');
    unmount();
    renderApp('/', BUILDER);
    expect(await screen.findByRole('heading', { level: 1, name: 'Console' })).toBeInTheDocument();
    expect(location()).toBe('/console');
  });

  it('hides Admin from Builders and blocks the route', async () => {
    renderApp('/admin/users', BUILDER);
    expect(await screen.findByText('Not available for your role')).toBeInTheDocument();
    const nav = screen.getAllByRole('navigation', { name: 'Primary' })[0]!;
    expect(within(nav).queryByRole('link', { name: 'Admin' })).toBeNull();
  });

  it('sends Requesters to the portal, which has no internal navigation', async () => {
    renderApp('/console', REQUESTER);
    expect(await screen.findByRole('heading', { level: 1, name: 'My requests' })).toBeInTheDocument();
    expect(location()).toBe('/portal');
    expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Requests' })).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/decision|session|approver|gate/i);
  });

  it('sends anonymous visitors to sign in with a way back', async () => {
    renderApp('/sessions/ses_1', null);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(location()).toBe('/login?next=%2Fsessions%2Fses_1');
  });

  it('renders the not-found page inside the shell', async () => {
    renderApp('/nope', BUILDER);
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getAllByRole('navigation', { name: 'Primary' }).length).toBeGreaterThan(0);
  });

  it('opens the navigation drawer from the hamburger and closes it on navigation', async () => {
    const user = userEvent.setup();
    renderApp('/console', APPROVER);
    await screen.findByRole('heading', { level: 1, name: 'Console' });
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));
    const drawer = screen.getByRole('dialog', { name: 'Navigation' });
    await user.click(within(drawer).getByRole('link', { name: 'Audit' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Audit' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).toBeNull();
    // focus moves to the new page's heading so screen readers announce it
    await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Audit' })).toHaveFocus());
  });
});

describe('sign-in', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the pasted token, loads the user and continues to the requested page', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('EventSource', FakeEventSource);
    let signedIn = false;
    const fetchMock = mockFetch((url, init) => {
      if (url === '/api/auth/login') {
        signedIn = JSON.parse(String(init.body)).token === 'tok_good';
        return signedIn
          ? jsonResponse({ ok: true })
          : jsonResponse({ error: { code: 'bad_token', message: 'No' } }, { status: 401 });
      }
      if (url === '/api/auth/me') return signedIn ? jsonResponse(BUILDER) : jsonResponse({}, { status: 401 });
      return jsonResponse({}, { status: 404 });
    });
    renderApp('/login?next=%2Fchanges', null);
    expect(await screen.findByText('Attribution, not signed approval')).toBeInTheDocument();
    const field = screen.getByLabelText(/Access token/);
    expect(field).toHaveAttribute('type', 'password');

    await user.type(field, 'tok_bad');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/That access token was not recognised/)).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');

    await user.clear(field);
    await user.type(field, 'tok_good');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Changes' })).toBeInTheDocument();
    expect(location()).toBe('/changes');
    const login = fetchMock.mock.calls.find(([u]) => u === '/api/auth/login')!;
    expect(login[1]).toMatchObject({ method: 'POST', credentials: 'include' });
  });
});

describe('document badge', () => {
  it('prefixes the tab title with the open count', () => {
    function Badge({ n }: { n: number }) {
      useDocumentBadge(n);
      return null;
    }
    document.title = 'Decisions · AOC';
    const { rerender, unmount } = render(<Badge n={3} />);
    expect(document.title.startsWith('(3) ')).toBe(true);
    rerender(<Badge n={0} />);
    expect(document.title.startsWith('(')).toBe(false);
    rerender(<Badge n={12} />);
    expect(document.title.startsWith('(12) ')).toBe(true);
    unmount();
    expect(document.title.startsWith('(')).toBe(false);
  });
});
