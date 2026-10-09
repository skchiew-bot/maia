import type { AocModule } from '@aoc/kernel';

/** Options for the metering module (extend as needed; all fields optional). */
export interface MeteringModuleOptions {}

/** Wave-0 placeholder: the metering module agent replaces this with the real implementation (keep the factory name). */
export function createMeteringModule(_opts: MeteringModuleOptions = {}): AocModule {
  return { name: 'metering' };
}
