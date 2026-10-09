import type { AocModule } from '@aoc/kernel';

/** Options for the change module (extend as needed; all fields optional). */
export interface ChangeModuleOptions {}

/** Wave-0 placeholder: the change module agent replaces this with the real implementation (keep the factory name). */
export function createChangeModule(_opts: ChangeModuleOptions = {}): AocModule {
  return { name: 'change' };
}
