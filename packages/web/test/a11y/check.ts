/**
 * Accessibility and UI quality gate against the real app (G-32, §12).
 *
 *   pnpm --filter @aoc/web a11y [-- --no-seed] [--no-build] [--routes /tower,/console] [--roles approver]
 *                                  [--variants "1440 light,360 dark"] [--concurrency 4] [--port 7530]
 *
 * Seeds the demo data (`@aoc/demo seed --reset`), builds the UI, starts aocd from source with the seeded
 * AOC_CONFIG (managed sessions run on claude-sim), signs in as each role and visits every route in
 * src/routes.tsx at 1440 and 360 px in light and dark. Writes test/a11y/report.md (and the raw results to
 * <data dir>/a11y-results.json) and exits 1 when any gate fails. Stops only the daemon it started.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { loadChromium, type Browser, type Page, type Request, type StorageState } from './playwright';
import type { Animations, ChartInfo, FocusInfo, Overflow, PrimaryAction } from './probe';
import { renderReport } from './report';
import {
  issuesOf,
  ROLES,
  VARIANTS,
  type AxeViolation,
  type Keyboard,
  type PageResult,
  type Role,
  type RoutingCheck,
  type RunResult,
  type Variant,
} from './results';
import { readRoutes, type RouteEntry } from './routes';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = resolve(HERE, '../..');
const REPO = resolve(WEB, '../..');
const require = createRequire(join(WEB, 'package.json'));

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const MAX_TABS = 120;
const SETTLE_TIMEOUT_MS = 10_000;
const MISSING_ID = 'a11y-missing-id';
const NO_SUCH_PAGE = 'a11y-no-such-page';
/** Where each role lands on `/` (§6, mock: Approvers watch the Control Tower, Builders the Console). */
const LANDING: Partial<Record<Role, string>> = { approver: '/tower', builder: '/console' };

interface Options {
  dataDir: string;
  port: number;
  seed: boolean;
  build: boolean;
  concurrency: number;
  routes: string[] | null;
  roles: Role[] | null;
  variants: string[] | null;
  out: string;
}

function parseArgs(argv: readonly string[]): Options {
  const args = argv.filter((a) => a !== '--');
  const value = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const list = (name: string) => value(name)?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
  const roles = list('roles');
  const bad = roles?.filter((r) => !(ROLES as readonly string[]).includes(r));
  if (bad?.length) throw new Error(`unknown role(s): ${bad.join(', ')}`);
  return {
    dataDir: resolve(value('data-dir') ?? '/tmp/aoc-a11y'),
    port: Number(value('port') ?? 7530),
    seed: !args.includes('--no-seed'),
    build: !args.includes('--no-build'),
    concurrency: Math.max(1, Number(value('concurrency') ?? 4)),
    routes: list('routes'),
    roles: roles as Role[] | null,
    variants: list('variants'),
    out: resolve(value('out') ?? join(HERE, 'report.md')),
  };
}

function run(cmd: string, args: readonly string[], cwd: string, what: string): void {
  console.log(`> ${what}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${what} failed (${r.signal ?? `exit ${r.status}`})`);
}

// ── daemon: started here, stopped here, by PID only ──────────────────────────
interface Daemon {
  child: ChildProcess;
  log: string;
}

