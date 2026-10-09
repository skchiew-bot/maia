import type { AocModule } from '@aoc/kernel';

/** Options for the fx module (extend as needed; all fields optional). */
export interface FxModuleOptions {}

/** Wave-0 placeholder: the fx module agent replaces this with the real implementation (keep the factory name). */
export function createFxModule(_opts: FxModuleOptions = {}): AocModule {
  return { name: 'fx' };
}
