import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EvidencePackJobDTO } from '@aoc/contracts';
import { GeneratePackForm } from '../../src/pages/compliance/Packs';
import { FakeEventSource, jsonResponse, mockFetch } from '../helpers';
import { NOW, installApi, pack, renderPage } from '../governance/fixtures';

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});
afterEach(() => vi.unstubAllGlobals());

const RANGE = '2026-10-03 to 2026-10-09';

function job(over: Partial<EvidencePackJobDTO> = {}): EvidencePackJobDTO {
  return {
    jobId: 'evj_new',
    status: 'queued',
    from: '2026-10-03',
    to: '2026-10-09',
    requestedBy: 'usr_ceo',
    requestedAt: '2026-10-09T07:00:00.000Z',
    position: 2,
    pack: null,
    error: null,
    statusUrl: '/api/evidence/jobs/evj_new',
    ...over,
  };
}

const refusal = (code: string, message: string, details: unknown) =>
  jsonResponse({ error: { code, message, details } }, { status: 429, headers: { 'retry-after': '10' } });

/** Renders the form with a fast poll, the range typed in as the date fields take it, and a spy for the list reload. */
async function setup() {
  const onGenerated = vi.fn();
  const user = userEvent.setup({ delay: null });
  renderPage(<GeneratePackForm now={NOW} onGenerated={onGenerated} pollMs={10} />, {
    path: '/x',
    route: '/x',
  });
  const from = await screen.findByLabelText(/^From/);
  const to = screen.getByLabelText(/^To \(inclusive\)/);
  await user.clear(from);
  await user.type(from, '2026-10-03');
  await user.clear(to);
  await user.type(to, '2026-10-09');
  const generate = () => user.click(screen.getByRole('button', { name: 'Generate frozen pack' }));
  return { onGenerated, generate };
}

