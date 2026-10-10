import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssuedTokenDto } from '@aoc/contracts';
import { FakeEventSource } from '../helpers';
import { APPROVER, BUILDER, renderAt, routeFetch } from '../learning/harness';
import { LAST_ACTION, PASSKEYS, SESSIONS, USERS, USER_TOKENS, person } from './fixtures';

const SECRET = 'aoc_u_NewTok3nAbCdEfGhIjKlMnOpQrStUvWxYz0123';

function adminRoutes(extra: Parameters<typeof routeFetch>[0] = {}) {
  return routeFetch({
    'GET /api/users': () => ({ users: USERS }),
    'GET /api/tokens': (url) => {
      const kind = url.searchParams.get('kind');
      if (kind === 'web_session') return { tokens: SESSIONS };
      if (kind === 'observer') return { tokens: [] };
      return { tokens: USER_TOKENS };
    },
    'GET /api/passkeys': (url) => ({ passkeys: PASSKEYS[url.searchParams.get('userId') ?? ''] ?? [] }),
    'GET /api/audit/events': (url) => {
      const ts = LAST_ACTION[url.searchParams.get('actorId') ?? ''];
      return {
        events: ts
          ? [
              {
                seq: 1,
                id: 'e',
                ts,
                type: 'decision.resolved',
                actor: { kind: 'human', id: 'x' },
                scope: {},
                meta: {},
              },
            ]
          : [],
        headSeq: 10,
        nextFromSeq: null,
        nextToSeq: null,
      };
    },
    ...extra,
  });
}

async function openPage(path = '/admin/users') {
  renderAt(path, APPROVER);
  await screen.findByRole('heading', { level: 1, name: 'Users' }, { timeout: 5000 });
  return screen.findByRole('table', { name: 'People and their access' }, { timeout: 5000 });
}

