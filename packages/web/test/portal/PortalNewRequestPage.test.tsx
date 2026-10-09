import type { IntakeLimits } from '@aoc/contracts';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LIMITS } from '../../src/pages/portal/uploads';
import { allowSlowRenders, get, INTERNAL_TERMS, REQUESTER, renderPortal, routes, ticket } from './fixtures';

/** In-memory XMLHttpRequest: the test drives upload progress and the response. */
class FakeXhr {
  static last: FakeXhr | null = null;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  body: FormData | null = null;
  withCredentials = false;
  status = 0;
  responseText = '';
  aborted = false;
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  send(body: FormData) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
    this.onabort?.();
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({ lengthComputable: true, loaded, total });
  }
  respond(status: number, body: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2]);
const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj << >> endobj\n');
const LIMITS: IntakeLimits = { ...DEFAULT_LIMITS, maxAttachments: 3, maxBytes: { image: 1024, video: 4096, document: 1024 }, maxTotalBytes: 4096 };

beforeEach(() => {
  FakeXhr.last = null;
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  window.sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByRole('textbox', { name: /What went wrong/ }), 'Claim form goes blank');
  await user.type(screen.getByRole('textbox', { name: /What happened/ }), 'The page turns white when I attach a PDF.');
}

allowSlowRenders();
beforeAll(async () => {
  await import('../../src/pages/portal/PortalNewRequestPage');
});

describe('new request', () => {
  it('lists every problem in a summary before anything is sent', async () => {
    const user = userEvent.setup();
    routes(get('/portal/api/limits', LIMITS));
    renderPortal('/portal/new', REQUESTER);
    await user.click(await screen.findByRole('button', { name: 'Send request' }));
    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent('Check your request before sending');
    expect(summary).toHaveTextContent('Add a short summary of what went wrong (at least 3 characters).');
    expect(summary).toHaveTextContent('Describe what happened in at least 10 characters.');
    expect(screen.getByRole('textbox', { name: /What went wrong/ })).toHaveAttribute('aria-invalid', 'true');
    await user.click(within(summary).getByRole('button', { name: /Describe what happened/ }));
    expect(screen.getByRole('textbox', { name: /What happened/ })).toHaveFocus();
    expect(FakeXhr.last).toBeNull();
  });

  it('checks files in the browser against the server rules, with kind messages', async () => {
    const user = userEvent.setup();
    routes(get('/portal/api/limits', LIMITS));
    renderPortal('/portal/new', REQUESTER);
    await screen.findByRole('button', { name: 'Send request' });
    const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
    expect(input.accept).toContain('image/png');
    await user.upload(input, [
      new File([PNG], 'screen.png', { type: 'image/png' }),
      new File([PDF], 'disguised.png', { type: 'image/png' }),
      new File([PNG, new Uint8Array(2000)], 'huge.png', { type: 'image/png' }),
    ]);
    const list = await screen.findByRole('list', { name: 'Attached files' });
    await waitFor(() => expect(within(list).getAllByText('Ready to send')).toHaveLength(1));
    expect(list).toHaveTextContent('This file’s content doesn’t match its type, so we can’t accept it.');
    expect(list).toHaveTextContent('This image is 2 KB. Images can be up to 1 KB.');
    expect(screen.getByText('3 of 3 files · 2 KB')).toBeInTheDocument();
    // The limit is enforced as files are added.
    await user.upload(input, new File([PNG], 'fourth.png', { type: 'image/png' }));
    expect(await screen.findByText(/You can attach up to 3 files, so “fourth.png” was not added\./)).toBeInTheDocument();

    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Remove or replace the files marked below.');
    expect(FakeXhr.last).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove disguised.png' }));
    await user.click(screen.getByRole('button', { name: 'Remove huge.png' }));
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });

  it('uploads with progress, then opens the new request', async () => {
    const user = userEvent.setup();
    routes(get('/portal/api/limits', LIMITS), get('/portal/api/tickets/tkt_new', ticket({ ticketId: 'tkt_new', status: 'received', title: 'Claim form goes blank' })));
    renderPortal('/portal/new', REQUESTER);
    await fillForm(user);
    await user.click(screen.getByRole('radio', { name: /Critical/ }));
    await user.type(screen.getByRole('textbox', { name: /Anything else/ }), 'Since Monday.');
    await user.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, new File([PNG], 'screen.png', { type: 'image/png' }));
    await screen.findByText('Ready to send');
    await user.click(screen.getByRole('button', { name: 'Send request' }));

    const xhr = FakeXhr.last!;
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/portal/api/intakes');
    expect(xhr.headers).toMatchObject({ 'X-Requested-With': 'aoc-web', Accept: 'application/json' });
    expect(xhr.body!.get('title')).toBe('Claim form goes blank');
    expect(xhr.body!.get('severity')).toBe('critical');
    expect(xhr.body!.get('comment')).toBe('Since Monday.');
    expect((xhr.body!.getAll('files') as File[]).map((f) => f.name)).toEqual(['screen.png']);

    act(() => xhr.progress(512, 1024));
    const bar = screen.getByRole('progressbar', { name: 'Sending your request' });
    expect(bar).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByText('Sending your request…')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /What went wrong/ })).toBeDisabled();
    act(() => xhr.progress(1024, 1024));
    expect(screen.getByText('Checking your files…')).toBeInTheDocument();
    act(() => xhr.respond(201, ticket({ ticketId: 'tkt_new', status: 'received' })));

    expect(await screen.findByText('Thanks — we have your request')).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/portal/tickets/tkt_new');
    expect(window.sessionStorage.getItem('aoc.portal.draft')).toBeNull();
  });

  it('turns a server refusal into a kind message on the file it names, keeping the form', async () => {
    const user = userEvent.setup();
    routes(get('/portal/api/limits', LIMITS));
    renderPortal('/portal/new', REQUESTER);
    await fillForm(user);
    await user.upload(document.querySelector<HTMLInputElement>('input[type=file]')!, new File([PNG], 'Screen Shot.png', { type: 'image/png' }));
    await screen.findByText('Ready to send');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    act(() => FakeXhr.last!.respond(422, { error: { code: 'rejected', message: 'Screen Shot.png was rejected by the malware scanner' } }));

    const summary = await screen.findByRole('alert');
    expect(summary).toHaveTextContent('Your request wasn’t sent');
    expect(summary).toHaveTextContent('“Screen Shot.png” didn’t pass our safety check');
    const item = within(screen.getByRole('list', { name: 'Attached files' })).getByRole('listitem');
    expect(item).toHaveTextContent('didn’t pass our safety check');
    expect(screen.getByRole('textbox', { name: /What went wrong/ })).toHaveValue('Claim form goes blank');
    expect(document.body.textContent).not.toMatch(INTERNAL_TERMS);
  });

  it('cancels an upload without filing anything and keeps the draft in this tab', async () => {
    const user = userEvent.setup();
    routes(get('/portal/api/limits', LIMITS));
    const { unmount } = renderPortal('/portal/new', REQUESTER);
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    act(() => FakeXhr.last!.progress(10, 100));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(FakeXhr.last!.aborted).toBe(true);
    expect(await screen.findByRole('alert')).toHaveTextContent('Sending was cancelled. Nothing was sent');
    unmount();
    renderPortal('/portal/new', REQUESTER);
    expect(await screen.findByRole('textbox', { name: /What went wrong/ })).toHaveValue('Claim form goes blank');
  });
});
