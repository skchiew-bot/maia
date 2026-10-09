import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidencePackDetailDTO } from '@aoc/contracts';
import CompliancePage from '../../src/pages/compliance/CompliancePage';
import { FakeEventSource } from '../helpers';
import {
  CEO,
  COMMON_ROUTES,
  PRIYA,
  ago,
  installApi,
  mapping,
  pack,
  renderPage,
} from '../governance/fixtures';

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => vi.unstubAllGlobals());

const STAMPED = mapping({
  status: 'stamped',
  stampedBy: PRIYA.id,
  stampedAt: ago(0),
  stamp: { by: PRIYA.id, at: ago(0), localDate: '2026-10-09', eventId: 'evt_stamp', seq: 3371, note: null },
  statement: 'Mapping reviewed by compliance lead on 2026-10-09',
  banner: null,
  rows: mapping().rows.map((r) => ({ ...r, status: 'stamped' as const })),
  viewer: { canStamp: false, reason: null },
});

function detail(): EvidencePackDetailDTO {
  const p = pack();
  return {
    ...p,
    integrity: 'ok',
    manifest: {
      format: 'aoc-evidence-pack/1',
      packId: p.packId,
      range: {
        from: p.from,
        to: p.to,
        timezone: 'Asia/Kuala_Lumpur',
        days: 7,
        fromTs: '2026-10-02T16:00:00.000Z',
        toTsExclusive: '2026-10-09T16:00:00.000Z',
        complete: false,
      },
      generatedAt: p.generatedAt,
      generatedBy: p.generatedBy,
      chainId: 'cdb7fbeafd3f232cd1a700a32262c701',
      head: { seq: 3368, hash: 'ab'.repeat(32) },
      eventCount: p.eventCount,
      rangeSeqs: { first: 1, last: 3368 },
      mapping: {
        standard: 'ISO/IEC 42001:2023',
        version: p.mappingVersion,
        hash: p.mappingHash,
        source: 'config',
        rows: 28,
        status: 'provisional',
        stampedBy: null,
        stampedAt: null,
        statement: 'PROVISIONAL until stamped by the compliance lead',
      },
      rateCard: null,
      rateCardVersionsUsed: [3],
      fx: {
        days: 7,
        live: 5,
        inherited: 2,
        missing: 0,
        minRate: 4.2,
        maxRate: 4.3,
        discrepanciesRaised: 0,
        discrepanciesResolved: 0,
        carryForwardAlerts: 0,
      },
      verification: {
        ok: true,
        status: 'verified',
        chainOk: true,
        anchorsChecked: 1,
        anchorsMatched: 1,
        rangeCoveredByAnchor: false,
        unanchoredTailEvents: 219,
      },
      files: [{ path: 'events.jsonl', sha256: 'cd'.repeat(32), bytes: 40_000 }],
      privacy: 'Chained headers only: no payloads, prompts or personal data.',
    },
  };
}

