/**
 * Control Tower end-to-end check against a running, seeded daemon (not part of `vitest run`).
 *
 *   node packages/web/test/tower/tower.e2e.mjs --base http://localhost:7512 --data-dir /tmp/aoc-ui-tower \
 *     [--shots packages/web/screenshots] [--actions]
 *
 * `--base` must be the daemon's public URL: cookie-authenticated writes from any other origin are refused
 * (403 bad_origin), so http://127.0.0.1:<port> cannot approve anything while http://localhost:<port> can.
 *
 * --shots    full-page screenshots at 1440×900 and 390×844, light and dark → tower-<width>-<theme>.png; each load
 *            must produce zero console errors, zero failed API requests and no horizontal scroll.
 * --actions  drives every inline action through the real APIs and confirms the resulting event in
 *            /api/audit/events: approve (lesson binding), deny (credit top-up), restart (dead session), a refused
 *            restart (writer lock → inline error), nudge, and the passkey hand-off to /decisions?focus=<id>.
 *            The seed has no stalled session or passkey gate, so for those two rows only, the real snapshot is
 *            extended with one row that points at a real session / real decision; everything they call is real.
 *
 * Playwright comes from PLAYWRIGHT_PATH (default: the global install at /opt/node22/lib/node_modules/playwright).
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? '/opt/node22/lib/node_modules/playwright');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value !== undefined && !value.startsWith('--') ? value : fallback;
};
const base = arg('base', 'http://localhost:7512').replace(/\/+$/, '');
const dataDir = resolve(arg('data-dir', '/tmp/aoc-ui-tower'));
const shotsDir = process.argv.includes('--shots') ? resolve(arg('shots', 'packages/web/screenshots')) : null;
const doActions = process.argv.includes('--actions');
const demo = JSON.parse(readFileSync(join(dataDir, 'demo-tokens.json'), 'utf8'));
const ceoToken = demo.tokens.ceo.token;

const failures = [];
const check = (ok, message) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${message}`);
  if (!ok) failures.push(message);
};

async function api(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${ceoToken}`, 'content-type': 'application/json', ...init.headers },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function events(type, filter) {
  const { body } = await api(`/api/audit/events?type=${encodeURIComponent(type)}&order=desc&limit=50`);
  return (body?.events ?? []).filter(filter);
}

async function waitFor(fn, what, timeoutMs = 20_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function openTower(browser, { width, height, colorScheme }, onRoute) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme,
    timezoneId: 'Asia/Kuala_Lumpur',
    deviceScaleFactor: 1,
  });
  const login = await context.request.post(`${base}/api/auth/login`, { data: { token: ceoToken } });
  if (!login.ok()) throw new Error(`login failed: HTTP ${login.status()}`);
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console error: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => {
    // Client-side aborts are not failures: closing the page drops the event stream, and the data layer cancels a
    // superseded or unmounted fetch on purpose.
    const error = r.failure()?.errorText ?? '';
    if (!r.url().includes('/api/stream') && !error.includes('ERR_ABORTED')) {
      problems.push(`request failed: ${r.url()} (${error})`);
    }
  });
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 400) problems.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`);
  });
  if (onRoute) await page.route('**/api/tower', onRoute);
  await page.goto(`${base}/tower`, { waitUntil: 'load' });
  await page.waitForSelector('.tower-queue', { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, problems };
}

const row = (page, title) => page.locator('li.tower-q', { has: page.locator('.tower-q__title a', { hasText: title }) });

/**
 * Optimistic statuses can appear and reconcile away within a few hundred ms (POST → event → refetch), faster
 * than polling sees them, so the page records every status text it ever shows.
 */
