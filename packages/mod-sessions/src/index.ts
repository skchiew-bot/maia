import type { AocModule } from '@aoc/kernel';

/** Options for the sessions module (extend as needed; all fields optional). */
export interface SessionsModuleOptions {}

/** Wave-0 placeholder: the sessions module agent replaces this with the real implementation (keep the factory name). */
export function createSessionsModule(_opts: SessionsModuleOptions = {}): AocModule {
  return { name: 'sessions' };
}
