/**
 * The words of the seeded history: what requesters wrote, what the triage agents found, what the builds changed and
 * what the change records say. Requester text is what a customer would type (nothing in it is addressed to a
 * model); the engineering text is what the platform's own agents and developers would plausibly write.
 */
import type { PersonKey } from './world';

export type TicketKey =
  | 'receipts'
  | 'duplicate'
  | 'legacy-policy'
  | 'blank-login'
  | 'wrong-name'
  | 'claim-total'
  | 'cx-panel'
  | 'cannot-repro'
  | 'dup-of'
  | 'pdf'
  | 'transfer-blank';

export interface TicketText {
  by: PersonKey;
  project: 'claims' | 'cx';
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  comment: string | null;
}

export const TICKETS: Record<TicketKey, TicketText> = {
  receipts: {
    by: 'daniel',
    project: 'claims',
    severity: 'medium',
    title: 'Receipt photos come out sideways',
    description:
      'When I photograph a receipt in portrait on my phone and attach it to a claim, the uploaded image shows up rotated 90 degrees. The adjuster asked me to send it again twice.',
    comment: 'iPhone 15, latest app version.',
  },
  duplicate: {
    by: 'nur',
    project: 'claims',
    severity: 'high',
    title: 'My claim was submitted twice',
    description:
      'The app froze after I pressed Submit, so I pressed it again. Now I have two identical claims and two confirmation emails for the same accident.',
    comment: null,
  },
  'legacy-policy': {
    by: 'nur',
    project: 'claims',
    severity: 'critical',
    title: 'Older policy numbers are rejected when I submit a claim',
    description:
      'Since Monday morning the app says "Policy number not recognised" for my policy P-482913, which is the number printed on my renewal letter from last year. I have an accident claim to file today and cannot get past the first screen. A neighbour with a newer policy had no problem.',
    comment: 'Policy P-482913, Android 14.',
  },
  'blank-login': {
    by: 'daniel',
    project: 'claims',
    severity: 'high',
    title: 'The app shows a blank white screen after I log in',
    description:
      'On my old Samsung phone (Android 9) the app opens, I log in, and then the screen stays white. Restarting the phone did not help. It worked fine last month.',
    comment: 'Samsung Galaxy J7, app version 3.8.2.',
  },
  'wrong-name': {
    by: 'nur',
    project: 'cx',
    severity: 'high',
    title: 'Suggested replies greet the caller by the previous caller’s name after a transfer',
    description:
      'When I transfer a call to another queue and take it back, the suggested replies on my screen still use the name of the previous caller until I reload the panel. Two customers have been called by the wrong name this week.',
    comment: null,
  },
  'claim-total': {
    by: 'daniel',
    project: 'claims',
    severity: 'low',
    title: 'The claim total has no currency',
    description:
      'On the claim summary screen the total reads 1,250.00 with no currency. Our family files claims in both MYR and SGD, so I cannot tell which one I am claiming.',
    comment: null,
  },
  'cx-panel': {
    by: 'nur',
    project: 'cx',
    severity: 'medium',
    title: 'Customer panel runs off the edge on a small laptop screen',
    description:
      'On my 13-inch laptop the customer details panel runs off the right edge, so I have to scroll sideways during calls to see the account balance.',
    comment: null,
  },
  'cannot-repro': {
    by: 'daniel',
    project: 'claims',
    severity: 'low',
    title: 'Upload progress bar sticks at 99%',
    description: 'When I attach a photo the progress bar stops at 99% for a long time. The photo does upload in the end, but it looks like the app has hung.',
    comment: null,
  },
  'dup-of': {
    by: 'nur',
    project: 'claims',
    severity: 'medium',
    title: 'My receipt picture is sideways after upload',
    description: 'I uploaded a photo of a receipt taken upright and it appears rotated on its side in my claim.',
    comment: null,
  },
  pdf: {
    by: 'daniel',
    project: 'claims',
    severity: 'low',
    title: 'Cannot attach a PDF bank statement',
    description: 'I tried to attach my bank statement as a PDF to my claim, but the Attach button only offers photos. Could PDFs be supported?',
    comment: null,
  },
  'transfer-blank': {
    by: 'nur',
    project: 'cx',
    severity: 'medium',
    title: 'Customer panel goes blank when a call is transferred twice',
    description:
      'If I transfer a call to another queue and it comes back to me, my customer panel goes blank until I reload the page. This has happened on three calls today.',
    comment: null,
  },
};

