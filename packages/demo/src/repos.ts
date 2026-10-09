/**
 * Files of the seeded demo project repositories. The claude-sim demo scenarios read, grep and edit these: every
 * file a scenario writes is committed here as a stub, so each run changes tracked content (`git diff HEAD`) and its
 * diff evidence verifies even when a scenario runs again in the same repository.
 */
const pkg = (name: string) => `${JSON.stringify({ name, private: true, scripts: { test: 'node -e "process.exit(0)"' } }, null, 2)}\n`;
const stub = (what: string) => `// ${what}: not written yet.\nexport {};\n`;
const doc = (title: string) => `# ${title}\n\n_Not written yet._\n`;

export const PROJECT_FILES: Record<'cx-copilot' | 'claims-bot' | 'aoc-platform', Record<string, string>> = {
  'cx-copilot': {
    'README.md': '# CX Copilot\n\nAgent-assist copilot for the Daythree contact centre: live intent detection, reply suggestions and CSAT signals on the agent desktop.\n',
    'package.json': pkg('cx-copilot'),
    'src/index.ts': "export { renderPanel } from './desktop/panel';\n",
    'src/desktop/panel.ts': "// Agent desktop panel\nexport interface PanelState {\n  customer: string;\n}\n\nexport function renderPanel(customer: string): PanelState {\n  return { customer };\n}\n",
    'src/desktop/intent.ts': "// Live intent classifier (scores every utterance)\nexport interface IntentScore {\n  intent: string;\n  confidence: number;\n}\n\nexport function topIntent(scores: IntentScore[]): IntentScore | null {\n  return [...scores].sort((a, b) => b.confidence - a.confidence)[0] ?? null;\n}\n",
    'src/desktop/whisper.ts': stub('Supervisor whisper suggestions'),
    'src/telemetry/events.ts': "// Telemetry event names\nexport const EVENTS = {\n  callStarted: 'call.started',\n  callEnded: 'call.ended',\n} as const;\n",
    'src/history/store.ts': "// Interaction history store\nexport const HISTORY_TABLE = 'interactions';\n",
    'src/history/dual-write.ts': stub('Dual-write during the history migration'),
    'migrations/0006_interactions.sql': 'CREATE TABLE interactions (id BIGSERIAL PRIMARY KEY, call_id TEXT NOT NULL, started_at TIMESTAMPTZ NOT NULL, transcript JSONB);\n',
    'migrations/0007_partition_history.sql': '-- Partitioned interaction history: not written yet.\n',
    'scripts/backfill-history.ts': stub('History backfill'),
    'docs/whisper/flow.md': doc('Whisper suggestions: event flow'),
    'test/desktop/whisper.test.ts': stub('Whisper acceptance tests'),
    'src/csat/contract.ts': stub('CSAT overlay API contract'),
    'src/csat/sentiment.ts': stub('Rolling sentiment score'),
    'src/csat/overlay.ts': stub('CSAT overlay'),
    'test/csat/overlay.test.ts': stub('CSAT overlay acceptance tests'),
  },
  'claims-bot': {
    'README.md': '# Claims Intake Bot\n\nInsurance claims intake and triage assistant: mobile submission, OCR of claim forms, policy validation.\n',
    'package.json': pkg('claims-bot'),
    'src/index.ts': "export { submitClaim } from './claims/submit';\n",
    'src/claims/submit.ts': "import { withRetry } from './retry';\n\nexport interface Claim {\n  policyNumber: string;\n  amount: number;\n}\n\n// Each retry posts a fresh claim: a slow first attempt that eventually succeeds leaves a duplicate.\nexport async function submitClaim(claim: Claim, post: (c: Claim) => Promise<string>): Promise<string> {\n  return withRetry(() => post(claim), 3);\n}\n",
    'src/claims/retry.ts': "export async function withRetry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {\n  let last: unknown;\n  for (let i = 0; i < attempts; i++) {\n    try {\n      return await fn();\n    } catch (err) {\n      last = err;\n    }\n  }\n  throw last;\n}\n",
    'src/claims/idempotency.ts': stub('Idempotency keys for claim submission'),
    'src/claims/validate.ts': "// Policy-number validation (POL-YYYY-NNNNNN since the October release)\nconst POLICY_RE = /^POL-\\d{4}-\\d{6}$/;\n\nexport function isValidPolicyNumber(value: string): boolean {\n  return POLICY_RE.test(value);\n}\n",
    'src/ocr/router.ts': "import { printOcr, type OcrResult } from './engines';\n\nexport async function recognise(page: Uint8Array): Promise<OcrResult> {\n  return printOcr(page);\n}\n",
    'src/ocr/engines.ts': "export interface OcrResult {\n  text: string;\n  confidence: number;\n}\n\nexport async function printOcr(_page: Uint8Array): Promise<OcrResult> {\n  return { text: '', confidence: 0.97 };\n}\n\nexport async function handOcr(_page: Uint8Array): Promise<OcrResult> {\n  return { text: '', confidence: 0.83 };\n}\n",
    'src/uploads/normalize.ts': "import sharp from 'sharp';\n\n// Re-encode every upload as JPEG and drop its metadata (GPS, device) before storage.\nexport async function normalizeImage(input: Buffer): Promise<Buffer> {\n  return sharp(input).jpeg({ quality: 82 }).toBuffer();\n}\n",
    'test/uploads/normalize.test.ts': "import { expect, it } from 'vitest';\nimport { normalizeImage } from '../../src/uploads/normalize';\n\nit('strips metadata from uploads', async () => {\n  const out = await normalizeImage(Buffer.from([]));\n  expect(out).toBeInstanceOf(Buffer);\n});\n",
    'test/claims/submit.test.ts': "import { expect, it } from 'vitest';\nimport { submitClaim } from '../../src/claims/submit';\n\nit('submits a claim', async () => {\n  expect(await submitClaim({ policyNumber: 'POL-2026-000001', amount: 10 }, async () => 'CLM-1')).toBe('CLM-1');\n});\n",
    'test/claims/dedupe.test.ts': stub('Duplicate submission regression test'),
    'test/claims/validate.test.ts': stub('Policy-number validator tests'),
    'test/ocr/router.test.ts': stub('OCR router tests'),
    'scripts/backfill-rejected-claims.ts': stub('Re-submit claims rejected by the policy-number bug'),
    'docs/incidents/policy-validator.md': doc('Incident: legacy policy numbers rejected'),
    'docs/uat/backfill-rehearsal.md': doc('Backfill rehearsal on UAT'),
    'docs/ocr/engine-comparison.md': doc('OCR engines on handwritten claim forms'),
    'docs/ocr/fallback.md': doc('Confidence-gated OCR fallback'),
  },
  'aoc-platform': {
    'README.md': '# AOC Platform\n\nThe console itself — features only; the governance core is human-built.\n',
    'package.json': pkg('aoc-platform'),
    'src/index.ts': 'export const ready = true;\n',
    'docs/runbooks/rollback.md': '# Rollback runbook\n\n1. The CEO issues the rollback from the dashboard (a human-required decision).\n2. The supervisor checks out the pinned tag on a new branch and runs that state\'s acceptance tests.\n3. Nothing touches main until the CEO approves the clean result.\n\n## See also\n\n- Change control (AOC-SPEC-003 §8)\n',
    'docs/runbooks/rollback-diagrams.md': doc('Rollback flow'),
    'docs/reports/inventory.md': doc('Legacy reports'),
    'src/reports/index.ts': "export * from './monthly-revenue';\nexport * from './churn';\nexport * from './cohort';\n",
    'src/reports/monthly-revenue.ts': stub('Monthly revenue report'),
    'src/reports/churn.ts': stub('Churn report'),
    'src/reports/cohort.ts': stub('Cohort report'),
    'src/export/csv.ts': stub('CSV serializer for audit timeline rows'),
    'src/export/stream.ts': stub('Streamed CSV export'),
    'src/export/button.tsx': stub('Export button'),
  },
};
