import { vi } from 'vitest';

type Listener = (e: MessageEvent<string>) => void;

/** In-memory EventSource: tests drive open / named events / errors explicitly. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readonly withCredentials: boolean;
  readyState = 0;
  closed = false;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = Boolean(init?.withCredentials);
    FakeEventSource.instances.push(this);
  }

  static get last(): FakeEventSource {
    const es = FakeEventSource.instances[FakeEventSource.instances.length - 1];
    if (!es) throw new Error('no EventSource created');
    return es;
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }

  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }

  /** Simulates the connection opening. */
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  /** Simulates a named server event (`event: <type>` + JSON `data:`). */
  emit(type: string, data: unknown): void {
    const e = new MessageEvent<string>(type, {
      data: typeof data === 'string' ? data : JSON.stringify(data),
    });
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }

  /** Simulates a dropped connection. */
  fail(): void {
    this.readyState = 0;
    this.onerror?.(new Event('error'));
  }
}

/** The fake, typed as the browser constructor for injection. */
export const FakeEventSourceCtor = FakeEventSource as unknown as typeof EventSource;

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

/** Installs a fetch mock; `handler` maps a request to a Response. */
export function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Sets `matchMedia` so `prefers-reduced-motion: reduce` matches (or not). Returns a restore function. */
export function stubReducedMotion(reduce: boolean): () => void {
  const previous = window.matchMedia;
  window.matchMedia = vi.fn((query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = previous;
  };
}