describe('Admin › Users page', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await import('../../src/pages/admin/AdminUsersPage');
  }, 30_000);

  beforeEach(() => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is closed to Builders', async () => {
    adminRoutes();
    renderAt('/admin/users', BUILDER);
    // The notice is a page of its own: it has the h1 every page needs and says who may open the area.
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Not available for your role' }),
    ).toBeInTheDocument();
    expect(screen.getByText('You are signed in as Builder.')).toBeInTheDocument();
    expect(screen.getByText('This area needs the Approver role')).toBeInTheDocument();
  });

  it('makes a sole Approver visible and offers to add a deputy', async () => {
    const user = userEvent.setup();
    adminRoutes();
    await openPage();
    const alert = screen.getByText('Only one Approver: Chiew Sin Kwang').closest('.aoc-alert') as HTMLElement;
    expect(alert).toHaveTextContent('Requests you raise can never be approved');
    expect(alert).toHaveTextContent('sole-Approver fallback is off');
    await user.click(within(alert).getByRole('button', { name: 'Add a deputy Approver' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a deputy Approver' });
    expect(within(dialog).getByLabelText(/^Role/)).toHaveValue('approver');
  });

  it('shows who holds each gate, with nobody able to sign passkey gates yet', async () => {
    adminRoutes();
    await openPage();
    // passkeys arrive per person after the user list
    expect(
      await screen.findByText('No Approver can sign go-live, rollback or break-glass'),
    ).toBeInTheDocument();
    const gates = screen.getByRole('list', { name: 'Gate coverage' });
    const [passkey, approver, builder, compliance] = within(gates).getAllByRole('listitem');
    expect(within(passkey!).getByText('Nobody')).toBeInTheDocument();
    expect(passkey).toHaveTextContent('Nobody can approve them: an Approver must register a passkey.');
    expect(approver).toHaveTextContent('Single point');
    expect(approver).toHaveTextContent('Chiew Sin Kwang');
    expect(builder).toHaveTextContent('Covered');
    expect(compliance).toHaveTextContent('Priya Nair');
  });

  it('issues a token: secret shown once with copy and the attribution caveat, then only its prefix', async () => {
    const user = userEvent.setup();
    const issued: IssuedTokenDto = {
      token: SECRET,
      tokenId: 'tok_new',
      kind: 'user',
      prefix: SECRET.slice(0, 14),
      expiresAt: '2026-11-08T00:00:00.000Z',
      note: 'Store this token now: it is shown only once and cannot be recovered (only its hash is kept).',
    };
    const { calls } = adminRoutes({ 'POST /api/users/usr_aisyah/tokens': () => issued });
    const table = await openPage();
    await user.click(within(table).getByRole('row', { name: 'Manage Aisyah Rahman' }));
    const drawer = await screen.findByRole('dialog', { name: 'Aisyah Rahman' });
    expect(within(drawer).getByText('aoc_u_Yx6q5Mb5…')).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Issue token' }));
    const dialog = screen.getByRole('dialog', { name: 'Issue a token for Aisyah Rahman' });
    expect(within(dialog).getByText('Attribution, not signature')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Label'), 'laptop CLI');
    await user.selectOptions(within(dialog).getByLabelText('Expires'), '30');
    await user.click(within(dialog).getByRole('button', { name: 'Issue token' }));
    const secret = await within(dialog).findByLabelText('Token');
    expect(secret).toHaveValue(SECRET);
    expect(within(dialog).getByText(issued.note)).toBeInTheDocument();
    expect(within(dialog).getByText('Attribution, not signature')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ label: 'laptop CLI', expiresInDays: 30 });
    await user.click(within(dialog).getByRole('button', { name: 'Done: I stored it' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Issue a token/ })).toBeNull(), {
      timeout: 5000,
    });
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('issues an observer token to one developer, and only once one is chosen (O-6)', async () => {
    const user = userEvent.setup();
    const issued: IssuedTokenDto = {
      token: 'aoc_o_0bserverTok3nAbCdEfGhIjKlMnOpQrStUvWxYz012',
      tokenId: 'tok_obs',
      kind: 'observer',
      prefix: 'aoc_o_0bserver',
      expiresAt: null,
      note: 'Store this token now: it is shown only once and cannot be recovered (only its hash is kept).',
    };
    const { calls } = adminRoutes({ 'POST /api/tokens/observer': () => issued });
    await openPage();
    await user.click(screen.getByRole('button', { name: 'Issue observer token' }));
    const dialog = screen.getByRole('dialog', { name: 'Issue an observer token' });
    const developer = within(dialog).getByLabelText(/Developer/);
    // Only active people can hold one.
    expect(within(developer).queryByRole('option', { name: 'Former Approver' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Issue token' }));
    expect(await within(dialog).findByText('Choose the developer this token is for.')).toBeInTheDocument();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
    await user.selectOptions(developer, 'usr_aisyah');
    await user.click(within(dialog).getByRole('button', { name: 'Issue token' }));
    expect(await within(dialog).findByLabelText('Token')).toHaveValue(issued.token);
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ userId: 'usr_aisyah' });
  });

  it('blocks demoting or deactivating the last active Approver', async () => {
    const user = userEvent.setup();
    adminRoutes();
    const table = await openPage();
    await user.click(within(table).getByRole('row', { name: 'Manage Chiew Sin Kwang' }));
    const drawer = await screen.findByRole('dialog', { name: 'Chiew Sin Kwang' });
    await user.selectOptions(within(drawer).getByLabelText('Role', { exact: true }), 'builder');
    expect(within(drawer).getByText(/The last active Approver cannot be demoted/)).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Save role' })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: 'Deactivate…' })).toBeDisabled();
  });

  it('changes a role through PATCH and reports people by name with last seen', async () => {
    const user = userEvent.setup();
    const { calls } = adminRoutes({
      'PATCH /api/users/usr_nur': (_url, body) => ({
        user: person({ id: 'usr_nur', name: 'Nur Hidayah', ...(body as object), role: 'builder' }),
      }),
    });
    const table = await openPage();
    const priya = within(table).getByRole('row', { name: 'Manage Priya Nair' });
    expect(priya).toHaveTextContent('Lead');
    await waitFor(() => expect(priya).toHaveTextContent('1'), { timeout: 5000 }); // one passkey, fetched per person
    await user.click(within(table).getByRole('row', { name: 'Manage Nur Hidayah' }));
    const drawer = await screen.findByRole('dialog', { name: 'Nur Hidayah' });
    await user.selectOptions(within(drawer).getByLabelText('Role', { exact: true }), 'builder');
    await user.click(within(drawer).getByRole('button', { name: 'Save role' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true), { timeout: 5000 });
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
      path: '/api/users/usr_nur',
      body: { role: 'builder' },
    });
    expect(calls.some((c) => c.path === '/api/passkeys?userId=usr_priya')).toBe(true);
    expect(calls.some((c) => c.path === '/api/audit/events?actorId=usr_ceo&order=desc&limit=1')).toBe(true);
  });

  it('surfaces a live setup token with a way to fix it', async () => {
    adminRoutes({
      'GET /api/tokens': (url) => {
        const kind = url.searchParams.get('kind');
        if (kind !== 'user') return { tokens: [] };
        return {
          tokens: [
            ...USER_TOKENS,
            {
              ...USER_TOKENS[0]!,
              tokenId: 'tok_boot',
              prefix: 'aoc_u_UellGWtB',
              createdBy: 'identity:bootstrap',
            },
          ],
        };
      },
    });
    await openPage();
    const alert = (await screen.findByText('The setup token is still live')).closest(
      '.aoc-alert',
    ) as HTMLElement;
    expect(alert).toHaveTextContent('aoc_u_UellGWtB… was issued when AOC was first set up');
    expect(within(alert).getByRole('button', { name: 'Manage' })).toBeInTheDocument();
  });

  it('shows an error with retry when people cannot be loaded', async () => {
    adminRoutes({
      'GET /api/users': () =>
        new Response(JSON.stringify({ error: { code: 'down', message: 'Daemon restarting' } }), {
          status: 503,
        }),
    });
    renderAt('/admin/users', APPROVER);
    await screen.findByRole('heading', { level: 1, name: 'Users' }, { timeout: 5000 });
    const people = screen.getByRole('region', { name: 'People' });
    expect(await within(people).findByText("Couldn't load users")).toBeInTheDocument();
    expect(within(people).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('explains when this browser cannot register a passkey', async () => {
    adminRoutes();
    await openPage();
    const own = screen.getByRole('region', { name: 'Your passkeys' });
    expect(await within(own).findByText('Passkeys are not available here')).toBeInTheDocument();
  });
});