export interface Diagnosis {
  confidence: number;
  rootCauseClass: string;
  rootCause: string;
  fixPlan: string;
  affectedAreas: string[];
}

export const DIAGNOSES: Partial<Record<TicketKey, Diagnosis[]>> = {
  receipts: [
    {
      confidence: 0.86,
      rootCauseClass: 'exif-orientation-dropped',
      rootCause:
        'normalizeImage() re-encodes uploads and strips all metadata without applying the EXIF orientation tag first, so portrait photos taken on phones are stored rotated 90 degrees.',
      fixPlan:
        "Apply the EXIF orientation (sharp().rotate()) before stripping metadata in src/uploads/normalize.ts, add a regression test with a rotated receipt, then verify on UAT with the reporter's receipt.",
      affectedAreas: ['src/uploads/normalize.ts', 'test/uploads/normalize.test.ts'],
    },
    {
      confidence: 0.81,
      rootCauseClass: 'exif-orientation-dropped',
      rootCause:
        'The upload pipeline drops EXIF metadata during JPEG re-encoding; the orientation tag is lost before the image is stored, which is why only portrait phone photos are affected.',
      fixPlan:
        'Rotate according to the EXIF orientation in normalizeImage() before the metadata is stripped, and cover a portrait fixture in the upload tests.',
      affectedAreas: ['src/uploads/normalize.ts'],
    },
  ],
  duplicate: [
    {
      confidence: 0.84,
      rootCauseClass: 'retry-without-idempotency',
      rootCause:
        'submitClaim() retries a slow first attempt with withRetry() and each retry posts a fresh claim; when the first request eventually succeeds there are two claims for one submission.',
      fixPlan:
        'Send an idempotency key with every submission so retries reuse the first claim id (src/claims/idempotency.ts), and add a regression test that retries a slow submission.',
      affectedAreas: ['src/claims/submit.ts', 'src/claims/retry.ts', 'src/claims/idempotency.ts'],
    },
    {
      confidence: 0.8,
      rootCauseClass: 'retry-without-idempotency',
      rootCause:
        'Mobile double taps and the three-attempt retry in submitClaim() both create new claims because nothing identifies a submission across attempts.',
      fixPlan: 'Introduce per-submission idempotency keys and make the claim endpoint return the existing claim for a repeated key.',
      affectedAreas: ['src/claims/submit.ts', 'src/claims/idempotency.ts'],
    },
  ],
  'legacy-policy': [
    {
      confidence: 0.93,
      rootCauseClass: 'validator-format-regression',
      rootCause:
        'isValidPolicyNumber() only accepts the POL-YYYY-NNNNNN format introduced in October. Legacy numbers (P-NNNNNN) fail the pattern, so the first screen refuses every policy issued before the change.',
      fixPlan:
        'Accept the legacy P-###### format alongside POL-YYYY-NNNNNN in src/claims/validate.ts, add regression tests for both formats, then verify on UAT with a legacy policy number.',
      affectedAreas: ['src/claims/validate.ts', 'test/claims/validate.test.ts'],
    },
    {
      confidence: 0.9,
      rootCauseClass: 'validator-format-regression',
      rootCause:
        'The October release replaced the policy-number pattern instead of extending it; renewals of older policies still print P-###### numbers that the new pattern rejects.',
      fixPlan: 'Extend the validator to accept both formats and normalise to the new format before the claim is stored.',
      affectedAreas: ['src/claims/validate.ts'],
    },
  ],
  'blank-login': [
    {
      confidence: 0.42,
      rootCauseClass: 'startup-crash',
      rootCause:
        'Possibly a crash while the OCR module initialises on devices without a GPU delegate. Nothing in the repository shows what the white screen is hiding, so this is a guess from the device age.',
      fixPlan: 'Add startup logging for the OCR module, reproduce on an Android 9 device, then decide whether to lazy-load it.',
      affectedAreas: ['src/ocr/engines.ts'],
    },
    {
      confidence: 0.55,
      rootCauseClass: 'token-refresh-failure',
      rootCause:
        'The session token refresh may fail on the older TLS stack of Android 9 and leave the login screen waiting forever. The code path is not covered by any test.',
      fixPlan: 'Log the refresh result and add a timeout with an error screen; confirm the TLS theory with the reporter’s device logs.',
      affectedAreas: ['src/index.ts'],
    },
  ],
  'wrong-name': [
    {
      confidence: 0.9,
      rootCauseClass: 'stale-customer-context',
      rootCause:
        'renderPanel() keeps the customer name in module state and only replaces it when a new call starts; a transfer re-enters the same call, so the suggestion service keeps greeting the previous caller.',
      fixPlan: 'Key the panel state by call leg and reset the customer context on transfer; add a test that transfers a call and checks the greeting.',
      affectedAreas: ['src/desktop/panel.ts', 'src/desktop/intent.ts'],
    },
    {
      confidence: 0.87,
      rootCauseClass: 'stale-customer-context',
      rootCause: 'The desktop panel never clears the customer on a transfer event, so suggestions are generated from stale context.',
      fixPlan: 'Clear and reload the customer context when a transfer is detected and cover it in the panel tests.',
      affectedAreas: ['src/desktop/panel.ts'],
    },
  ],
  'claim-total': [
    {
      confidence: 0.91,
      rootCauseClass: 'display-formatting',
      rootCause: 'The claim summary formats the total as a bare number; the currency of the policy is never passed to the formatter.',
      fixPlan: 'Format totals with the policy currency code in a small helper and test MYR and SGD amounts.',
      affectedAreas: ['src/claims/submit.ts'],
    },
    {
      confidence: 0.88,
      rootCauseClass: 'display-formatting',
      rootCause: 'There is no currency formatting step between the claim amount and the summary screen.',
      fixPlan: 'Add a formatClaimTotal() helper that appends the currency code and use it on the summary.',
      affectedAreas: ['src/claims/submit.ts'],
    },
  ],
  'cx-panel': [
    {
      confidence: 0.89,
      rootCauseClass: 'layout-overflow',
      rootCause: 'The customer details panel has a fixed minimum width of 960px, wider than a 13-inch laptop window split with the call controls.',
      fixPlan: 'Let the panel shrink below 960px and wrap the account fields; add a layout test for a 1280px window.',
      affectedAreas: ['src/desktop/panel.ts'],
    },
    {
      confidence: 0.86,
      rootCauseClass: 'layout-overflow',
      rootCause: 'A hard-coded panel width overflows narrow windows.',
      fixPlan: 'Replace the fixed width with a responsive layout helper and test narrow widths.',
      affectedAreas: ['src/desktop/panel.ts'],
    },
  ],
  'cannot-repro': [
    {
      confidence: 0.35,
      rootCauseClass: 'upload-progress',
      rootCause: 'The progress bar is driven by bytes sent, and the final 1% is the server-side scan; no code path explains a long stall, and nothing reproduces it.',
      fixPlan: 'Ask the reporter for timings and a device log before changing anything.',
      affectedAreas: ['src/uploads/normalize.ts'],
    },
    {
      confidence: 0.52,
      rootCauseClass: 'scan-latency',
      rootCause: 'The malware scan of larger photos may take several seconds while the bar shows 99%; this cannot be confirmed read-only.',
      fixPlan: 'Measure scan time on UAT with a large photo and show a "checking your photo" state if it is the cause.',
      affectedAreas: ['src/uploads/normalize.ts'],
    },
  ],
  'transfer-blank': [
    {
      confidence: 0.87,
      rootCauseClass: 'stale-panel-state',
      rootCause:
        'renderPanel() keeps one panel per call leg. A second transfer re-enters the leg of the first transfer, which was already disposed, so the panel renders no customer until it is reloaded.',
      fixPlan: 'Create the panel state per call leg and dispose it only when the call ends; add a test for a call transferred twice.',
      affectedAreas: ['src/desktop/panel.ts', 'src/desktop/intent.ts'],
    },
  ],
};

