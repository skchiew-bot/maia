import type { AocModule } from '@aoc/kernel';

/** Options for the evidence module (extend as needed; all fields optional). */
export interface EvidenceModuleOptions {}

/** Wave-0 placeholder: the evidence module agent replaces this with the real implementation (keep the factory name). */
export function createEvidenceModule(_opts: EvidenceModuleOptions = {}): AocModule {
  return { name: 'evidence' };
}
