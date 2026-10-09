import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegistryTypesResponse } from '@aoc/contracts';
import { FakeEventSource } from '../helpers';
import { CLASSES, OFFENCES } from '../learning/fixtures';
import { BUILDER, renderAt, routeFetch } from '../learning/harness';
import { DECISIONS, LESSONS } from './fixtures';

const TYPES: RegistryTypesResponse = {
  version: '1',
  versionHash: 'abc',
  types: [
    {
      id: 'migration',
      name: 'Data / schema migration',
      description: 'Risky.',
      class: 'discovery',
      model: 'opus',
      executionModel: null,
      currentModel: 'opus',
      activePlaybookId: null,
    } as RegistryTypesResponse['types'][number],
  ],
};

function knowledgeRoutes(extra: Parameters<typeof routeFetch>[0] = {}) {
  return routeFetch({
    'GET /api/learning/lessons': () => LESSONS,
    'GET /api/decisions': () => ({ generatedAt: '2026-10-09T05:00:00.000Z', decisions: DECISIONS }),
    'GET /api/learning/offences': () => OFFENCES,
    'GET /api/learning/classes': () => CLASSES,
    'GET /api/registry/process-types': () => TYPES,
    ...extra,
  });
}

async function openPage(path = '/knowledge') {
  renderAt(path, BUILDER);
  await screen.findByRole('heading', { level: 1, name: 'Knowledge' }, { timeout: 5000 });
  return screen.findByRole('table', { name: 'Distilled lessons' }, { timeout: 5000 });
}

describe('Knowledge page', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    await import('../../src/pages/knowledge/KnowledgePage');
  }, 30_000);

  beforeEach(() => {
    FakeEventSource.reset();
    vi.stubGlobal('EventSource', FakeEventSource);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('leads with payoff per lesson, including a lesson that is not working', async () => {
    knowledgeRoutes();
    await openPage();
    const payoff = screen.getByRole('list', { name: 'Repeats prevented per lesson since binding' });
    const rows = within(payoff).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Write each migration as a reversible up/down pair.');
    expect(rows[0]).toHaveTextContent('+2.0 repeats prevented');
    expect(rows[0]).toHaveTextContent('US$3.34 · 40m saved');
    expect(rows[1]).toHaveTextContent('−1.5 repeats prevented');
    expect(rows[1]).toHaveTextContent('not working: prune');
    const kpis = screen.getByRole('list', { name: 'Lessons at a glance' });
    expect(within(kpis).getByRole('group', { name: 'Repeats prevented' })).toHaveTextContent('+0.5');
    expect(within(kpis).getByRole('group', { name: 'Retirement candidates' })).toHaveTextContent('1');
  });

  it('lists pending lesson decisions with links to the inbox and why the viewer cannot decide', async () => {
    knowledgeRoutes();
    await openPage();
    const pending = screen.getByRole('region', { name: 'Awaiting a decision' });
    const items = within(pending).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('No matching lesson in the registry');
    expect(items[0]).toHaveTextContent('You proposed it, so another Approver decides.');
    expect(within(items[0]!).getByRole('link', { name: 'View' })).toHaveAttribute(
      'href',
      '/decisions?focus=dec_orphan',
    );
    expect(items[1]).toHaveTextContent('Pin the Node version in every new service.');
    expect(within(items[1]!).getByRole('link', { name: 'Review and decide' })).toHaveAttribute(
      'href',
      '/decisions?focus=dec_les_pending',
    );
  });

  it('proposes a lesson from a repeat offence: class and stated fix prefilled, scope never global', async () => {
    const user = userEvent.setup();
    const { calls } = knowledgeRoutes({
      'POST /api/learning/lessons': (_url, body) => ({
        ...LESSONS[2],
        ...(body as object),
        status: 'proposed',
      }),
    });
    await openPage('/knowledge?propose=rcc_sql');
    const dialog = await screen.findByRole('dialog', { name: 'Propose a lesson' });
    expect(within(dialog).getByLabelText('Root-cause class')).toHaveValue('rcc_sql');
    expect(within(dialog).getByLabelText(/^Fix/)).toHaveValue('Route migration runs to Sonnet.');
    await user.click(within(dialog).getByLabelText('A code area'));
    await user.type(within(dialog).getByLabelText(/^Code area/), '/srv/db');
    await user.click(within(dialog).getByLabelText(/^Rule/));
    await user.paste('Migrations are reversible.');
    await user.click(within(dialog).getByRole('button', { name: 'Propose for a decision' }));
    expect(within(dialog).getByText('Use a path relative to the repository root.')).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.clear(within(dialog).getByLabelText(/^Code area/));
    await user.type(within(dialog).getByLabelText(/^Code area/), 'db/migrations');
    await user.click(within(dialog).getByRole('button', { name: 'Propose for a decision' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Propose a lesson' })).toBeNull(), {
      timeout: 5000,
    });
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      classId: 'rcc_sql',
      scopeType: 'code_area',
      scopeValue: 'db/migrations',
      rule: 'Migrations are reversible.',
      fix: 'Route migration runs to Sonnet.',
    });
    expect(screen.getByTestId('location')).toHaveTextContent('/knowledge');
    expect(screen.getByTestId('location')).not.toHaveTextContent('propose');
  });

  it('retires a lesson in force after confirmation', async () => {
    const user = userEvent.setup();
    const { calls } = knowledgeRoutes({
      'POST /api/learning/lessons/les_sql/retire': () => ({ ...LESSONS[2], status: 'retired' }),
    });
    const table = await openPage();
    const row = within(table).getByRole('row', { name: 'Open lesson for migration' });
    await user.click(within(row).getByRole('button', { name: 'Retire…' }));
    const confirm = screen.getByRole('alertdialog', { name: 'Retire this lesson?' });
    expect(confirm).toHaveTextContent('It stops being injected into process type migration.');
    await user.click(within(confirm).getByRole('button', { name: 'Retire lesson' }));
    await waitFor(
      () => expect(calls.some((c) => c.path === '/api/learning/lessons/les_sql/retire')).toBe(true),
      { timeout: 5000 },
    );
  });

  it('renders search snippets as text, marking hits without trusting server HTML', async () => {
    const user = userEvent.setup();
    const { calls } = knowledgeRoutes({
      'GET /api/knowledge/search': () => ({
        query: 'env var',
        kind: null,
        match: 'all',
        results: [
          {
            docId: 'lesson:les_env',
            kind: 'lesson',
            title: 'Config loaders must fail fast',
            snippet: 'missing env var <img src=x onerror=alert(1)>',
            snippetParts: [
              { text: 'missing ', hit: false },
              { text: 'env var', hit: true },
              { text: ' <img src=x onerror=alert(1)>', hit: false },
            ],
            score: 3.2,
            refs: { lessonId: 'les_env' },
            date: '2026-10-09T04:22:36.000Z',
          },
        ],
      }),
    });
    await openPage();
    const search = screen.getByRole('search');
    await user.type(within(search).getByRole('searchbox'), 'env var');
    await user.click(within(search).getByRole('button', { name: 'Search' }));
    const hit = await screen.findByText('env var', { selector: 'mark' });
    expect(hit.parentElement).toHaveTextContent('missing env var <img src=x onerror=alert(1)>');
    expect(document.querySelector('.knowledge-hits img')).toBeNull();
    expect(screen.getByRole('link', { name: 'Lesson' })).toHaveAttribute('href', '/knowledge?lesson=les_env');
    expect(calls.find((c) => c.path.startsWith('/api/knowledge/search'))!.path).toBe(
      '/api/knowledge/search?q=env+var&limit=20',
    );
  });
});
