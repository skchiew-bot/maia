import type { AocModule } from '@aoc/kernel';

/** Options for the registry module (extend as needed; all fields optional). */
export interface RegistryModuleOptions {}

/** Wave-0 placeholder: the registry module agent replaces this with the real implementation (keep the factory name). */
export function createRegistryModule(_opts: RegistryModuleOptions = {}): AocModule {
  return { name: 'registry' };
}
