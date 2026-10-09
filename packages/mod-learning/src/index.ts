import type { AocModule } from '@aoc/kernel';

/** Options for the learning module (extend as needed; all fields optional). */
export interface LearningModuleOptions {}

/** Wave-0 placeholder: the learning module agent replaces this with the real implementation (keep the factory name). */
export function createLearningModule(_opts: LearningModuleOptions = {}): AocModule {
  return { name: 'learning' };
}
