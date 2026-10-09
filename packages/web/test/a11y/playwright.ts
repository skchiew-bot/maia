import { createRequire } from 'node:module';

/**
 * The slice of Playwright's API the a11y harness uses. Playwright is not a dependency of this repo: it is
 * loaded from $AOC_PLAYWRIGHT, a local install, or the machine-wide install (never `playwright install`).
 */
export interface Browser {
  version(): string;
  newContext(options: ContextOptions): Promise<BrowserContext>;
  close(): Promise<void>;
}

export interface ContextOptions {
  viewport: { width: number; height: number };
  colorScheme: 'light' | 'dark';
  reducedMotion?: 'reduce' | 'no-preference';
  deviceScaleFactor?: number;
  storageState?: StorageState;
  baseURL?: string;
}

export type StorageState = { cookies: unknown[]; origins: unknown[] };

export interface BrowserContext {
  newPage(): Promise<Page>;
  storageState(): Promise<StorageState>;
  request: { post(url: string, options: { data: unknown }): Promise<ApiResponse> };
  close(): Promise<void>;
}

export interface ApiResponse {
  status(): number;
  text(): Promise<string>;
}

export interface Request {
  url(): string;
  method(): string;
  resourceType(): string;
  failure(): { errorText: string } | null;
}

export interface Response {
  url(): string;
  status(): number;
  request(): Request;
}

export interface ConsoleMessage {
  type(): string;
  text(): string;
}

export interface Page {
  goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded'; timeout?: number }): Promise<unknown>;
  url(): string;
  evaluate<T>(expression: string): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  emulateMedia(options: { reducedMotion?: 'reduce' | 'no-preference' }): Promise<void>;
  screenshot(options: { clip: { x: number; y: number; width: number; height: number } }): Promise<Buffer>;
  keyboard: { press(key: string): Promise<void> };
  on(event: 'console', fn: (m: ConsoleMessage) => void): void;
  on(event: 'pageerror', fn: (e: Error) => void): void;
  on(event: 'request' | 'requestfinished' | 'requestfailed', fn: (r: Request) => void): void;
  on(event: 'response', fn: (r: Response) => void): void;
  close(): Promise<void>;
}

export interface Chromium {
  launch(options?: { headless?: boolean }): Promise<Browser>;
}

const GLOBAL_INSTALL = '/opt/node22/lib/node_modules/playwright';

export function loadChromium(): Chromium {
  const require = createRequire(import.meta.url);
  const candidates = [process.env.AOC_PLAYWRIGHT, 'playwright', GLOBAL_INSTALL].filter(
    (c): c is string => Boolean(c),
  );
  for (const id of candidates) {
    try {
      return (require(id) as { chromium: Chromium }).chromium;
    } catch {
      // try the next location
    }
  }
  throw new Error(
    `Playwright not found (tried ${candidates.join(', ')}). Set AOC_PLAYWRIGHT to its install directory.`,
  );
}