async function portAnswers(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

async function startDaemon(opts: Options): Promise<Daemon> {
  if (await portAnswers(opts.port))
    throw new Error(`port ${opts.port} is already in use; stop that process yourself or pass --port`);
  const log = join(opts.dataDir, 'a11y-daemon.log');
  const out = createWriteStream(log);
  const child = spawn(process.execPath, ['--import', 'tsx', 'packages/daemon/src/main.ts'], {
    cwd: REPO,
    env: {
      ...process.env,
      AOC_CONFIG: join(opts.dataDir, 'aoc.config.json'),
      AOC_PORT: String(opts.port),
      AOC_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  console.log(`> aocd started (pid ${child.pid}) on port ${opts.port}; log ${log}`);
  const daemon = { child, log };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`aocd exited with ${child.exitCode}; see ${log}`);
    try {
      const res = await fetch(`http://127.0.0.1:${opts.port}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return daemon;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  await stopDaemon(daemon);
  throw new Error(`aocd did not become healthy within 60 s; see ${log}`);
}

/** PIDs of a process's descendants (Linux /proc), so session processes the daemon spawned are stopped too. */
function descendants(pid: number): number[] {
  if (!existsSync('/proc')) return [];
  const children = new Map<number, number[]>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      children.set(ppid, [...(children.get(ppid) ?? []), Number(entry)]);
    } catch {
      // process exited while listing
    }
  }
  const out: number[] = [];
  const queue = [pid];
  while (queue.length) {
    for (const c of children.get(queue.shift()!) ?? []) {
      out.push(c);
      queue.push(c);
    }
  }
  return out;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function stopDaemon(d: Daemon): Promise<void> {
  const pid = d.child.pid;
  if (pid === undefined || d.child.exitCode !== null) return;
  const spawned = descendants(pid);
  d.child.kill('SIGTERM');
  const deadline = Date.now() + 8000;
  while (d.child.exitCode === null && d.child.signalCode === null && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 100));
  if (d.child.exitCode === null && d.child.signalCode === null) d.child.kill('SIGKILL');
  for (const c of spawned) if (alive(c)) process.kill(c, 'SIGTERM');
  console.log(`> aocd stopped (pid ${pid}${spawned.length ? `, plus ${spawned.length} process(es) it started` : ''})`);
}

// ── data the visits need ─────────────────────────────────────────────────────
interface DemoTokens {
  tokens: Record<string, { role: string; token: string }>;
  live?: Record<string, { sessionId: string }>;
}

function bearer(demo: DemoTokens, role: Role): string | null {
  return Object.values(demo.tokens).find((t) => t.role === role)?.token ?? null;
}

/** First record id in a list response (`[...]`, `{items: [...]}`, `{sessions: [...]}`, ...). */
function firstId(json: unknown, keys: readonly string[]): string | null {
  const list = Array.isArray(json)
    ? json
    : json && typeof json === 'object'
      ? Object.values(json).find((v): v is unknown[] => Array.isArray(v) && v.some((x) => x && typeof x === 'object'))
      : undefined;
  for (const item of list ?? []) {
    if (!item || typeof item !== 'object') continue;
    for (const k of keys) {
      const v = (item as Record<string, unknown>)[k];
      if (typeof v === 'string' && v) return v;
    }
  }
  return null;
}

async function urlFor(
  base: string,
  route: RouteEntry,
  role: Role,
  demo: DemoTokens,
): Promise<{ url: string; placeholder: boolean }> {
  if (route.path.endsWith('*')) return { url: route.path.replace(/\*$/, NO_SUCH_PAGE), placeholder: false };
  const param = route.path.indexOf('/:');
  if (param < 0) return { url: route.path, placeholder: false };
  const prefix = route.path.slice(0, param);
  const preferred = prefix === '/sessions' ? demo.live?.waiting?.sessionId : undefined;
  let id = preferred ?? null;
  const token = bearer(demo, role);
  if (!id && token) {
    const endpoint = prefix.startsWith('/portal/') ? `/portal/api${prefix.slice('/portal'.length)}` : `/api${prefix}`;
    const singular = prefix.split('/').pop()!.replace(/s$/, '');
    try {
      const res = await fetch(base + endpoint, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) id = firstId(await res.json(), [`${singular}Id`, 'id']);
    } catch {
      // no list endpoint: fall through to the placeholder
    }
  }
  return id
    ? { url: `${prefix}/${encodeURIComponent(id)}`, placeholder: false }
    : { url: `${prefix}/${MISSING_ID}`, placeholder: true };
}

function visibleTo(route: RouteEntry, role: Role): boolean {
  if (route.component === null) return false;
  if (role === 'anonymous') return route.roles === null;
  if (role === 'requester') return route.surface === 'portal' && route.roles !== null;
  return route.surface === 'operator';
}

// ── one page ─────────────────────────────────────────────────────────────────
interface Net {
  inflight: Set<Request>;
  lastChange: number;
  failed: string[];
  expected: string[];
}

function track(page: Page, role: Role): Net {
  const net: Net = { inflight: new Set(), lastChange: Date.now(), failed: [], expected: [] };
  const path = (url: string) => {
    const u = new URL(url);
    return u.pathname + u.search;
  };
  page.on('request', (r) => {
    if (r.resourceType() === 'eventsource') return;
    net.inflight.add(r);
    net.lastChange = Date.now();
  });
  page.on('requestfinished', (r) => {
    if (net.inflight.delete(r)) net.lastChange = Date.now();
  });
  page.on('requestfailed', (r) => {
    if (net.inflight.delete(r)) net.lastChange = Date.now();
    const error = r.failure()?.errorText ?? 'failed';
    if (!error.includes('ERR_ABORTED')) net.failed.push(`${r.method()} ${path(r.url())}: ${error}`);
  });
  page.on('response', (res) => {
    if (res.status() < 400) return;
    const p = path(res.url());
    const line = `${res.request().method()} ${p} → ${res.status()}`;
    const expected =
      (res.status() === 404 && p.includes(MISSING_ID)) ||
      (role === 'anonymous' && res.status() === 401 && p === '/api/auth/me');
    (expected ? net.expected : net.failed).push(line);
  });
  return net;
}

/** Waits until no request is in flight for 400 ms and no `.aoc-loading` placeholder is on screen. */
async function settle(page: Page, net: Net): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < SETTLE_TIMEOUT_MS) {
    if (net.inflight.size === 0 && Date.now() - net.lastChange >= 400) {
      if (!(await page.evaluate<boolean>(`!!document.querySelector('.aoc-loading')`))) return true;
    }
    await page.waitForTimeout(100);
  }
  return false;
}

async function runAxe(page: Page, axeSource: string): Promise<AxeViolation[]> {
  await page.evaluate(axeSource);
  return page.evaluate<AxeViolation[]>(`(async () => {
    const r = await axe.run(document, {
      runOnly: { type: 'tag', values: ${JSON.stringify(AXE_TAGS)} },
      resultTypes: ['violations'],
    });
    return r.violations.map((v) => {
      const owners = __aocProbe.owners(v.nodes.map((n) => String(n.target[n.target.length - 1])));
      return {
        id: v.id,
        impact: v.impact || null,
        help: v.help,
        helpUrl: v.helpUrl,
        nodes: v.nodes.map((n, i) => ({
          target: n.target.join(' '),
          summary: (n.failureSummary || '').split('\\n').map((s) => s.trim()).filter(Boolean).slice(0, 3).join(' '),
          owner: owners[i],
        })),
      };
    });
  })()`);
}

async function keyboardWalk(page: Page, viewport: Variant): Promise<Keyboard> {
  const primary = await page.evaluate<PrimaryAction>('__aocProbe.markPrimaryAction()');
  const k: Keyboard = {
    primary,
    tabs: 0,
    reached: false,
    ended: null,
    skipLinkFirst: false,
    skipLinkWorks: null,
    invisible: [],
    offscreen: [],
  };
  for (let i = 1; i <= MAX_TABS; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate<FocusInfo | null>('__aocProbe.focusInfo()');
    k.tabs = i;
    if (!info) {
      k.ended = 'end of tab order';
      break;
    }
    if (info.revisit) {
      k.ended = 'focus cycled';
      break;
    }
    if (i === 1) k.skipLinkFirst = info.isSkipLink;
    const stop = { selector: info.label ? `${info.selector} "${info.label}"` : info.selector, owner: info.owner };
    const r = info.rect;
    const onScreen = r.x + r.width > 0 && r.y + r.height > 0 && r.x < viewport.width && r.y < viewport.height;
    if (!onScreen) k.offscreen.push(stop);
    else if (!info.indicator && !(await focusChangesPixels(page, info, viewport))) k.invisible.push(stop);
    if (info.isPrimary) {
      k.reached = true;
      break;
    }
    if (i === MAX_TABS) k.ended = 'limit';
  }
  if (await page.evaluate<boolean>('__aocProbe.focusSkipLink()')) {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(50);
    if (await page.evaluate<boolean>('__aocProbe.focusInSkipTarget()')) k.skipLinkWorks = true;
    else if (await page.evaluate<boolean>('__aocProbe.skipTargetHasFocusable()')) {
      // Browsers move the sequential focus start point to a non-focusable target: the next Tab lands inside.
      await page.keyboard.press('Tab');
      k.skipLinkWorks = await page.evaluate<boolean>('__aocProbe.focusInSkipTarget()');
    }
  }
  return k;
}

/** Compares the focused element's pixels with and without focus (Tab continues from a blurred element). */
async function focusChangesPixels(page: Page, info: FocusInfo, viewport: Variant): Promise<boolean> {
  const pad = 5;
  const x = Math.max(0, Math.floor(info.rect.x - pad));
  const y = Math.max(0, Math.floor(info.rect.y - pad));
  const width = Math.min(viewport.width, Math.ceil(info.rect.x + info.rect.width + pad)) - x;
  const height = Math.min(viewport.height, Math.ceil(info.rect.y + info.rect.height + pad)) - y;
  if (width < 2 || height < 2) return true;
  const focused = await page.screenshot({ clip: { x, y, width, height } });
  await page.evaluate('document.activeElement && document.activeElement.blur()');
  const blurred = await page.screenshot({ clip: { x, y, width, height } });
  return !focused.equals(blurred);
}

interface Visit {
  route: RouteEntry;
  role: Role;
  url: string;
  placeholder: boolean;
}

interface Shared {
  browser: Browser;
  base: string;
  storage: Partial<Record<Role, StorageState>>;
  axeSource: string;
  probeSource: string;
}

async function scan(s: Shared, visit: Visit, variant: Variant): Promise<PageResult> {
  const result: PageResult = {
    route: visit.route.path,
    url: visit.url,
    finalPath: visit.url,
    role: visit.role,
    variant: variant.id,
    file: visit.route.file,
    placeholder: visit.placeholder,
    settled: false,
    loadMs: 0,
    axe: [],
    overflow: null,
    animations: null,
    charts: [],
    keyboard: null,
    consoleErrors: [],
    failedRequests: [],
    expectedFailures: [],
    error: null,
  };
  const ctx = await s.browser.newContext({
    viewport: { width: variant.width, height: variant.height },
    colorScheme: variant.scheme,
    reducedMotion: 'no-preference',
    deviceScaleFactor: 1,
    storageState: s.storage[visit.role],
  });
  try {
    const page = await ctx.newPage();
    const net = track(page, visit.role);
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) result.consoleErrors.push(m.text());
    });
    page.on('pageerror', (e) => result.consoleErrors.push(`uncaught: ${e.message}`));
    const t0 = Date.now();
    await page.goto(s.base + visit.url, { waitUntil: 'load', timeout: 30_000 });
    result.settled = await settle(page, net);
    result.loadMs = Date.now() - t0;
    result.finalPath = new URL(page.url()).pathname;
    await page.evaluate(s.probeSource);
    result.overflow = await page.evaluate<Overflow>('__aocProbe.overflow()');
    result.animations = await page.evaluate<Animations>('__aocProbe.animations()');
    result.charts = await page.evaluate<ChartInfo[]>('__aocProbe.charts()');
    result.axe = await runAxe(page, s.axeSource);
    // Keyboard checks compare pixels, so transitions must not be mid-flight.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    result.keyboard = await keyboardWalk(page, variant);
    result.failedRequests = net.failed;
    result.expectedFailures = net.expected;
  } catch (err) {
    result.error = (err as Error).message.split('\n')[0] ?? String(err);
  } finally {
    await ctx.close();
  }
  return result;
}

async function routeCheck(s: Shared, role: Role, path: string, expected: string): Promise<RoutingCheck> {
  const ctx = await s.browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'light',
    storageState: s.storage[role],
  });
  try {
    const page = await ctx.newPage();
    const net = track(page, role);
    await page.goto(s.base + path, { waitUntil: 'load', timeout: 30_000 });
    await settle(page, net);
    const actual = new URL(page.url()).pathname;
    return { role, path, expected, actual, ok: actual === expected };
  } finally {
    await ctx.close();
  }
}

async function pool<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
      done++;
      if (done % 20 === 0 || done === items.length) console.log(`  ${done}/${items.length} page visits`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

function git(args: string[]): string {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  if (opts.seed)
    run('pnpm', ['--filter', '@aoc/demo', 'seed', '--', '--data-dir', opts.dataDir, '--reset'], REPO, 'seed demo data');
  if (!existsSync(join(opts.dataDir, 'demo-tokens.json')))
    throw new Error(`${opts.dataDir} has no demo-tokens.json; run without --no-seed`);
  if (opts.build) {
    const vite = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
    run(process.execPath, [vite, 'build', '--logLevel', 'warn'], WEB, 'build the UI');
  }
  if (!existsSync(join(WEB, 'dist', 'index.html'))) throw new Error('packages/web/dist is missing; run without --no-build');

  const demo = JSON.parse(readFileSync(join(opts.dataDir, 'demo-tokens.json'), 'utf8')) as DemoTokens;
  const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  const axeVersion = (JSON.parse(readFileSync(require.resolve('axe-core/package.json'), 'utf8')) as { version: string })
    .version;
  const probe = await build({
    entryPoints: [join(HERE, 'probe.ts')],
    bundle: true,
    format: 'iife',
    globalName: '__aocProbe',
    // page.evaluate runs the bundle in a scope where `var` does not become a global.
    footer: { js: 'window.__aocProbe = __aocProbe;' },
    target: 'chrome120',
    write: false,
    logLevel: 'silent',
  });
  const probeSource = probe.outputFiles[0]!.text;

  const routes = readRoutes(join(WEB, 'src', 'routes.tsx')).filter(
    (r) => !opts.routes || opts.routes.includes(r.path),
  );
  const roles = (opts.roles ?? ROLES).filter((r) => r === 'anonymous' || bearer(demo, r));
  const variants = VARIANTS.filter((v) => !opts.variants || opts.variants.includes(v.id));

  const daemon = await startDaemon(opts);
  let browser: Browser | null = null;
  const stop = async () => {
    await browser?.close().catch(() => undefined);
    await stopDaemon(daemon);
  };
  const onSignal = (sig: NodeJS.Signals) => {
    void stop().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    const base = `http://localhost:${opts.port}`;
    browser = await loadChromium().launch({ headless: true });
    const storage: Shared['storage'] = {};
    for (const role of roles) {
      const token = bearer(demo, role);
      if (!token) continue;
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
      const res = await ctx.request.post(`${base}/api/auth/login`, { data: { token } });
      if (res.status() !== 200) throw new Error(`sign-in as ${role} failed: HTTP ${res.status()} ${await res.text()}`);
      storage[role] = await ctx.storageState();
      await ctx.close();
    }
    const shared: Shared = { browser, base, storage, axeSource, probeSource };

    const visits: Visit[] = [];
    for (const role of roles)
      for (const route of routes)
        if (visibleTo(route, role)) visits.push({ route, role, ...(await urlFor(base, route, role, demo)) });
    const jobs = visits.flatMap((v) => variants.map((variant) => ({ v, variant })));
    console.log(`> ${visits.length} route/role pairs × ${variants.length} variants = ${jobs.length} page visits`);
    const pages = await pool(jobs, opts.concurrency, ({ v, variant }) => scan(shared, v, variant));

    const routing: RoutingCheck[] = [];
    const checks: [Role, string, string][] = [
      ['anonymous', '/tower', '/login'],
      ['anonymous', '/portal', '/portal/login'],
      ['requester', '/tower', '/portal'],
      ...(['approver', 'builder'] as const).map((r): [Role, string, string] => [r, '/', LANDING[r]!]),
    ];
    for (const [role, path, expected] of checks)
      if (roles.includes(role)) routing.push(await routeCheck(shared, role, path, expected));

    const notes: string[] = [];
    for (const r of readRoutes(join(WEB, 'src', 'routes.tsx')))
      if (r.component === null) notes.push(`\`${r.path}\` renders no page (role landing redirect); covered by Role routing.`);
    const placeholders = [...new Set(visits.filter((v) => v.placeholder).map((v) => v.route.path))];
    if (placeholders.length)
      notes.push(
        `No seeded record for ${placeholders.map((p) => `\`${p}\``).join(', ')}: visited with \`${MISSING_ID}\` (not-found state).`,
      );
    notes.push(`Raw results: \`${join(opts.dataDir, 'a11y-results.json')}\`.`);

    const result: RunResult = {
      startedAt,
      finishedAt: new Date().toISOString(),
      commit: git(['rev-parse', '--short', 'HEAD']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      axeVersion,
      browser: `Chromium ${browser.version()}`,
      dataDir: opts.dataDir,
      pages,
      routing,
      notes,
    };
    writeFileSync(join(opts.dataDir, 'a11y-results.json'), JSON.stringify(result, null, 2));
    writeFileSync(opts.out, renderReport(result));
    const failing = pages.filter((p) => issuesOf(p).some((i) => i.severity === 'fail')).length;
    const misrouted = routing.filter((r) => !r.ok).length;
    console.log(`> ${failing} of ${pages.length} page visits fail a gate; ${misrouted} routing check(s) wrong`);
    console.log(`> report: ${opts.out}`);
    return failing || misrouted ? 1 : 0;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await stop();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`a11y: ${(err as Error).message}`);
    process.exit(2);
  },
);
