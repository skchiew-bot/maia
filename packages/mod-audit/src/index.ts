import type { AocModule } from '@aoc/kernel';

/** Options for the audit module (extend as needed; all fields optional). */
export interface AuditModuleOptions {}

/** Wave-0 placeholder: the audit module agent replaces this with the real implementation (keep the factory name). */
export function createAuditModule(_opts: AuditModuleOptions = {}): AocModule {
  return { name: 'audit' };
}
