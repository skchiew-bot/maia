import { promotionProfileUses, promotionProfilesOf, type AocConfig, type ProcessType } from '@aoc/contracts';
import type { Logger } from '@aoc/kernel';

/** Start-up refusal of production mode: the promotion credential cannot be relied on, or could reach a session. */
export class PromotionProfileError extends Error {}

export interface PromotionProfileDeps {
  /** The profile names `file` (supervisor.credentialProfilesFile) defines; throws the reason when it cannot be read. */
  definedProfiles: (file: string) => string[];
  /** The registry's process types; null when it cannot be read right now (launches will say so). */
  types: () => ProcessType[] | null;
}

const WHERE = 'docs/runbooks/credential-isolation.md §4 item 9';

/**
 * What is wrong with the credential profiles of the push to a protected remote (promotion, rollback, break-glass):
 * a profile the configuration names that the credential profiles file does not define, which would fail a promotion
 * only after an Approver's passkey was spent on it; and a process type that names one, which would hand the
 * promotion credential to sessions (R1).
 */
export function promotionProfileProblems(config: AocConfig, deps: PromotionProfileDeps): string[] {
  const problems: string[] = [];
  const uses = promotionProfileUses(config);
  let defined: Set<string> | null = null;
  let why = 'supervisor.credentialProfilesFile is not configured';
  const file = config.supervisor.credentialProfilesFile;
  if (file) {
    try {
      defined = new Set(deps.definedProfiles(file));
      why = 'the credential profiles file does not define it';
    } catch (err) {
      why = (err as Error).message;
    }
  }
  for (const profile of promotionProfilesOf(config)) {
    if (defined?.has(profile)) continue;
    const keys = uses.filter((u) => u.profile === profile).map((u) => u.key);
    problems.push(`promotion credential profile "${profile}" (${keys.join(', ')}) is unusable: ${why} (${WHERE})`);
  }
  const promotion = new Set(promotionProfilesOf(config));
  for (const t of deps.types() ?? [])
    if (t.credentialProfile && promotion.has(t.credentialProfile))
      problems.push(
        `process type "${t.id}" names the promotion credential profile "${t.credentialProfile}": only aocd's own ` +
          `push may hold it, never a session (docs/runbooks/credential-isolation.md §4 item 7)`,
      );
  return problems;
}

/** Production refuses to start on any finding; development says so in the log and carries on. */
export function checkPromotionProfiles(config: AocConfig, deps: PromotionProfileDeps, log: Logger): void {
  const problems = promotionProfileProblems(config, deps);
  if (config.mode === 'production' && problems.length)
    throw new PromotionProfileError(`production mode: ${problems.join('; ')}`);
  for (const problem of problems) log.warn(problem);
}
