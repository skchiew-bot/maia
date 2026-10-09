import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { jsonResponse } from '../helpers';
import { cleanupServer, renderAt, serve } from './server';

afterEach(cleanupServer);

const projectRows = () => screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);

// Accessible-name queries over full pages are slow in jsdom, more so on a loaded machine.
describe('Projects list', { timeout: 30_000 }, () => {
  it('orders projects by attention and prints the basis, the master timeline and spend for each', async () => {
    serve();
    renderAt('/projects');
    expect(await screen.findByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    await waitFor(() => expect(projectRows()).toEqual(['CX Copilot', 'AOC Platform']));

    const cx = screen.getByRole('listitem', { name: 'CX Copilot' });
    expect(within(cx).getByText('47%')).toBeInTheDocument();
    expect(within(cx).getByText('8/17 weight')).toBeInTheDocument();
    expect(within(cx).getByText(/1 flagged/)).toBeInTheDocument();
    expect(within(cx).getByText(/now in/)).toHaveTextContent('now in P2 Build');
    expect(
      within(cx).getByRole('img', {
        name: /CX Copilot completion by phase: 47% of declared weight done, 3 of 6 tasks, 1 flagged/,
      }),
    ).toBeInTheDocument();
    // Liveness is a badge with a count, in precedence order.
    const badges = within(cx).getByRole('list', { name: 'Live sessions by state' });
    expect(
      within(badges)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Waiting on you, 1', 'Dead, 1']);
    // The attention basis links to where each item is resolved; the fourth and later fold into "+N more".
    expect(within(cx).getByRole('link', { name: '1 decision open' })).toHaveAttribute('href', '/decisions');
    expect(within(cx).getByRole('link', { name: '1 high drift (7d)' })).toHaveAttribute(
      'href',
      '/projects/prj_cx#drift',
    );
    expect(
      within(cx).getByRole('link', { name: /^3 more: 1 flagged close, 1 drift \(7d\), 1 amendment \(7d\)$/ }),
    ).toBeInTheDocument();
    expect(within(cx).getByText('US$8.17')).toBeInTheDocument();
    expect(within(cx).getByText('RM 34.53')).toBeInTheDocument();

    const aoc = screen.getByRole('listitem', { name: 'AOC Platform' });
    expect(within(aoc).getByText('Nothing needs attention')).toBeInTheDocument();
    expect(within(aoc).getByText('No live sessions')).toBeInTheDocument();
    expect(within(aoc).getByText('every phase complete')).toBeInTheDocument();

    const kpis = screen.getByRole('list', { name: 'Portfolio at a glance' });
    expect(within(kpis).getByRole('group', { name: 'Need attention' })).toHaveTextContent('1of 2 projects');
    expect(within(kpis).getByRole('group', { name: 'Spend, 7 days' })).toHaveTextContent('US$20.17');
    expect(within(kpis).getByRole('group', { name: 'Spend, 7 days' })).toHaveTextContent(
      'notional API-equivalent · Oct 3–Oct 9',
    );
  });

  it('filters to projects needing attention and finds by name or slug, keeping the choice in the URL', async () => {
    serve();
    const user = userEvent.setup({ delay: null });
    renderAt('/projects');
    await waitFor(() => expect(projectRows()).toHaveLength(2));
    await user.click(screen.getByRole('radio', { name: 'Needs attention' }));
    expect(projectRows()).toEqual(['CX Copilot']);
    expect(screen.getByTestId('location')).toHaveTextContent('/projects?show=attention');

    await user.click(screen.getByRole('radio', { name: 'All' }));
    await user.type(screen.getByRole('searchbox', { name: 'Find' }), 'aoc-plat');
    expect(projectRows()).toEqual(['AOC Platform']);
    await user.clear(screen.getByRole('searchbox', { name: 'Find' }));
    await user.type(screen.getByRole('searchbox', { name: 'Find' }), 'zzz');
    expect(screen.getByText('No project matches “zzz”')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(projectRows()).toHaveLength(2);
  });

  it('creates a project and opens it', async () => {
    const { writes } = serve({
      'POST /api/projects': () =>
        jsonResponse(
          { projectId: 'prj_new', name: 'Claims v2', slug: 'claims-v2', threads: [] },
          { status: 201 },
        ),
    });
    const user = userEvent.setup({ delay: null });
    renderAt('/projects');
    await user.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    const create = within(dialog).getByRole('button', { name: 'Create project' });
    expect(create).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/^Name/), 'Claims v2');
    await user.type(within(dialog).getByLabelText('Repository path'), '/srv/repos/claims-v2');
    await user.click(create);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/projects/prj_new'));
    expect(writes).toEqual([
      {
        method: 'POST',
        path: '/api/projects',
        body: { name: 'Claims v2', repoPath: '/srv/repos/claims-v2', defaultBranch: 'main' },
      },
    ]);
  });

  it('shows the daemon refusal inside the dialog', async () => {
    serve({
      'POST /api/projects': () =>
        jsonResponse(
          {
            error: {
              code: 'invalid',
              message: 'Validation failed',
              details: [{ path: 'name', message: 'Too long' }],
            },
          },
          { status: 422 },
        ),
    });
    const user = userEvent.setup({ delay: null });
    renderAt('/projects');
    await user.click(await screen.findByRole('button', { name: 'New project' }));
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    await user.type(within(dialog).getByLabelText(/^Name/), 'X');
    await user.click(within(dialog).getByRole('button', { name: 'Create project' }));
    expect(await within(dialog).findByText('Too long')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Name/)).toHaveAttribute('aria-invalid', 'true');
  });

  it('has error, empty and partial-failure states', async () => {
    serve({
      '/api/projects': () =>
        jsonResponse({ error: { code: 'internal', message: 'Store restarting' } }, { status: 503 }),
    });
    const { unmount } = renderAt('/projects');
    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't load projects");
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    unmount();
    cleanupServer();

    serve({ '/api/projects': [], '/api/projects/rollup': [] });
    const second = renderAt('/projects');
    expect(await screen.findByText('No projects yet')).toBeInTheDocument();
    second.unmount();
    cleanupServer();

    serve({
      '/api/metering/summary': () =>
        jsonResponse(
          { error: { code: 'forbidden', message: 'Org-wide metering needs audit.view' } },
          { status: 403 },
        ),
    });
    renderAt('/projects');
    expect(await screen.findByText('Spend is not shown')).toBeInTheDocument();
    expect(screen.getAllByText('unavailable').length).toBeGreaterThan(0);
  });
});
