/**
 * End-to-end check of the Decisions inbox against a running daemon, with a CDP virtual WebAuthn
 * authenticator: register a passkey inline, sign a Builder-raised break-glass decision, approve a card
 * with the button, and confirm the separation-of-duties read-only state for the Approver's own request.
 * Each step verifies the resulting events through the API.
 *
 *   node packages/web/test/decisions/passkey.e2e.mjs
 *
 * Env: AOC_URL (default http://localhost:7514 — passkeys need the configured origin/rpId, here localhost),
 * AOC_DATA_DIR (default /tmp/aoc-ui-decisions, for demo-tokens.json), PLAYWRIGHT_MODULE (default the global
 * install). Not part of the vitest suite: it needs a seeded demo daemon (see the UI brief).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? '/opt/node22/lib/node_modules/playwright');
const BASE = process.env.AOC_URL ?? 'http://localhost:7514';
const DATA = process.env.AOC_DATA_DIR ?? '/tmp/aoc-ui-decisions';
const tokens = JSON.parse(readFileSync(`${DATA}/demo-tokens.json`, 'utf8')).tokens;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(cond, message) {
  if (!cond) throw new Error(`FAILED: ${message}`);
  console.log(`  ok  ${message}`);
}
async function until(fn, message, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`TIMEOUT: ${message}`);
    await sleep(250);
  }
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
const failed = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));
page.on('response', (r) => {
  // A refused passkey or decision call is a test failure; deliberate 4xx are not expected in this flow.
  if (r.url().includes('/api/') && r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
});

const cdp = await context.newCDPSession(page);
await cdp.send('WebAuthn.enable');
await cdp.send('WebAuthn.addVirtualAuthenticator', {
  options: {
    protocol: 'ctap2',
    transport: 'internal',
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
  },
});

const api = async (path) => (await page.request.get(`${BASE}${path}`)).json();
const login = await page.request.post(`${BASE}/api/auth/login`, { data: { token: tokens.ceo.token } });
check(login.ok(), 'CEO signs in with the demo token');
const ceo = (await api('/api/auth/me')).user;

// Start from "no passkey" so the inline registration path is exercised (credentials from earlier runs live in
// a virtual authenticator that no longer exists).
for (const pk of (await api('/api/passkeys')).passkeys)
  await page.request.delete(`${BASE}/api/passkeys/${pk.id}`);

const open = (await api('/api/decisions?status=open&limit=500')).decisions;
const signable = open.find((d) => d.requiresPasskey && d.viewer.canResolve);
const own = open.find((d) => d.requesterId === ceo.id && d.viewer.reason === 'separation_of_duties');
const buttonCard = open.find(
  (d) => !d.requiresPasskey && d.viewer.canResolve && d.recommendation && d.subjectType !== 'ticket',
);
check(
  signable,
  `a passkey-gated decision raised by someone else is open (${signable?.kind} ${signable?.id})`,
);

console.log('Step 1: register a passkey inline and sign the decision');
await page.goto(`${BASE}/decisions?focus=${signable.id}`);
const panel = page.locator('aside.dec-layout__detail');
await panel.getByRole('button', { name: 'Register a passkey' }).click();
await until(async () => (await api('/api/passkeys')).passkeys.length === 1, 'passkey registered');
check(true, 'passkey registered through /api/passkeys/register/*');
const approve = panel.getByRole('button', { name: /^Approve with passkey/ });
await until(() => approve.isEnabled(), 'sign button enabled after registration');
await approve.click();
const signed = await until(async () => {
  const d = await api(`/api/decisions/${signable.id}`);
  return d.status === 'resolved' ? d : null;
}, 'decision resolved');
check(
  signed.resolution.method === 'passkey' && signed.resolution.passkeyVerified,
  'resolved with method passkey, verified',
);
check(signed.resolution.resolvedBy === ceo.id, "resolved under the CEO's name");
const asserted = (await api(`/api/audit/events?type=passkey.asserted&actorId=${ceo.id}&order=desc&limit=20`))
  .events;
check(
  asserted.some(
    (e) => e.meta.decisionId === signable.id && e.meta.optionId === 'approve' && e.meta.userVerified === true,
  ),
  'passkey.asserted evidence bound to the decision and option is in the audit log',
);
await panel.getByText('Signed (passkey)', { exact: false }).first().waitFor();
check(true, 'the panel records the resolution as signed (passkey)');

if (buttonCard) {
  console.log('Step 2: Approve with the button applies the recommended option');
  await page.goto(`${BASE}/decisions`);
  const cardEl = page.locator('li.dec-card', { has: page.locator(`#dec-q-${buttonCard.id}`) });
  await cardEl.getByRole('button', { name: /^Approve: / }).click();
  const r = await until(async () => {
    const d = await api(`/api/decisions/${buttonCard.id}`);
    return d.status === 'resolved' ? d : null;
  }, 'button decision resolved');
  check(r.resolution.optionId === buttonCard.recommendation.optionId, 'the recommended option was applied');
  check(
    r.resolution.method === 'button' && !r.resolution.passkeyVerified,
    'recorded as attribution (bearer token)',
  );
}

if (own) {
  console.log("Step 3: the Approver's own request is read-only: a second Approver is needed");
  await page.goto(`${BASE}/decisions?focus=${own.id}`);
  await panel.getByText('a second Approver is needed', { exact: false }).waitFor();
  check(true, 'separation-of-duties reason shown');
  check(
    (await panel.getByRole('button', { name: /with passkey/ }).count()) === 0,
    'no sign buttons for the requester',
  );
}

await sleep(500);
check(errors.length === 0, `no console errors (${errors.join(' | ')})`);
check(failed.length === 0, `no failed API requests (${failed.join(' | ')})`);
await browser.close();
console.log('Decisions passkey e2e passed');
