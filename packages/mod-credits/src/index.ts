import type { AocModule } from '@aoc/kernel';

/** Options for the credits module (extend as needed; all fields optional). */
export interface CreditsModuleOptions {}

/** Wave-0 placeholder: the credits module agent replaces this with the real implementation (keep the factory name). */
export function createCreditsModule(_opts: CreditsModuleOptions = {}): AocModule {
  return { name: 'credits' };
}
