import type { AocModule } from '@aoc/kernel';

/** Options for the supervisor module (extend as needed; all fields optional). */
export interface SupervisorModuleOptions {}

/** Wave-0 placeholder: the supervisor module agent replaces this with the real implementation (keep the factory name). */
export function createSupervisorModule(_opts: SupervisorModuleOptions = {}): AocModule {
  return { name: 'supervisor' };
}
