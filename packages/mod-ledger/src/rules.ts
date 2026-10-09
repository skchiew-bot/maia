/** Pure build-ledger rules (no I/O): naming, evidence plausibility, budgets, sampling. */
import {
  MODEL_CONTEXT_TOKENS,
  TASK_SIZES,
  TASK_SIZE_WEIGHT,
  modelTierOf,
  type PlaybookInfo,
  type TaskSize,
} from '@aoc/contracts';

/** Default overrun budgets per declared size, in minutes of session time. */
export const DEFAULT_OVERRUN_BUDGET_MIN: Record<TaskSize, number> = { xs: 15, s: 30, m: 60, l: 120, xl: 240 };
export const DEFAULT_DRIFT_DEDUP_MS = 30 * 60_000;
/** Net amendment growth over the declared baseline weight that counts as scope growth. */
export const DEFAULT_SCOPE_GROWTH_THRESHOLD = 0.3;
export const DEFAULT_ROLLOVER_CONTEXT_PCT = 70;
/**
 * Per git call. A handler runs at most three sequential stages of calls (the filter-driver config read, then the
 * status and diff beside the evidence read, then the phase pin), so even three stalled stages end inside the MCP
 * server's 15 s daemon timeout.
 */
export const DEFAULT_GIT_TIMEOUT_MS = 4_000;
/** Unknown models get a small window so rollover errs early rather than late. */
const UNKNOWN_MODEL_WINDOW = 200_000;

export function weightOfSize(size: TaskSize): number {
  return TASK_SIZE_WEIGHT[size];
}

/** Nearest declared size for a weight (degraded rows rebuilt from meta only). */
export function sizeOfWeight(weight: number): TaskSize {
  let best: TaskSize = 'xs';
  for (const s of TASK_SIZES)
    if (Math.abs(TASK_SIZE_WEIGHT[s] - weight) < Math.abs(TASK_SIZE_WEIGHT[best] - weight)) best = s;
  return best;
}

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return s || 'project';
}

/** One git ref path component: only [A-Za-z0-9._-], no "..", no leading "." or "-", no ".lock" suffix. */
export function refComponent(s: string): string {
  const c = s
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .replace(/\.lock$/i, '-lock')
    .replace(/\.+$/, '');
  return c || 'x';
}

/** Immutable rollback pin for a completed phase (§8). `seq` is the closing event's chain seq, so re-completions never collide. */
export function phaseTagName(projectSlug: string, phaseId: string, seq: number): string {
  return `aoc/${refComponent(projectSlug)}/${refComponent(phaseId)}/${seq}`;
}

const PLACEHOLDER_REFS = new Set([
  'n/a',
  'na',
  'none',
  'null',
  'nil',
  'todo',
  'tbd',
  'test',
  'tests',
  'ok',
  'done',
  'pass',
  'passed',
  'yes',
  'diff',
  'commit',
  'head',
]);

/** Evidence refs that carry no information ("n/a", "done", "---"). */
export function isPlaceholderRef(ref: string): boolean {
  const r = ref.trim().toLowerCase();
  return r.length < 3 || PLACEHOLDER_REFS.has(r) || /^(.)\1+$/.test(r);
}

const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.(go|py|rb|exs?)$/,
  /^test_.+\.py$/,
  /_spec\.rb$/,
  /Tests?\.(java|kt|cs|swift|scala)$/,
];

/** The test-file path named by a test id ("pkg/foo.test.ts > adds" → "pkg/foo.test.ts"), if any. */
export function testFileOf(ref: string): string | null {
  for (const raw of ref.split(/\s+|>|::|#|\|/)) {
    const tok = raw
      .replace(/^[('"`]+|[)'"`,;]+$/g, '')
      .replace(/:\d+(:\d+)?$/, '')
      .replace(/^\.\//, '');
    if (!tok) continue;
    const base = tok.split('/').pop() ?? tok;
    if (TEST_FILE_PATTERNS.some((p) => p.test(base))) return tok;
  }
  return null;
}

/**
 * A test id is plausible when it names a test file, has test-runner structure ("file > suite > case",
 * "module::case", "Class#method"), or is a dotted/underscored test identifier ("tests.auth.test_login").
 * Prose such as "all tests pass" is not an id.
 */
export function isPlausibleTestId(ref: string): boolean {
  const r = ref.trim();
  if (isPlaceholderRef(r)) return false;
  if (testFileOf(r)) return true;
  if (/\s>\s|::|#[A-Za-z_]/.test(r)) return true;
  return /^[\w$./-]+$/.test(r) && /test|spec/i.test(r) && /[._/-]/.test(r);
}

export function contextWindowFor(model: string | null): number {
  const tier = modelTierOf(model ?? '');
  if (tier === 'unknown') return UNKNOWN_MODEL_WINDOW;
  return MODEL_CONTEXT_TOKENS[tier] ?? UNKNOWN_MODEL_WINDOW;
}

/** Indices of an evenly spaced sample of `n` items that keeps the first and last (deterministic). */
export function evenSampleIndices(n: number, max: number): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  if (max <= 1) return max === 1 ? [0] : [];
  return Array.from({ length: max }, (_, i) => Math.round((i * (n - 1)) / (max - 1)));
}

export function normalizeStep(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Match an agent-reported step against the playbook by step id or title (case/space-insensitive). */
export function matchPlaybookStep(pb: PlaybookInfo, step: string): { id: string; index: number } | null {
  const n = normalizeStep(step);
  const index = pb.steps.findIndex((s) => normalizeStep(s.id) === n || normalizeStep(s.title) === n);
  return index < 0 ? null : { id: pb.steps[index]!.id, index };
}

/** Net growth of the plan weight over the declared baseline (0.25 = +25%). */
export function scopeGrowth(baseWeight: number, currentWeight: number): number {
  return baseWeight > 0 ? (currentWeight - baseWeight) / baseWeight : 0;
}

export function duplicates(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

export function maxIso(...xs: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const x of xs) if (x && (best === null || Date.parse(x) > Date.parse(best))) best = x;
  return best;
}

export function minIso(...xs: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const x of xs) if (x && (best === null || Date.parse(x) < Date.parse(best))) best = x;
  return best;
}

/** One line of untrusted text for markdown (no newlines, bounded). */
export function oneLine(s: string | null | undefined, max = 160): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