async function recordStatuses(page) {
  await page.evaluate(() => {
    const seen = (window.__towerStatuses = []);
    const scan = () =>
      document.querySelectorAll('.tower-q__done').forEach((el) => {
        const text = el.textContent ?? '';
        if (!seen.includes(text)) seen.push(text);
      });
    new MutationObserver(scan).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
}
const statuses = (page) => page.evaluate(() => window.__towerStatuses ?? []);

async function screenshots(browser) {
  mkdirSync(shotsDir, { recursive: true });
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    for (const colorScheme of ['light', 'dark']) {
      const { context, page, problems } = await openTower(browser, { width, height, colorScheme });
      await page.waitForTimeout(600);
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const file = join(shotsDir, `tower-${width}-${colorScheme}.png`);
      await page.screenshot({ path: file, fullPage: true });
      check(problems.length === 0, `tower ${width} ${colorScheme}: no console errors or failed requests ${problems.join('; ')}`);
      check(scrollWidth <= width, `tower ${width} ${colorScheme}: no horizontal scroll (scrollWidth ${scrollWidth})`);
      if (width === 390) {
        const queueFirst = await page.evaluate(() => {
          const q = document.querySelector('.tower-queue')?.getBoundingClientRect().top ?? Infinity;
          const k = document.querySelector('.tower-kpis')?.getBoundingClientRect().top ?? -Infinity;
          return q < k;
        });
        check(queueFirst, 'tower 390: the attention queue comes before the KPI band');
      }
      console.log(`     ${file}`);
      await context.close();
    }
  }
}

async function actions(browser) {
  const { body: open } = await api('/api/decisions?status=open');
  const lesson = open.decisions.find((d) => d.kind === 'lesson_binding');
  const topup = open.decisions.find((d) => d.kind === 'credit_topup');
  const mainMerge = open.decisions.find((d) => d.kind === 'agent_decision' && d.test === 'main');
  const { body: tower } = await api('/api/tower');
  const dead = tower.attention.filter((a) => a.kind === 'session_dead');
  const deadAoc = dead.find((a) => a.projectId === 'prj_aoc');
  const deadClaims = dead.find((a) => a.projectId === 'prj_claims');
  if (!lesson || !topup || !mainMerge || !deadAoc || !deadClaims) throw new Error('seeded data is missing an expected item');

  // Extra rows (see header): a stalled row for the session we restart, a passkey row for a real open decision.
  let stalledFor = null;
  const extend = async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (stalledFor) {
      json.attention.push({
        id: `session_stalled:${stalledFor}`,
        kind: 'session_stalled',
        severity: 'medium',
        title: 'E2E: running docs session (as stalled)',
        detail: null,
        projectId: 'prj_aoc',
        projectName: 'AOC Platform',
        since: new Date(Date.now() - 11 * 60_000).toISOString(),
        ageMs: 11 * 60_000,
        costOfDelay: { score: 34, basis: 'Stalled · 11m · e2e row for the nudge path' },
        action: { kind: 'nudge', label: 'Nudge…', href: `/sessions/${stalledFor}`, sessionId: stalledFor },
        chips: [],
      });
    }
    json.attention.push({
      id: `decision:e2e-passkey`,
      kind: 'decision',
      severity: 'critical',
      title: 'E2E: passkey hand-off',
      detail: null,
      projectId: null,
      projectName: null,
      since: new Date(Date.now() - 5 * 60_000).toISOString(),
      ageMs: 5 * 60_000,
      costOfDelay: { score: 99, basis: 'Go-live gate · e2e row for the passkey hand-off' },
      action: {
        kind: 'resolve_decision',
        label: 'Approve with passkey',
        href: `/decisions?id=${mainMerge.id}`,
        decisionId: mainMerge.id,
        requiresPasskey: true,
      },
      chips: [],
    });
    await route.fulfill({ response, json });
  };
  const { context, page, problems } = await openTower(browser, { width: 1440, height: 900, colorScheme: 'light' }, extend);

  // 1. Approve applies the recommended option (lesson binding → "bind").
  await recordStatuses(page);
  const lessonRow = row(page, lesson.title);
  await lessonRow.getByRole('button', { name: 'Approve', exact: true }).click();
  await lessonRow.getByLabel('Comment (optional)').fill('Approved from the Control Tower (e2e).');
  await lessonRow.getByRole('button', { name: 'Confirm approval' }).click();
  await lessonRow.waitFor({ state: 'detached', timeout: 20_000 });
  const approved = await events('decision.resolved', (e) => e.meta.decisionId === lesson.id);
  check(approved[0]?.meta.optionId === 'bind', `approve: decision.resolved #${approved[0]?.seq} with optionId=bind; row reconciled away`);
  check((await statuses(page)).some((t) => t.startsWith('Approved · Bind lesson')), 'approve: optimistic "Approved · Bind lesson" status shown');

  // 2. Deny applies the explicit refusal (credit top-up → "deny").
  const topupItem = tower.attention.find((a) => a.action.decisionId === topup.id);
  const topupRow = row(page, topupItem.title);
  await topupRow.getByRole('button', { name: 'Deny', exact: true }).click();
  await topupRow.getByRole('button', { name: 'Confirm denial' }).click();
  await waitFor(async () => (await events('decision.resolved', (e) => e.meta.decisionId === topup.id)).length > 0, 'deny event');
  const denied = await events('decision.resolved', (e) => e.meta.decisionId === topup.id);
  check(denied[0]?.meta.optionId === 'deny', `deny: decision.resolved #${denied[0]?.seq} with optionId=deny`);
  await waitFor(async () => (await statuses(page)).some((t) => t.startsWith('Denied')), 'deny status');
  check(true, 'deny: optimistic "Denied" status shown');

  // 3. A refused restart (another writer holds the thread) explains itself and keeps the row actionable.
  const lockedRow = row(page, deadClaims.title).filter({ hasText: deadClaims.projectName });
  await lockedRow.getByRole('button', { name: 'Restart' }).click();
  const alert = lockedRow.getByRole('alert');
  await alert.waitFor();
  const alertText = await alert.textContent();
  check(/writer/i.test(alertText), `refused restart: inline error "${alertText.trim()}"`);
  check(await lockedRow.getByRole('button', { name: 'Restart' }).isEnabled(), 'refused restart: row stays actionable');
  await alert.getByRole('button', { name: 'Dismiss' }).click();

  // 4. Restart a dead session through the supervisor (claude-sim in the demo config).
  const deadRow = row(page, deadAoc.title).filter({ hasText: 'AOC Platform' });
  await deadRow.getByRole('button', { name: 'Restart' }).click();
  await waitFor(async () => (await events('session.restarted', (e) => e.meta.sessionId === deadAoc.action.sessionId)).length > 0, 'restart event');
  const restarted = await events('session.restarted', (e) => e.meta.sessionId === deadAoc.action.sessionId);
  check(restarted.length > 0, `restart: session.restarted #${restarted[0]?.seq} for ${deadAoc.action.sessionId}`);
  check((await statuses(page)).some((t) => t.startsWith('Restart requested')), 'restart: optimistic "Restart requested" status shown');
  await deadRow.waitFor({ state: 'detached', timeout: 30_000 });
  check(true, 'restart: the dead-session row reconciled away once the session reported back');

  // 5. Nudge the (now running) session from a stalled row.
  stalledFor = deadAoc.action.sessionId;
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.tower-queue');
  await recordStatuses(page);
  const nudgeRow = row(page, 'E2E: running docs session (as stalled)');
  await nudgeRow.getByRole('button', { name: 'Nudge…' }).click();
  await nudgeRow.getByLabel(/Note for the session/).fill('Summarise where the runbook stands, then continue.');
  await nudgeRow.getByRole('button', { name: 'Send nudge' }).click();
  await waitFor(async () => (await events('session.nudged', (e) => e.meta.sessionId === stalledFor)).length > 0, 'nudge event');
  const nudged = await events('session.nudged', (e) => e.meta.sessionId === stalledFor);
  check(nudged.length > 0, `nudge: session.nudged #${nudged[0]?.seq} for ${stalledFor}`);
  await waitFor(async () => (await statuses(page)).some((t) => t.startsWith('Nudge sent')), 'nudge status');
  check(true, 'nudge: optimistic "Nudge sent" status shown');

  // 6. Passkey gates hand off to the Decisions page, focused on the card.
  const passkeyRow = row(page, 'E2E: passkey hand-off');
  const link = passkeyRow.getByRole('link', { name: 'Approve with passkey' });
  check((await link.getAttribute('href')) === `/decisions?focus=${mainMerge.id}`, 'passkey: links to /decisions?focus=<id>');
  await link.click();
  await page.waitForURL(`**/decisions?focus=${mainMerge.id}`);
  check(page.url().endsWith(`/decisions?focus=${mainMerge.id}`), 'passkey: navigated to the Decisions page');

  // The refused restart is expected to answer 409 (the browser also logs that response as a console error).
  const unexpected = problems.filter(
    (p) => !/HTTP 409 POST .*\/restart/.test(p) && !/console error: Failed to load resource: .*409/.test(p),
  );
  check(unexpected.length === 0, `actions: no console errors or unexpected failed requests ${unexpected.join('; ')}`);
  // A stream-triggered refetch may still be inside the route handler.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await context.close();
}

const browser = await chromium.launch();
try {
  if (shotsDir) await screenshots(browser);
  if (doActions) await actions(browser);
} finally {
  await browser.close();
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
