import type { AocModule } from '@aoc/kernel';

/** Options for the identity module (extend as needed; all fields optional). */
export interface IdentityModuleOptions {}

/** Wave-0 placeholder: the identity module agent replaces this with the real implementation (keep the factory name). */
export function createIdentityModule(_opts: IdentityModuleOptions = {}): AocModule {
  return { name: 'identity' };
}