/** What a build commits (whole files; the path is repo-relative), by ticket key. */
export interface BuildStep {
  message: string;
  files: Record<string, string>;
}

const fixes: Partial<Record<TicketKey, BuildStep[]>> = {
  'legacy-policy': [
    {
      message: 'Accept legacy P-###### policy numbers alongside POL-YYYY-NNNNNN',
      files: {
        'src/claims/validate.ts': [
          '// Policy-number validation: POL-YYYY-NNNNNN since the October release, P-NNNNNN before it',
          'const CURRENT_RE = /^POL-\\d{4}-\\d{6}$/;',
          'const LEGACY_RE = /^P-\\d{6}$/;',
          '',
          'export function isValidPolicyNumber(value: string): boolean {',
          '  return CURRENT_RE.test(value) || LEGACY_RE.test(value);',
          '}',
          '',
          'export function isLegacyPolicyNumber(value: string): boolean {',
          '  return LEGACY_RE.test(value);',
          '}',
          '',
        ].join('\n'),
      },
    },
    {
      message: 'Cover both policy-number formats in the validator tests',
      files: {
        'test/claims/validate.test.ts': [
          "import { expect, it } from 'vitest';",
          "import { isLegacyPolicyNumber, isValidPolicyNumber } from '../../src/claims/validate';",
          '',
          "it('accepts current policy numbers', () => {",
          "  expect(isValidPolicyNumber('POL-2026-000123')).toBe(true);",
          '});',
          '',
          "it('accepts legacy policy numbers', () => {",
          "  expect(isValidPolicyNumber('P-482913')).toBe(true);",
          "  expect(isLegacyPolicyNumber('P-482913')).toBe(true);",
          '});',
          '',
          "it('rejects anything else', () => {",
          "  expect(isValidPolicyNumber('482913')).toBe(false);",
          '});',
          '',
        ].join('\n'),
      },
    },
  ],
  'claim-total': [
    {
      message: 'Show the currency on the claim total',
      files: {
        'src/claims/summary.ts': [
          '// Claim summary helpers',
          'export function formatClaimTotal(amount: number, currency: string): string {',
          "  return `${currency} ${amount.toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;",
          '}',
          '',
        ].join('\n'),
      },
    },
    {
      message: 'Test MYR and SGD claim totals',
      files: {
        'test/claims/summary.test.ts': [
          "import { expect, it } from 'vitest';",
          "import { formatClaimTotal } from '../../src/claims/summary';",
          '',
          "it('prefixes the currency code', () => {",
          "  expect(formatClaimTotal(1250, 'MYR')).toBe('MYR 1,250.00');",
          "  expect(formatClaimTotal(980.5, 'SGD')).toBe('SGD 980.50');",
          '});',
          '',
        ].join('\n'),
      },
    },
  ],
  'cx-panel': [
    {
      message: 'Let the customer panel shrink to the window',
      files: {
        'src/desktop/layout.ts': [
          '// Responsive width of the customer panel',
          'export const MIN_PANEL_WIDTH = 480;',
          '',
          'export function panelWidth(windowWidth: number, controlsWidth: number): number {',
          '  return Math.max(MIN_PANEL_WIDTH, windowWidth - controlsWidth);',
          '}',
          '',
        ].join('\n'),
      },
    },
    {
      message: 'Test the panel width on a 13-inch laptop',
      files: {
        'test/desktop/layout.test.ts': [
          "import { expect, it } from 'vitest';",
          "import { panelWidth } from '../../src/desktop/layout';",
          '',
          "it('fits a 1280px window next to the call controls', () => {",
          '  expect(panelWidth(1280, 420)).toBe(860);',
          '});',
          '',
          "it('never shrinks below the readable minimum', () => {",
          '  expect(panelWidth(600, 420)).toBe(480);',
          '});',
          '',
        ].join('\n'),
      },
    },
  ],
  'wrong-name': [
    {
      message: 'Reset the customer context when a call is transferred',
      files: {
        'src/desktop/panel.ts': [
          '// Agent desktop panel',
          'export interface PanelState {',
          '  callLeg: string;',
          '  customer: string;',
          '}',
          '',
          'const panels = new Map<string, PanelState>();',
          '',
          '// State is keyed by call leg, so a transfer starts from a clean context instead of the previous caller.',
          'export function renderPanel(callLeg: string, customer: string): PanelState {',
          '  const state = { callLeg, customer };',
          '  panels.set(callLeg, state);',
          '  return state;',
          '}',
          '',
          'export function onTransfer(callLeg: string): void {',
          '  panels.delete(callLeg);',
          '}',
          '',
        ].join('\n'),
      },
    },
    {
      message: 'Test that a transfer clears the previous caller',
      files: {
        'test/desktop/panel.test.ts': [
          "import { expect, it } from 'vitest';",
          "import { onTransfer, renderPanel } from '../../src/desktop/panel';",
          '',
          "it('greets the new caller after a transfer', () => {",
          "  renderPanel('leg-1', 'Aminah');",
          "  onTransfer('leg-1');",
          "  expect(renderPanel('leg-1', 'Rajesh').customer).toBe('Rajesh');",
          '});',
          '',
        ].join('\n'),
      },
    },
  ],
};

