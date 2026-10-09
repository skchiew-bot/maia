import type { AocModule } from '@aoc/kernel';

/** Options for the intake module (extend as needed; all fields optional). */
export interface IntakeModuleOptions {}

/** Wave-0 placeholder: the intake module agent replaces this with the real implementation (keep the factory name). */
export function createIntakeModule(_opts: IntakeModuleOptions = {}): AocModule {
  return { name: 'intake' };
}
