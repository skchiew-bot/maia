import type { AocModule } from '@aoc/kernel';
import { createAuditModule } from '@aoc/mod-audit';
import { createChangeModule } from '@aoc/mod-change';
import { createCreditsModule } from '@aoc/mod-credits';
import { createDecisionsModule } from '@aoc/mod-decisions';
import { createEvidenceModule } from '@aoc/mod-evidence';
import { createFxModule } from '@aoc/mod-fx';
import { createIdentityModule } from '@aoc/mod-identity';
import { createIntakeModule } from '@aoc/mod-intake';
import { createLearningModule } from '@aoc/mod-learning';
import { createLedgerModule } from '@aoc/mod-ledger';
import { createMeteringModule } from '@aoc/mod-metering';
import { createRegistryModule } from '@aoc/mod-registry';
import { createSessionsModule } from '@aoc/mod-sessions';
import { createSupervisorModule } from '@aoc/supervisor';

export const MODULE_ORDER = [
  'identity',
  'registry',
  'sessions',
  'decisions',
  'ledger',
  'metering',
  'fx',
  'credits',
  'learning',
  'change',
  'audit',
  'evidence',
  'intake',
  'supervisor',
] as const;

/**
 * The production composition, in MODULE_ORDER. Modules are built with their defaults only: everything
 * they need comes from the runtime context (config, services), so the composition never depends on
 * a module's internals. The supervisor is last, so it is the first to stop.
 */
export function createDefaultModules(): AocModule[] {
  return [
    createIdentityModule(),
    createRegistryModule(),
    createSessionsModule(),
    createDecisionsModule(),
    createLedgerModule(),
    createMeteringModule(),
    createFxModule(),
    createCreditsModule(),
    createLearningModule(),
    createChangeModule(),
    createAuditModule(),
    createEvidenceModule(),
    createIntakeModule(),
    createSupervisorModule(),
  ];
}