export const fixFor = (key: TicketKey): BuildStep[] => {
  const steps = fixes[key];
  if (!steps) throw new Error(`no scripted fix for ticket ${key}`);
  return steps;
};

// ── change records ───────────────────────────────────────────────────────────

export type ChangeKey = 'ocr-cap' | 'whisper-telemetry' | 'rollup-backfill' | 'validator-rollout' | 'dispatch-timeouts';

export interface ChangeText {
  title: string;
  scope: 'reversible_off_main' | 'main' | 'production' | 'data';
  project: 'claims' | 'cx' | 'aoc';
  owner: PersonKey;
  /** What the (scripted) AI drafts. */
  draft: { impact: string; mitigation: string; rollbackPlan: string; acceptanceTest: string };
  /** What the developer does with each draft: affirm it as it is, add to it, or replace it. */
  edits: Partial<Record<'impact' | 'mitigation' | 'rollbackPlan' | 'acceptanceTest', { append?: string; value?: string }>>;
}

const ACCEPTANCE = 'node --test test/acceptance.test.mjs';

export const CHANGES: Record<ChangeKey, ChangeText> = {
  'ocr-cap': {
    title: 'Cap OCR retries at three per document',
    scope: 'main',
    project: 'claims',
    owner: 'priya',
    draft: {
      impact:
        'Touches the OCR router for every claim document. A document that fails recognition three times is now routed to manual review instead of being retried indefinitely.',
      mitigation: 'Ship with the cap configurable, log every capped document, and watch the manual-review queue length for a day after release.',
      rollbackPlan: 'Return main to the commit recorded as the rollback point and redeploy; no data migration is involved.',
      acceptanceTest: ACCEPTANCE,
    },
    edits: {
      impact: { append: ' Slow scans of large forms are the case to watch: they currently succeed on the fourth or fifth attempt.' },
      rollbackPlan: { append: ' Documents already sent to manual review stay there and are picked up by the adjusters.' },
    },
  },
  'whisper-telemetry': {
    title: 'Instrument whisper suggestions with shown, accepted and dismissed events',
    scope: 'reversible_off_main',
    project: 'cx',
    owner: 'aisyah',
    draft: {
      impact: 'Adds three telemetry events to the agent desktop. No behaviour changes for agents; event volume rises by about one event per suggestion.',
      mitigation: 'Events are batched and dropped if the collector is unreachable, so call handling is never blocked.',
      rollbackPlan: 'Delete the change branch; nothing outside it was touched.',
      acceptanceTest: ACCEPTANCE,
    },
    edits: {
      // Affirmed as drafted after a glance: the mitigation is the blind confirm of the governance lens.
      impact: { append: ' The suggestion volume of the busiest queue is about 40 per agent-hour.' },
    },
  },
  'rollup-backfill': {
    title: 'Backfill the September usage rollups',
    scope: 'data',
    project: 'aoc',
    owner: 'weijie',
    draft: {
      impact: 'Rewrites the September daily rollups from the event log. Reads only the log; the rollup tables are replaced in one transaction.',
      mitigation: 'Dry run against a copy first; compare totals per day and per model before and after.',
      rollbackPlan: 'Restore the rollup tables from the nightly backup taken before the run.',
      acceptanceTest: ACCEPTANCE,
    },
    edits: {
      impact: { value: 'Rewrites the September daily rollups from the event log so the new cache-write columns are filled in. Reads only the log; the rollup tables are replaced in one transaction. Nothing user-facing changes.' },
      mitigation: { append: ' The comparison covers all 30 days and every model.' },
      rollbackPlan: { append: ' The backup is verified by restoring it to a scratch database before the run.' },
      acceptanceTest: { value: ACCEPTANCE },
    },
  },
  'validator-rollout': {
    title: 'Roll the dual-format policy-number validator out to production',
    scope: 'production',
    project: 'claims',
    owner: 'aisyah',
    draft: {
      impact: 'Production claim intake accepts both policy-number formats. Claims rejected since Monday can be resubmitted by customers.',
      mitigation: 'Release to ten percent of traffic first and compare the rejection rate with the control group.',
      rollbackPlan: 'Redeploy the previous build of claims-bot; the validator holds no state.',
      acceptanceTest: ACCEPTANCE,
    },
    edits: {
      impact: { append: ' About 1,300 submissions were rejected over the week.' },
      mitigation: { append: ' The rejection rate must fall below one percent before the rollout continues.' },
    },
  },
  'dispatch-timeouts': {
    title: 'Raise the dispatch queue timeout for transfers',
    scope: 'main',
    project: 'cx',
    owner: 'weijie',
    draft: {
      impact: 'Changes how long the desktop waits for the dispatch queue before it gives up on a transfer; calls near the limit are retried instead of dropped.',
      mitigation: 'Make the timeout a setting and start with the new value on one queue.',
      rollbackPlan: 'Return main to the recorded rollback point.',
      acceptanceTest: ACCEPTANCE,
    },
    edits: {},
  },
};

