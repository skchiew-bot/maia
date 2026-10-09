/** Rate-card file (config.metering.rateCardFile) and the validation shared with PUT /api/ratecard. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { MODEL_TIERS, RateCardRateSchema, zLabel, type RateCardRate } from '@aoc/contracts';
import { isValidDate } from './dates';

export const zDate = z.string().refine(isValidDate, 'expected a calendar date YYYY-MM-DD');
export const zTierFallback = z.record(z.enum(MODEL_TIERS), z.string().min(1).max(80));
const zRates = z.array(RateCardRateSchema.strict()).min(1).max(500);

/** Rate model ids must be unique and every tier fallback must point at a priced model. */
export function rateCardProblems(
  rates: RateCardRate[],
  tierFallback: Partial<Record<string, string>>,
): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const r of rates) {
    const id = r.model.trim().toLowerCase();
    if (ids.has(id)) problems.push(`duplicate rate for model ${r.model}`);
    ids.add(id);
  }
  for (const [tier, model] of Object.entries(tierFallback)) {
    if (model && !ids.has(model.trim().toLowerCase()))
      problems.push(`tierFallback.${tier} → ${model} has no rate`);
  }
  return problems;
}

function refineCard(
  v: { rates: RateCardRate[]; tierFallback?: Partial<Record<string, string>> },
  ctx: z.RefinementCtx,
): void {
  for (const message of rateCardProblems(v.rates, v.tierFallback ?? {}))
    ctx.addIssue({ code: 'custom', message });
}

export const RateCardFileSchema = z
  .object({
    version: z.number().int().optional(),
    effectiveFrom: zDate,
    currency: z.literal('USD').default('USD'),
    note: z.string().max(2000).optional(),
    rates: zRates,
    tierFallback: zTierFallback.default({}),
    subscription: z
      .object({ plan: zLabel, seats: z.number().int().min(0), monthlyUsdPerSeat: z.number().finite().min(0) })
      .optional(),
  })
  .superRefine(refineCard);
export type RateCardFile = z.infer<typeof RateCardFileSchema>;

export const RateCardUpdateSchema = z
  .object({
    rates: zRates,
    effectiveFrom: zDate.optional(),
    tierFallback: zTierFallback.optional(),
    note: z.string().max(2000).optional(),
  })
  .strict()
  .superRefine(refineCard);

export const SubscriptionUpdateSchema = z
  .object({
    plan: zLabel,
    seats: z.number().int().min(0).max(100_000),
    monthlyUsdPerSeat: z.number().finite().min(0).max(1_000_000),
    effectiveFrom: zDate.optional(),
  })
  .strict();

/**
 * Resolve a configured path. Relative paths are tried against the working directory and then its
 * ancestors, because monorepo packages run their tests from their own directory.
 */
export function resolveConfigFile(path: string, cwd: string = process.cwd()): string | null {
  if (isAbsolute(path)) return existsSync(path) ? path : null;
  for (let dir = resolve(cwd), i = 0; i < 8; i++) {
    const candidate = join(dir, path);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export type RateCardFileResult =
  { ok: true; file: RateCardFile; path: string } | { ok: false; error: string };

export function loadRateCardFile(path: string): RateCardFileResult {
  const resolved = resolveConfigFile(path);
  if (!resolved) return { ok: false, error: `rate card file not found: ${path}` };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (err) {
    return { ok: false, error: `rate card file unreadable: ${String(err)}` };
  }
  const parsed = RateCardFileSchema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  return { ok: true, file: parsed.data, path: resolved };
}
