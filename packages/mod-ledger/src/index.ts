import type { AocModule } from '@aoc/kernel';

/** Options for the ledger module (extend as needed; all fields optional). */
export interface LedgerModuleOptions {}

/** Wave-0 placeholder: the ledger module agent replaces this with the real implementation (keep the factory name). */
export function createLedgerModule(_opts: LedgerModuleOptions = {}): AocModule {
  return { name: 'ledger' };
}
