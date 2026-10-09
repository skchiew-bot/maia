import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeEventSource } from '../helpers';
import { CLASSES, ERRORS, MODEL, OFFENCES, TREND } from './fixtures';
import { BUILDER, renderAt, routeFetch } from './harness';

function learningRoutes(extra: Parameters<typeof routeFetch>[0] = {}) {
  return routeFetch({
    'GET /api/learning/offences': () => OFFENCES,
    'GET /api/learning/classes': () => CLASSES,
    'GET /api/learning/trends': () => TREND,
    'GET /api/learning/model-dimension': () => MODEL,
    'GET /api/learning/errors': () => ERRORS,
    ...extra,
  });
}

async function openPage(path = '/learning') {
  renderAt(path, BUILDER);
  await screen.findByRole('heading', { level: 1, name: 'Learning' }, { timeout: 5000 });
  return screen.findByRole('table', { name: 'Repeat offences by cost of recurrence' }, { timeout: 5000 });
}

describe('Learning page', { timeout: 20_000 }, () => {
  // The route loads the page lazily; importing it once up front keeps each test's first render fast.
  beforeAll(async () => {
    await import('../../src/pages/learning/LearningPage');
  }, 30_000);

  beforeEach(() => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('leads with the recurrence trend ordered by cost of recurrence, not count', async () => {
    learningRoutes();
    await openPage();
    const facets = within(screen.getByRole('list', { name: 'Recurrence by root-cause class' })).getAllByRole(
      'img',
    );
    const names = facets.map((f) => f.getAttribute('aria-label')!.split(':')[0]);
    expect(names).toEqual([
      'Missing env-var guard in config loader',
      'Ambiguous acceptance criteria in tickets',
      'Malformed SQL migrations on the cheap model',
      'Flaky fixture clock in billing tests',
    ]);
    // every facet carries its numbers as text
    expect(facets[0]!.getAttribute('aria-label')).toMatch(/2 in the latest week, 5 over 8 weeks/);
    expect(
      screen.getByText('149 unclassified occurrences in the window', { exact: false }),
    ).toBeInTheDocument();
  });

  it('shows each offence on its lifecycle with the next step, and no column about people', async () => {
    learningRoutes();
    const table = await openPage();
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers.join(' ')).not.toMatch(/owner|developer|author|user|who/i);
    const env = within(table).getByRole('row', { name: /Missing env-var guard/ });
    expect(within(env).getByText('Detected')).toBeInTheDocument();
    expect(within(env).getByRole('button', { name: 'Mark root-caused…' })).toBeInTheDocument();
    const sql = within(table).getByRole('row', { name: /Malformed SQL/ });
    expect(within(sql).getByText('Verifying · closes Oct 23')).toBeInTheDocument();
    expect(within(sql).queryByRole('button')).toBeNull();
    const closed = within(table).getByRole('row', { name: /Flaky fixture clock/ });
    expect(within(closed).getByText('Verified closed')).toBeInTheDocument();
  });

  it('marks an offence root-caused, requiring the cause first', async () => {
    const user = userEvent.setup();
    const { calls } = learningRoutes({
      'POST /api/learning/offences/off_env/transition': (_url, body) => ({
        ...OFFENCES[0],
        state: (body as { to: string }).to,
      }),
    });
    const table = await openPage();
    await user.click(
      within(within(table).getByRole('row', { name: /Missing env-var guard/ })).getByRole('button', {
        name: 'Mark root-caused…',
      }),
    );
    const dialog = screen.getByRole('dialog', { name: 'Mark root-caused' });
    await user.click(within(dialog).getByRole('button', { name: 'Mark root-caused' }));
    expect(within(dialog).getByText('Say what causes it (at least 3 characters).')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.type(within(dialog).getByLabelText(/^Root cause/), 'Config is read lazily with no guard.');
    await user.click(within(dialog).getByRole('button', { name: 'Mark root-caused' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Mark root-caused' })).toBeNull());
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.path).toBe('/api/learning/offences/off_env/transition');
    expect(post.body).toEqual({ to: 'root_caused', note: 'Config is read lazily with no guard.' });
  });

  it('names the model as the cause only for a class that recurs on the cheaper tier, with a targeted upgrade', async () => {
    learningRoutes();
    await openPage();
    const model = screen.getByRole('region', { name: 'Model as a root-cause dimension' });
    expect(within(model).getAllByText('Model capability')).toHaveLength(1);
    expect(within(model).getByText(/Targeted upgrade for/)).toHaveTextContent(
      'Targeted upgrade for migration only: Haiku → Sonnet, not a blanket upgrade.',
    );
    expect(within(model).getByText('Not the model')).toBeInTheDocument();
  });

  it('assigns a repeating signature to a new root-cause class', async () => {
    const user = userEvent.setup();
    const { calls } = learningRoutes({
      'POST /api/learning/errors/err_3/root-cause': () => ({
        ...ERRORS[0],
        classId: 'rcc_new',
        className: 'Deep imports',
      }),
    });
    await openPage();
    const occurrences = screen.getByRole('region', { name: 'Occurrences' });
    expect(within(occurrences).getByRole('tab', { name: /Repeating, no root cause/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(occurrences).getByText('1 one-off signature', { exact: false })).toBeInTheDocument();
    await user.click(within(occurrences).getByRole('button', { name: 'Assign root cause' }));
    const dialog = screen.getByRole('dialog', { name: 'Assign a root cause' });
    await user.click(within(dialog).getByLabelText('A new class'));
    await user.type(within(dialog).getByLabelText(/^Class name/), 'Deep relative imports');
    await user.selectOptions(within(dialog).getByLabelText(/^Where the cause points/), 'codebase');
    await user.click(within(dialog).getByRole('button', { name: 'Assign root cause' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Assign a root cause' })).toBeNull());
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      newClass: { name: 'Deep relative imports', dimension: 'codebase' },
    });
  });

  it('opens an offence from the URL with its stated fix and the lesson hand-off', async () => {
    learningRoutes();
    await openPage('/learning?class=rcc_sql');
    const drawer = await screen.findByRole('dialog', { name: 'Malformed SQL migrations on the cheap model' });
    expect(within(drawer).getByText('Route migration runs to Sonnet.')).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Propose a lesson' })).toHaveAttribute(
      'href',
      '/knowledge?propose=rcc_sql',
    );
  });

  it('refetches when a learning event arrives on the stream, and ignores others', async () => {
    const { calls } = learningRoutes();
    await openPage();
    const offenceCalls = () => calls.filter((c) => c.path === '/api/learning/offences').length;
    const before = offenceCalls();
    act(() => FakeEventSource.last.open());
    act(() =>
      FakeEventSource.last.emit('aoc', {
        seq: 9,
        type: 'session.liveness_changed',
        ts: '',
        scope: {},
        meta: {},
      }),
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(offenceCalls()).toBe(before);
    act(() =>
      FakeEventSource.last.emit('aoc', {
        seq: 10,
        type: 'offence.transitioned',
        ts: '',
        scope: {},
        meta: {},
      }),
    );
    await waitFor(() => expect(offenceCalls()).toBe(before + 1));
  });
});
