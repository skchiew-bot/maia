import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { jsonResponse } from '../helpers';
import { CX_DETAIL } from './fixtures';
import { cleanupServer, renderAt, serve } from './server';

afterEach(cleanupServer);

const section = (name: string) => screen.getByRole('region', { name });

// The project page is large; accessible-name queries over it are slow in jsdom.
describe('Project page: master timeline', { timeout: 30_000 }, () => {
  it('shows phases in order with completion, pins and the current phase open to its tasks', async () => {
    serve();
    renderAt('/projects/prj_cx');
    expect(await screen.findByRole('heading', { level: 1, name: 'CX Copilot' })).toBeInTheDocument();
    expect(screen.getByText('/srv/repos/cx-copilot')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();

    const timeline = await screen.findByRole('region', { name: 'Master timeline' });
    expect(
      within(timeline).getByRole('img', {
        name: /Master timeline completion by phase: 47% of declared weight done, 3 of 6 tasks, 1 flagged/,
      }),
    ).toBeInTheDocument();
    expect(within(timeline).getByText('1 flagged · count until reviewed')).toBeInTheDocument();
    expect(within(timeline).getByText('ETA ≈ 5h at the current pace')).toBeInTheDocument();

    const design = within(timeline).getByRole('group', { name: 'P1 Design' });
    expect(within(design).getByRole('button', { name: /P1\s*Design/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(within(design).getByText('Done Oct 8')).toBeInTheDocument();
    expect(within(design).getByText('aoc/cx-copilot/design/12')).toBeInTheDocument();
    expect(
      within(design).getByRole('button', { name: /Copy full commit pinned by aoc\/cx-copilot\/design\/12/ }),
    ).toBeInTheDocument();
    expect(
      within(design).getByRole('img', { name: /P1 Design, by developer: Aisyah Rahman: 5 of 5 weight done/ }),
    ).toBeInTheDocument();

    // Build is the current phase: open, with its removed task struck out and explained.
    const build = within(timeline).getByRole('group', { name: 'P2 Build' });
    expect(within(build).getByRole('button', { name: /P2\s*Build/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    const tasks = within(build).getByRole('table', { name: 'P2 Build tasks' });
    expect(within(tasks).getByText('Implement service layer')).toBeInTheDocument();
    expect(within(tasks).getByText('Removed by an audited amendment')).toBeInTheDocument();
    expect(within(tasks).getAllByText('Tan Wei Jie')).toHaveLength(4);
    expect(within(build).getByText('No pin yet')).toBeInTheDocument();

    const verify = within(timeline).getByRole('group', { name: 'P3 Verify' });
    expect(within(verify).getByText('Not started')).toBeInTheDocument();
  });

  it('filters to flagged closes, opening the phases that hold them, and keeps the filter in the URL', async () => {
    serve();
    const user = userEvent.setup({ delay: null });
    renderAt('/projects/prj_cx');
    const timeline = await screen.findByRole('region', { name: 'Master timeline' });
    await user.click(within(timeline).getByRole('radio', { name: 'Flagged (1)' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/projects/prj_cx?tasks=flagged');
    const design = within(timeline).getByRole('group', { name: 'P1 Design' });
    const tasks = within(design).getByRole('table', { name: 'P1 Design tasks' });
    expect(within(tasks).getAllByRole('row')).toHaveLength(2); // header + the flagged close
    expect(within(tasks).getByText('Closed with no file change')).toBeInTheDocument();
    expect(within(tasks).getByText('api/t2.test.ts > passes')).toBeInTheDocument();
    // Phases without a match stay closed, and every phase still opens and closes on demand.
    const build = within(timeline).getByRole('group', { name: 'P2 Build' });
    const toggle = within(build).getByRole('button', { name: /P2\s*Build/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(within(build).getByText('No flagged closes in this phase.')).toBeInTheDocument();
    const designToggle = within(design).getByRole('button', { name: /P1\s*Design/ });
    await user.click(designToggle);
    expect(designToggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows scope changes, drift, decisions, lineage, process types and change control', async () => {
    serve();
    renderAt('/projects/prj_cx');
    await screen.findByRole('region', { name: 'Master timeline' });

    const scope = section('Scope changes');
    expect(
      within(scope).getByRole('img', {
        name: /Burn-up: declared weight 5 at the first plan, 17 now after 3 changes \(1 amendment\); done weight 8/,
      }),
    ).toBeInTheDocument();
    expect(
      within(scope).getByText('1 audited amendment changed the denominator after declaration.'),
    ).toBeInTheDocument();
    const log = within(scope).getByRole('table', { name: /denominator, newest first/ });
    const [, newest] = within(log).getAllByRole('row');
    expect(newest).toHaveTextContent('Amendment v2');
    expect(newest).toHaveTextContent('+1 added · −1 removed');
    expect(newest).not.toHaveTextContent('resized');
    expect(newest).toHaveTextContent('17 → 17');
    expect(newest).toHaveTextContent('UAT feedback from the CX ops lead');
    // The recorder is not a session owner here: the name comes with the history read.
    const enhancement = within(scope).getByText('Supervisor whisper on mobile').closest('li')!;
    expect(enhancement).toHaveTextContent('Chiew Sin Kwang');
    expect(enhancement).toHaveTextContent('Requested by the CX ops lead after UAT');

    const drift = section('Drift');
    expect(
      within(drift).getByText('Edit changed files before a plan manifest was declared.'),
    ).toBeInTheDocument();
    expect(within(drift).getByText('high')).toBeInTheDocument();

    const decisions = section('Open decisions');
    expect(within(decisions).getByText('Merge the sentiment overlay to main?')).toBeInTheDocument();
    expect(within(decisions).getByRole('link', { name: /Decide/ })).toHaveAttribute('href', '/decisions?focus=dec_1');

    const threads = section('Threads and rollover lineage');
    expect(await within(threads).findByText(/rolled over/)).toBeInTheDocument();
    expect(within(threads).getByText('1 rollover', { exact: false })).toBeInTheDocument();

    const types = section('Process types and playbooks');
    expect(within(types).getByText('Feature build')).toBeInTheDocument();
    expect(within(types).getByRole('link', { name: 'Feature build playbook' })).toBeInTheDocument();

    const cc = section('Change control');
    expect(within(cc).getByText(/None yet\. Every post-MVP change/)).toBeInTheDocument();
    expect(within(cc).getByRole('link', { name: 'All rollbacks' })).toHaveAttribute(
      'href',
      '/rollbacks?projectId=prj_cx',
    );
    expect(within(cc).getByText('1 pinned')).toBeInTheDocument();

    const sessions = section('Sessions');
    expect(within(sessions).getByRole('radio', { name: 'Live (2)' })).toHaveAttribute('aria-checked', 'true');
    expect(within(sessions).getByText('Real-time CSAT sentiment overlay')).toBeInTheDocument();
    expect(within(sessions).queryByText('Map current flow')).not.toBeInTheDocument();
  });

  it('records an enhancement and edits project details through the ledger API', async () => {
    const { writes } = serve({
      'POST /api/projects/prj_cx/enhancements': () =>
        jsonResponse(
          {
            eventId: 'evt_1',
            projectId: 'prj_cx',
            sessionId: null,
            changeId: null,
            at: new Date().toISOString(),
            by: 'usr_ceo',
            title: 'Bulk export',
            detail: null,
          },
          { status: 201 },
        ),
      'PATCH /api/projects/prj_cx': () => jsonResponse({ ...CX_DETAIL, description: 'Agent assist for CX' }),
    });
    const user = userEvent.setup({ delay: null });
    renderAt('/projects/prj_cx');
    await screen.findByRole('region', { name: 'Master timeline' });

    await user.click(screen.getByRole('button', { name: 'Record enhancement' }));
    const enh = await screen.findByRole('dialog', { name: 'Record an enhancement' });
    await user.type(within(enh).getByLabelText(/^Title/), 'Bulk export');
    await user.click(within(enh).getByRole('button', { name: 'Record enhancement' }));
    expect(await screen.findByText('Enhancement recorded: Bulk export')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    const edit = await screen.findByRole('dialog', { name: 'Edit project details' });
    const save = within(edit).getByRole('button', { name: 'Save changes' });
    expect(save).toBeDisabled();
    const description = within(edit).getByLabelText('Description');
    await user.clear(description);
    await user.type(description, 'Agent assist for CX');
    await user.click(save);
    expect(await screen.findByText('Project details saved')).toBeInTheDocument();

    expect(writes).toEqual([
      { method: 'POST', path: '/api/projects/prj_cx/enhancements', body: { title: 'Bulk export' } },
      { method: 'PATCH', path: '/api/projects/prj_cx', body: { description: 'Agent assist for CX' } },
    ]);
  });

  it('says plainly when the project does not exist', async () => {
    serve();
    renderAt('/projects/prj_nope');
    expect(await screen.findByRole('heading', { level: 1, name: 'Project not found' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'All projects' })).toHaveAttribute('href', '/projects');
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Master timeline' })).not.toBeInTheDocument(),
    );
  });
});
