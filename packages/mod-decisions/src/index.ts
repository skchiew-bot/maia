import type { AocModule } from '@aoc/kernel';

/** Options for the decisions module (extend as needed; all fields optional). */
export interface DecisionsModuleOptions {}

/** Wave-0 placeholder: the decisions module agent replaces this with the real implementation (keep the factory name). */
export function createDecisionsModule(_opts: DecisionsModuleOptions = {}): AocModule {
  return { name: 'decisions' };
}