describe('Compliance', { timeout: 30_000 }, () => {
  it('shows the mapping as provisional, clause by clause, and who can stamp it', async () => {
    installApi({
      ...COMMON_ROUTES,
      'GET /api/compliance/mapping': mapping(),
      'GET /api/evidence/packs': { packs: [] },
    });
    renderPage(<CompliancePage />, { path: '/compliance', route: '/compliance' });

    expect(await screen.findByText('Provisional — do not cite')).toBeInTheDocument();
    expect(screen.getByText('Who can stamp').nextSibling).toHaveTextContent('Priya Nair (compliance lead)');
    expect(screen.getByText('Only the compliance lead can stamp the mapping.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review and stamp' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('img', {
        name: /^3 mapped rows across 3 clause families, all provisional: Clause 6 1, Clause 7 1, Annex A · A.6 1\.$/,
      }),
    ).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'ISO/IEC 42001 clause to AOC evidence mapping' });
    const rows = within(table).getAllByRole('row').slice(1);
    // Natural clause order, each row provisional, each event type a link into the audit log.
    expect(rows.map((r) => within(r).getByText(/^(6\.3|7\.5|A\.6\.2\.8)$/).textContent)).toEqual([
      '6.3',
      '7.5',
      'A.6.2.8',
    ]);
    expect(within(table).getAllByText('provisional')).toHaveLength(3);
    expect(
      within(table).getByRole('link', { name: 'chain.verified events in the audit log' }),
    ).toHaveAttribute('href', '/audit?type=chain.verified');
    expect(within(table).getByText(/Corrected per §13/)).toBeInTheDocument();
    expect(screen.getByText('No evidence pack yet')).toBeInTheDocument();
  });

  it('narrows the clause table by family and by search', async () => {
    installApi({
      ...COMMON_ROUTES,
      'GET /api/compliance/mapping': mapping(),
      'GET /api/evidence/packs': { packs: [] },
    });
    const user = userEvent.setup({ delay: null });
    renderPage(<CompliancePage />, { path: '/compliance', route: '/compliance' });
    const table = await screen.findByRole('table', { name: 'ISO/IEC 42001 clause to AOC evidence mapping' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Clause family' }), 'A.6');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 1);
    expect(screen.getByText('1 of 3 rows')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Clause family' }), '');
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'planning');
    expect(within(table).getAllByRole('row')).toHaveLength(1 + 1);
    expect(within(table).getByText('Planning of changes')).toBeInTheDocument();
  });

  it('lets the compliance lead stamp the exact hash she reviewed', async () => {
    const calls = installApi({
      ...COMMON_ROUTES,
      'GET /api/compliance/mapping': mapping({ viewer: { canStamp: true, reason: null } }),
      'GET /api/evidence/packs': { packs: [] },
      'POST /api/compliance/mapping/stamp': STAMPED,
    });
    const user = userEvent.setup({ delay: null });
    renderPage(<CompliancePage />, { path: '/compliance', route: '/compliance', user: PRIYA });
    await user.click(await screen.findByRole('button', { name: 'Review and stamp' }));
    const dialog = await screen.findByRole('dialog', { name: 'Stamp the ISO/IEC 42001 mapping' });
    const stamp = within(dialog).getByRole('button', { name: 'Stamp mapping' });
    expect(stamp).toBeDisabled();
    await user.click(within(dialog).getByRole('checkbox', { name: /I confirmed every row/ }));
    await user.type(
      within(dialog).getByRole('textbox', { name: /Review note/ }),
      'Checked against the purchased standard.',
    );
    await user.click(stamp);

    expect(await screen.findByText('Stamped — citable')).toBeInTheDocument();
    const hero = screen.getByRole('region', { name: 'Can the ISO/IEC 42001 mapping be cited?' });
    expect(within(hero).getByText('Mapping reviewed by compliance lead on 2026-10-09')).toBeInTheDocument();
    expect(within(hero).getByText('Stamped by').nextSibling).toHaveTextContent(
      'Priya Nair (you) on 2026-10-09',
    );
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      version: '2026.10-draft',
      hash: mapping().hash,
      note: 'Checked against the purchased standard.',
    });
  });

  it('generates a frozen pack for a date range and lists it with its hash and download', async () => {
    let packs = [] as ReturnType<typeof pack>[];
    const calls = installApi({
      ...COMMON_ROUTES,
      'GET /api/compliance/mapping': mapping(),
      'GET /api/evidence/packs': () => ({ packs }),
      'POST /api/evidence/packs': () => {
        packs = [pack()];
        return pack();
      },
      [`GET /api/evidence/packs/${pack().packId}`]: detail(),
    });
    const user = userEvent.setup({ delay: null });
    renderPage(<CompliancePage />, { path: '/compliance', route: '/compliance', user: CEO });

    const from = await screen.findByLabelText(/^From/);
    const to = screen.getByLabelText(/^To \(inclusive\)/);
    await user.clear(from);
    await user.type(from, '2026-10-10');
    await user.clear(to);
    await user.type(to, '2026-10-03');
    expect(screen.getByText('The end date is before the start date.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate frozen pack' })).toBeDisabled();

    await user.clear(from);
    await user.type(from, '2026-10-03');
    await user.clear(to);
    await user.type(to, '2026-10-09');
    expect(screen.getByText(/^7 days/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Generate frozen pack' }));

    const table = await screen.findByRole('table', { name: 'Frozen evidence packs' });
    expect(within(table).getByText('chain and 1 anchor verified')).toBeInTheDocument();
    expect(
      within(table).getByRole('link', { name: 'Download pack 2026-10-03 to 2026-10-09' }),
    ).toHaveAttribute('href', pack().downloadUrl);
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ from: '2026-10-03', to: '2026-10-09' });

    await user.click(
      within(table).getByRole('row', { name: 'Pack 2026-10-03 to 2026-10-09: open its manifest' }),
    );
    const drawer = await screen.findByRole('dialog', { name: /Evidence pack 2026-10-03 → 2026-10-09/ });
    expect(await within(drawer).findByText('Stored pack matches its recorded hash')).toBeInTheDocument();
    expect(within(drawer).getByText('219 events in range are after the last anchor')).toBeInTheDocument();
    await waitFor(() => expect(within(drawer).getByText('events.jsonl')).toBeInTheDocument());
  });
});
