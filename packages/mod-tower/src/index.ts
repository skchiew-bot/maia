import type { AocModule } from '@aoc/kernel';

/** Options for the Control Tower module. */
export interface TowerModuleOptions {}

/** Placeholder: the tower agent replaces this with the real implementation (keep the factory name). */
export function createTowerModule(_opts: TowerModuleOptions = {}): AocModule {
  return { name: 'tower' };
}