/** Files a change commits (on its own branch), by key. */
export const CHANGE_COMMITS: Partial<Record<ChangeKey, { message: string; files: Record<string, string> }>> = {
  'ocr-cap': {
    message: 'Route documents to manual review after three failed OCR attempts',
    files: {
      'src/ocr/router.ts': [
        "import { printOcr, type OcrResult } from './engines';",
        '',
        '// A document that fails recognition three times goes to manual review instead of being retried forever.',
        'export const MAX_OCR_ATTEMPTS = 3;',
        '',
        'export async function recognise(page: Uint8Array, attempts = 0): Promise<OcrResult | null> {',
        '  if (attempts >= MAX_OCR_ATTEMPTS) return null;',
        '  const result = await printOcr(page);',
        '  return result.confidence >= 0.6 ? result : recognise(page, attempts + 1);',
        '}',
        '',
      ].join('\n'),
      'test/ocr/retry-cap.test.ts': [
        "import { expect, it } from 'vitest';",
        "import { MAX_OCR_ATTEMPTS } from '../../src/ocr/router';",
        '',
        "it('caps OCR attempts at three', () => {",
        '  expect(MAX_OCR_ATTEMPTS).toBe(3);',
        '});',
        '',
      ].join('\n'),
    },
  },
  'whisper-telemetry': {
    message: 'Emit whisper.shown, whisper.accepted and whisper.dismissed',
    files: {
      'src/telemetry/whisper.ts': [
        "import { EVENTS } from './events';",
        '',
        '// Whisper suggestion telemetry: batched, dropped when the collector is unreachable.',
        "export const WHISPER_EVENTS = [EVENTS.callStarted, 'whisper.shown', 'whisper.accepted', 'whisper.dismissed'] as const;",
        '',
      ].join('\n'),
    },
  },
  'rollup-backfill': {
    message: 'Add the September rollup backfill script',
    files: {
      'scripts/backfill-rollups.ts': [
        '// Rebuilds the daily rollups of one month from the event log in a single transaction (dry run by default).',
        'export interface BackfillOptions {',
        '  month: string;',
        '  dryRun: boolean;',
        '}',
        '',
        'export function describeBackfill(o: BackfillOptions): string {',
        '  return `${o.dryRun ? "Would rebuild" : "Rebuilding"} the rollups of ${o.month}`;',
        '}',
        '',
      ].join('\n'),
    },
  },
};

