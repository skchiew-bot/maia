import type { Context } from 'hono';
import {
  EventStore,
  requirePermission,
  type AocRuntime,
  type AppEnv,
  type BroadcastMessage,
} from '@aoc/kernel';

export interface StreamOptions {
  /** Comment heartbeat interval (keeps proxies from timing out idle streams). */
  heartbeatMs?: number;
  /** Client reconnect delay advertised with `retry:`. */
  retryMs?: number;
  /** Most event headers replayed after a reconnect; a larger gap gets `event: resync` instead. */
  replayLimit?: number;
  /** Bytes queued for a client that is not reading before it is dropped (it reconnects and replays). */
  maxBufferedBytes?: number;
}

export interface StreamHub {
  handle(c: Context<AppEnv>): Response;
  /** End every open stream (shutdown). */
  closeAll(): void;
  readonly size: number;
}

const encoder = new TextEncoder();
const STREAM_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
};

/** `aoc` frames carry the event seq as their id so `Last-Event-ID` resumes exactly; other kinds have no id. */
export function sseFrame(m: BroadcastMessage): string {
  const id = m.event === 'aoc' ? `id: ${m.data.seq}\n` : '';
  return `${id}event: ${m.event}\ndata: ${JSON.stringify(m.data)}\n\n`;
}

/**
 * `GET /api/stream` for operators (requesters are refused: the stream is internal). On connect:
 * `retry:`, then either the missed headers after `Last-Event-ID` (≤ replayLimit), an `event: resync`
 * when the gap is larger or the id is ahead of this chain, or a bare `id: <head>` that sets the
 * resume cursor. Then live broadcaster messages and a comment heartbeat.
 */
export function createStreamHub(runtime: AocRuntime, opts: StreamOptions = {}): StreamHub {
  const heartbeatMs = opts.heartbeatMs ?? 15_000;
  const retryMs = opts.retryMs ?? 3000;
  const replayLimit = opts.replayLimit ?? 1000;
  const maxBufferedBytes = opts.maxBufferedBytes ?? 1024 * 1024;
  const open = new Set<() => void>();

  const handle = (c: Context<AppEnv>): Response => {
    const auth = requirePermission(c, 'session.view');
    // Hono answers HEAD by running the GET handler and dropping the body unread: never open a stream for it.
    if (c.req.method === 'HEAD') return new Response(null, { headers: STREAM_HEADERS });
    const lastId = parseEventId(c.req.header('last-event-id') ?? c.req.query('lastEventId'));
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          let done = false;
          let unsubscribe = () => {};
          let timer: NodeJS.Timeout | undefined;
          const stop = () => {
            if (done) return;
            cleanup();
            controller.close();
          };
          cleanup = () => {
            if (done) return;
            done = true;
            clearInterval(timer);
            unsubscribe();
            open.delete(stop);
          };
          const write = (text: string) => {
            if (done) return;
            if ((controller.desiredSize ?? 0) <= 0) {
              cleanup();
              controller.error(new Error('event stream client is not reading'));
              return;
            }
            controller.enqueue(encoder.encode(text));
          };

          // Appends are synchronous on this thread, so reading the replay and subscribing in one
          // synchronous block cannot miss or duplicate an event.
          const head = runtime.store.head().seq;
          let initial = `retry: ${retryMs}\n\n`;
          if (lastId !== null && (lastId > head || head - lastId > replayLimit)) {
            initial += `id: ${head}\nevent: resync\ndata: ${JSON.stringify({ lastEventId: lastId, headSeq: head })}\n\n`;
          } else if (lastId !== null && lastId < head) {
            for (const e of runtime.store.list({ fromSeq: lastId + 1, toSeq: head, limit: replayLimit })) {
              initial += sseFrame({ event: 'aoc', data: EventStore.headerOf(e) });
            }
          } else {
            initial += `id: ${head}\n\n`;
          }
          let lastSeq = head;
          write(initial);
          unsubscribe = runtime.broadcaster.subscribe({
            role: auth.user.role,
            send(m) {
              if (m.event === 'aoc') {
                if (m.data.seq <= lastSeq) return;
                lastSeq = m.data.seq;
              }
              write(sseFrame(m));
            },
          });
          timer = setInterval(() => write(': ping\n\n'), heartbeatMs);
          timer.unref();
          open.add(stop);
          c.req.raw.signal.addEventListener('abort', () => cleanup(), { once: true });
        },
        cancel() {
          cleanup();
        },
      },
      { highWaterMark: maxBufferedBytes, size: (chunk) => chunk.byteLength },
    );
    return new Response(body, { headers: STREAM_HEADERS });
  };

  return {
    handle,
    closeAll() {
      for (const stop of [...open]) stop();
    },
    get size() {
      return open.size;
    },
  };
}

function parseEventId(v: string | undefined): number | null {
  return v !== undefined && /^\d{1,15}$/.test(v.trim()) ? Number(v.trim()) : null;
}