describe('Generating an evidence pack (queued builds, one at a time)', { timeout: 30_000 }, () => {
  it('says it is building while the request is out, then that the pack is ready', async () => {
    let answer!: (r: Response) => void;
    mockFetch((_url, init) =>
      init.method === 'POST' ? new Promise<Response>((resolve) => (answer = resolve)) : jsonResponse({}),
    );
    const { onGenerated, generate } = await setup();
    await generate();

    expect(await screen.findByText(`Building: ${RANGE}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Building…' })).toHaveAttribute('aria-busy', 'true');

    answer(jsonResponse({ ...pack(), integrity: 'ok', manifest: null }, { status: 201 }));
    const ready = (await screen.findByText(`Ready: ${RANGE}`)).closest('.aoc-alert');
    expect(ready).toHaveTextContent('3,368 events · chain and 1 anchor verified');
    expect(screen.getByRole('link', { name: 'Download .zip' })).toHaveAttribute('href', pack().downloadUrl);
    expect(screen.getByRole('button', { name: 'Generate frozen pack' })).not.toHaveAttribute('aria-busy');
    expect(onGenerated).toHaveBeenCalledTimes(1);
    expect(onGenerated.mock.calls[0]![0].packId).toBe(pack().packId);
  });

  it('queues behind a build, follows the job to ready and then stops asking', async () => {
    let current = job();
    const calls = installApi({
      'POST /api/evidence/packs': () => jsonResponse(job(), { status: 202 }),
      'GET /api/evidence/jobs/evj_new': () => current,
    });
    const { onGenerated, generate } = await setup();
    await generate();

    expect(await screen.findByText(`Queued: ${RANGE}`)).toBeInTheDocument();
    expect(screen.getByText(/Number 2 in line\. Packs are built one at a time\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Queued…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText(/ask for the next once this one is ready/)).toBeInTheDocument();

    current = job({ status: 'running', position: null });
    expect(await screen.findByText(`Building: ${RANGE}`)).toBeInTheDocument();
    expect(onGenerated).not.toHaveBeenCalled();

    current = job({ status: 'done', position: null, pack: pack() });
    expect(await screen.findByText(`Ready: ${RANGE}`)).toBeInTheDocument();
    expect(await screen.findByText(`Evidence pack frozen: ${RANGE}`)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download .zip' })).toHaveAttribute('href', pack().downloadUrl);
    expect(onGenerated).toHaveBeenCalledTimes(1);

    const polled = () => calls.filter((c) => c.path === '/api/evidence/jobs/evj_new').length;
    const settled = polled();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(polled()).toBe(settled);
    expect(onGenerated).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('shows the daemon failure of a build, in its words, and lets the next request go', async () => {
    let current = job();
    installApi({
      'POST /api/evidence/packs': () => jsonResponse(job(), { status: 202 }),
      'GET /api/evidence/jobs/evj_new': () => current,
    });
    const { onGenerated, generate } = await setup();
    await generate();
    expect(await screen.findByText(`Queued: ${RANGE}`)).toBeInTheDocument();

    current = job({ status: 'failed', position: null, error: 'The audit chain could not be read' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Failed: no pack was generated');
    expect(alert).toHaveTextContent(`${RANGE}: The audit chain could not be read`);
    expect(onGenerated).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Generate frozen pack' })).not.toHaveAttribute('aria-busy');
  });

  it('says so when the daemon has forgotten the job (it restarted), instead of waiting for ever', async () => {
    installApi({
      'POST /api/evidence/packs': () => jsonResponse(job(), { status: 202 }),
      // No fixture for the job: the fake answers 404 like a daemon that does not know it.
    });
    const { onGenerated, generate } = await setup();
    await generate();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The daemon no longer has this job');
    expect(onGenerated).not.toHaveBeenCalled();
  });

  it('keeps asking through a failed status read', async () => {
    let reads = 0;
    installApi({
      'POST /api/evidence/packs': () => jsonResponse(job(), { status: 202 }),
      'GET /api/evidence/jobs/evj_new': () =>
        ++reads === 1
          ? jsonResponse({ error: { code: 'internal', message: 'Internal error' } }, { status: 500 })
          : job({ status: 'done', position: null, pack: pack() }),
    });
    const { generate } = await setup();
    await generate();
    expect(await screen.findByText(`Ready: ${RANGE}`)).toBeInTheDocument();
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it('says why it was refused and when to try again, and starts nothing (429)', async () => {
    const calls = installApi({
      'POST /api/evidence/packs': () =>
        refusal('rate_limited', 'At most 12 evidence packs per user per hour', {
          jobId: null,
          retryAfterMs: 1_800_000,
        }),
    });
    const { onGenerated, generate } = await setup();
    await generate();

    const alert = (await screen.findByText('At most 12 evidence packs per user per hour')).closest(
      '.aoc-alert',
    );
    expect(alert).toHaveAttribute('role', 'status');
    expect(alert).toHaveTextContent('Try again in 30m.');
    expect(screen.queryByText(/^(Queued|Building|Ready)/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Generate frozen pack' })).not.toHaveAttribute('aria-busy');
    expect(onGenerated).not.toHaveBeenCalled();
    expect(calls.filter((c) => c.path.startsWith('/api/evidence/jobs/'))).toHaveLength(0);
  });

  it('follows the pack the person already has pending when a second request is refused', async () => {
    let current = job({
      jobId: 'evj_old',
      status: 'running',
      position: null,
      from: '2026-09-01',
      to: '2026-09-30',
    });
    installApi({
      'POST /api/evidence/packs': () =>
        refusal('pack_pending', 'Your previous evidence pack is still being built', {
          jobId: 'evj_old',
          retryAfterMs: 10_000,
        }),
      'GET /api/evidence/jobs/evj_old': () => current,
    });
    const { onGenerated, generate } = await setup();
    await generate();

    expect(await screen.findByText('Your previous evidence pack is still being built')).toBeInTheDocument();
    expect(screen.getByText('Try again in 10s.')).toBeInTheDocument();
    expect(await screen.findByText('Building: 2026-09-01 to 2026-09-30')).toBeInTheDocument();

    current = { ...current, status: 'done', pack: pack({ from: '2026-09-01', to: '2026-09-30' }) };
    expect(await screen.findByText('Ready: 2026-09-01 to 2026-09-30')).toBeInTheDocument();
    await waitFor(() => expect(onGenerated).toHaveBeenCalledTimes(1));
  });

  it('still reports any other refusal as a failure', async () => {
    installApi({
      'POST /api/evidence/packs': () =>
        jsonResponse(
          { error: { code: 'invalid_range', message: 'A pack covers at most 366 days' } },
          { status: 422 },
        ),
    });
    const { generate } = await setup();
    await generate();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No pack was generated');
    expect(alert).toHaveTextContent('A pack covers at most 366 days');
  });
});