/** The emergency fixes of the break-glass history. */
export const HOTFIXES = {
  claims: {
    branch: 'hotfix/claims-retry-stampede',
    message: 'Back off between claim submission retries and stop retrying client errors',
    justification:
      'Claim intake is down for every customer: the three-attempt retry in submitClaim() stampedes the claims API after a slow response and the API is out of connections. The hotfix backs off between attempts and does not retry 4xx answers.',
    file: {
      'src/claims/retry.ts': [
        '// Retries with exponential backoff; client errors (4xx) are never retried.',
        'export class ClientError extends Error {',
        '  constructor(readonly status: number) {',
        '    super(`client error ${status}`);',
        '  }',
        '}',
        '',
        'const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));',
        '',
        'export async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {',
        '  let last: unknown;',
        '  for (let i = 0; i < attempts; i++) {',
        '    try {',
        '      return await fn();',
        '    } catch (err) {',
        '      if (err instanceof ClientError) throw err;',
        '      last = err;',
        '      await sleep(200 * 2 ** i);',
        '    }',
        '  }',
        '  throw last;',
        '}',
        '',
      ].join('\n'),
    } as Record<string, string>,
  },
  aoc: {
    branch: 'hotfix/console-health-probe',
    message: 'Report readiness only after the event store answers',
    justification:
      'The console is serving a blank page: the readiness flag turns true before the event store has opened, so the load balancer sends traffic to instances that cannot answer. The hotfix reports ready only once the store responds.',
    file: {
      'src/index.ts': [
        '// Readiness: true only once the event store has answered.',
        'export let ready = false;',
        '',
        'export function markStoreOpen(): void {',
        '  ready = true;',
        '}',
        '',
      ].join('\n'),
    } as Record<string, string>,
  },
};

export const POST_INCIDENT: Record<'claims' | 'aoc', { impact: string; mitigation: string; rollbackPlan: string; acceptanceTest: string }> = {
  claims: {
    impact:
      'Claim intake was down for about forty minutes. The emergency hotfix changed the retry policy of every claim submission and went to production without a change record, so this record covers it after the fact.',
    mitigation: 'Retries now back off exponentially and client errors are not retried. Alert on connection-pool saturation of the claims API.',
    rollbackPlan: 'Return main to the commit before the hotfix and redeploy; the retry policy then reverts to three immediate attempts.',
    acceptanceTest: ACCEPTANCE,
  },
  aoc: {
    impact:
      'The console served a blank page for roughly twenty minutes. The emergency hotfix changed when the readiness flag turns true and went to production without a change record, so this record covers it after the fact.',
    mitigation: 'Readiness waits for the event store. Add a deploy check that opens the console before traffic is shifted.',
    rollbackPlan: 'Return main to the commit before the hotfix; readiness then reverts to true at start-up.',
    acceptanceTest: ACCEPTANCE,
  },
};
