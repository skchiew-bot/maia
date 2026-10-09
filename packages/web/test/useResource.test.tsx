import { act, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EventStreamProvider,
  backoffDelay,
  matchesFilter,
  useEventStream,
  useResource,
  useStreamStatus,
  type StreamMessage,
} from '../src/api';
import { FakeEventSource, FakeEventSourceCtor, jsonResponse, mockFetch } from './helpers';

const isThingEvent = (m: StreamMessage) => m.kind === 'aoc' && m.event.type.startsWith('thing.');

function Things({ path = '/api/things' }: { path?: string }) {
  const res = useResource<{ version: number; path: string }>(path, { refreshOn: isThingEvent });
  return (
    <p data-testid="out">
      {res.data ? `${res.data.path} v${res.data.version}` : 'none'}
      {res.loading ? ' loading' : ''}
    </p>
  );
}

function aoc(type: string, seq = 1) {
  return { seq, type, ts: '2026-10-08T06:05:00Z', scope: { sessionId: 's1' }, meta: {} };
}

describe('useResource', () => {
  let version = 0;
  let fetchMock: ReturnType<typeof mockFetch>;

  beforeEach(() => {
    FakeEventSource.reset();
    version = 0;
    fetchMock = mockFetch((url) => {
      version += 1;
      return jsonResponse({ version, path: new URL(url, 'http://x').pathname });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mount(ui = <Things />) {
    return render(<EventStreamProvider eventSource={FakeEventSourceCtor}>{ui}</EventStreamProvider>);
  }

  it('fetches once on mount with cookie credentials', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('out')).toHaveTextContent('/api/things v1'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/things');
    expect(init).toMatchObject({ method: 'GET', credentials: 'include' });
  });

  it('refetches when a matching stream event arrives — and only then', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('out')).toHaveTextContent('v1'));
    const es = FakeEventSource.last;
    act(() => es.open());

    act(() => es.emit('aoc', aoc('other.changed')));
    act(() => es.emit('liveness', { sessionId: 's1', state: 'working', since: '2026-10-08T06:00:00Z' }));
    await new Promise((r) => setTimeout(r, 200));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    act(() => es.emit('aoc', aoc('thing.updated', 2)));
    await waitFor(() => expect(screen.getByTestId('out')).toHaveTextContent('v2'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces a burst of matching events into one refetch', async () => {
    mount();
    await waitFor(() => expect(screen.getByTestId('out')).toHaveTextContent('v1'));
    const es = FakeEventSource.last;
    act(() => {
      es.open();
      for (let i = 0; i < 5; i += 1) es.emit('aoc', aoc('thing.updated', 10 + i));
    });
    await waitFor(() => expect(screen.getByTestId('out')).toHaveTextContent('v2'));
    await new Promise((r) => setTimeout(r, 200));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps showing the previous data while refetching (no flash)', async () => {
    let release: (() => void) | undefined;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      version += 1;
      const v = version;
      if (v === 2) await new Promise<void>((r) => (release = r));
      return jsonResponse({ version: v, path: String(input) });
    });
    mount();
    await waitFor(() => expect(screen.getByTestId('out')).toHaveTextContent('v1'));
    const es = FakeEventSource.last;
    act(() => es.emit('aoc', aoc('thing.created')));
    await waitFor(() => expect(screen.getByTestId('out')).toHaveTextContent('/api/things v1 loading'));
    act(() => release?.());
    await waitFor(() => expect(screen.getByTestId('out')).toHaveTextContent('/api/things v2'));
  });

  it('refetches after the stream reconnects, because events may have been missed', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mount();
    await waitFor(() => expect(screen.getByTestId('out')).toHaveTextContent('v1'));
    const first = FakeEventSource.last;
    act(() => first.open());
    act(() => first.fail());
    expect(first.closed).toBe(true);
    // backoff (0.8s with random()=0), then a fresh EventSource
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2), { timeout: 2000 });
    act(() => FakeEventSource.last.open());
    await waitFor(() => expect(screen.getByTestId('out')).toHaveTextContent('v2'));
  });

  it('never shows one resource while another loads', async () => {
    function Switcher() {
      const [path, setPath] = useState('/api/things/1');
      return (
        <>
          <button type="button" onClick={() => setPath('/api/things/2')}>
            next
          </button>
          <Things path={path} />
        </>
      );
    }
    let release: (() => void) | undefined;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      version += 1;
      const v = version;
      if (String(input).endsWith('/2')) await new Promise<void>((r) => (release = r));
      return jsonResponse({ version: v, path: String(input) });
    });
    mount(<Switcher />);
    await waitFor(() => expect(screen.getByTestId('out')).toHaveTextContent('/api/things/1 v1'));
    act(() => screen.getByRole('button', { name: 'next' }).click());
    await waitFor(() => expect(screen.getByTestId('out')).toHaveTextContent('none loading'));
    act(() => release?.());
    await waitFor(() => expect(screen.getByTestId('out')).toHaveTextContent('/api/things/2 v2'));
  });

  it('reports errors and recovers on reload', async () => {
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ error: { code: 'boom', message: 'Exploded' } }, { status: 500 }),
    );
    function WithError() {
      const res = useResource<{ version: number }>('/api/things');
      return (
        <>
          <p data-testid="err">{res.error instanceof Error ? res.error.message : 'ok'}</p>
          <button type="button" onClick={res.reload}>
            reload
          </button>
        </>
      );
    }
    mount(<WithError />);
    await waitFor(() => expect(screen.getByTestId('err')).toHaveTextContent('Exploded'));
    act(() => screen.getByRole('button', { name: 'reload' }).click());
    await waitFor(() => expect(screen.getByTestId('err')).toHaveTextContent('ok'));
  });
});

