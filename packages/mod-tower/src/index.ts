import { parseQuery, requirePermission, type AocModule } from '@aoc/kernel';
import { z } from 'zod';
import { createTowerProjector } from './projector';
import { TowerReadModel } from './snapshot';

export { TowerReadModel, summarize, type SnapshotQuery } from './snapshot';
export { TOWER_HANDLES, TOWER_TABLES } from './projector';
export {
  agePoints,
  cleanTitle,
  costOfDelay,
  decisionDueMs,
  decisionImpact,
  decisionSlaMs,
  displayScore,
  formatDuration,
  severityOf,
  AGEING_POINTS,
  ANCHOR_MAX_AGE_MS,
  ATTENTION_SCALE_MS,
  DECISION_SLA_MS,
  GATE_SLA_MS,
  IMPACT,
  TICKET_IMPACT,
  TICKET_SLA_MS,
} from './scoring';

/** Options for the Control Tower module (all behaviour follows `config.timezone` and the shared event stream). */
export interface TowerModuleOptions {}

const TowerQuery = z.object({ projectId: z.string().min(1).max(64).optional() });

/**
 * Control Tower (§4, §6–§8, §10, §11, §13, §14): the Approver's landing view. Exception-first attention queue
 * ranked by cost of delay with inline intervention, flow, fleet, spend, integrity and a portfolio-only anomaly
 * radar — all computed from the tower's own `twr_*` projections over the shared event stream.
 */
export function createTowerModule(_opts: TowerModuleOptions = {}): AocModule {
  let model: TowerReadModel | null = null;
  return {
    name: 'tower',
    projectors: [createTowerProjector()],
    init(ctx) {
      model = new TowerReadModel(ctx);
    },
    routes(app) {
      // Approvers and Builders (audit.view); requesters never see internal operations (§6).
      app.get('/api/tower', (c) => {
        requirePermission(c, 'audit.view');
        const q = parseQuery(c, TowerQuery);
        return c.json(model!.snapshot({ projectId: q.projectId ?? null }));
      });
    },
  };
}