describe('event stream', () => {
  beforeEach(() => FakeEventSource.reset());
  afterEach(() => vi.restoreAllMocks());

  it('connects with credentials and reports connecting → live → reconnecting → live', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    function Status() {
      return <p data-testid="status">{useStreamStatus()}</p>;
    }
    render(
      <EventStreamProvider eventSource={FakeEventSourceCtor}>
        <Status />
      </EventStreamProvider>,
    );
    const es = FakeEventSource.last;
    expect(es.url).toBe('/api/stream');
    expect(es.withCredentials).toBe(true);
    expect(screen.getByTestId('status')).toHaveTextContent('connecting');
    act(() => es.open());
    expect(screen.getByTestId('status')).toHaveTextContent('live');
    act(() => es.fail());
    expect(screen.getByTestId('status')).toHaveTextContent('reconnecting');
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2), { timeout: 2000 });
    act(() => FakeEventSource.last.open());
    expect(screen.getByTestId('status')).toHaveTextContent('live');
  });

  it('delivers parsed aoc and liveness events to filtered subscribers, ignoring malformed data', () => {
    const seen: StreamMessage[] = [];
    function Sub() {
      useEventStream((m) => seen.push(m), { kind: 'liveness', sessionId: 's1' });
      return null;
    }
    render(
      <EventStreamProvider eventSource={FakeEventSourceCtor}>
        <Sub />
      </EventStreamProvider>,
    );
    const es = FakeEventSource.last;
    act(() => {
      es.open();
      es.emit('liveness', { sessionId: 's2', state: 'stalled', since: 'x' });
      es.emit('liveness', { sessionId: 's1', state: 'not-a-state', since: 'x' });
      es.emit('liveness', 'not json');
      es.emit('aoc', aoc('thing.updated'));
      es.emit('liveness', {
        sessionId: 's1',
        state: 'waiting_on_you',
        reason: 'decision',
        since: '2026-10-08T06:00:00Z',
      });
    });
    expect(seen).toEqual([
      {
        kind: 'liveness',
        event: {
          sessionId: 's1',
          state: 'waiting_on_you',
          reason: 'decision',
          since: '2026-10-08T06:00:00Z',
        },
      },
    ]);
  });

  it('matches type patterns and session scope', () => {
    const msg: StreamMessage = { kind: 'aoc', event: aoc('decision.requested') };
    expect(matchesFilter({ type: 'decision.*' }, msg)).toBe(true);
    expect(matchesFilter({ type: ['task.done', 'decision.requested'] }, msg)).toBe(true);
    expect(matchesFilter({ type: 'decision.resolved' }, msg)).toBe(false);
    expect(matchesFilter({ sessionId: 's1' }, msg)).toBe(true);
    expect(matchesFilter({ sessionId: 's9' }, msg)).toBe(false);
    expect(matchesFilter({ kind: 'liveness' }, msg)).toBe(false);
    expect(matchesFilter((m) => m.kind === 'aoc', msg)).toBe(true);
  });

  it('backs off exponentially with jitter, capped at 30s', () => {
    const mid = () => 0.5; // no jitter
    expect([0, 1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, 1000, 30_000, mid))).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
    expect(backoffDelay(0, 1000, 30_000, () => 0)).toBe(800);
    expect(backoffDelay(0, 1000, 30_000, () => 0.999)).toBe(1200);
  });

  it('is a no-op outside a provider (requester portal)', () => {
    const handler = vi.fn();
    function Sub() {
      useEventStream(handler);
      return <p data-testid="status">{useStreamStatus()}</p>;
    }
    render(<Sub />);
    expect(screen.getByTestId('status')).toHaveTextContent('offline');
    expect(handler).not.toHaveBeenCalled();
  });
});
