/** Assembles the TowerSnapshot from the tower's projections (pure reads) plus optional services. */
import type { TowerKpis, TowerSnapshot } from '@aoc/contracts';
import { localDate, type ModuleContext } from '@aoc/kernel';
import { buildAnomalies } from './anomalies';
import { buildAttention } from './attention';
import { buildFleet } from './fleet';
import { buildFlow } from './flow';
import { buildIntegrity } from './integrity';
import type { ReadCtx } from './read';
import { GATE_SLA_MS, formatDuration } from './scoring';
import { TowerServices } from './services';
import { buildSpend } from './spend';
import { startOfLocalDay } from './zoned';

export interface SnapshotQuery {
  projectId?: string | null;
}

export class TowerReadModel {
  private readonly warned = new Set<string>();

  constructor(private readonly ctx: ModuleContext) {}

  snapshot(q: SnapshotQuery = {}): TowerSnapshot {
    const now = this.ctx.clock.now();
    const tz = this.ctx.config.timezone;
    const r: ReadCtx = {
      db: this.ctx.db,
      store: this.ctx.store,
      svc: new TowerServices(this.ctx, this.warned),
      now,
      tz,
      today: localDate(now, tz),
      midnight: startOfLocalDay(now, tz),
      projectId: q.projectId ?? null,
      projectNames: new Map(
        (
          this.ctx.db.prepare('SELECT project_id, name FROM twr_projects').all() as {
            project_id: string;
            name: string | null;
          }[]
        ).map((p) => [p.project_id, p.name]),
      ),
    };
    // Synchronous from here on: no event can land mid-read, so every section sees the same log position.
    const { integrity, facts } = buildIntegrity(r);
    const attention = buildAttention(r, facts);
    const flow = buildFlow(r);
    const kpis: TowerKpis = {
      needsYou: attention.length,
      oldestNeedsYouSince: attention.length ? attention.map((a) => a.since).sort()[0]! : null,
      tasksVerifiedToday: flow.tasksVerifiedToday,
      tasksVerifiedBaseline: flow.tasksVerifiedBaseline,
      gateLatencyP50Ms: flow.gateLatencyP50Ms,
      gateLatencyP90Ms: flow.gateLatencyP90Ms,
      gateSlaMs: GATE_SLA_MS,
      openPastSla: flow.openPastSla,
      openTickets: flow.openTickets,
      oldestTicketSince: flow.oldestTicketSince,
      chainOk: integrity.chainOk,
      anchorAgeMs: integrity.anchorAgeMs,
    };
    return {
      generatedAt: new Date(now).toISOString(),
      summary: summarize(kpis, now),
      kpis,
      attention,
      flow: flow.flow,
      fleet: buildFleet(r),
      spend: buildSpend(r),
      integrity,
      anomalies: buildAnomalies(r),
    };
  }
}

/** "6 items need you; oldest 2h 14m. Flow 23 verified tasks vs 19 baseline. Gate latency p50 31m (SLA 1h)." */
export function summarize(k: TowerKpis, now: number): string {
  const parts: string[] = [];
  if (k.needsYou === 0) parts.push('Nothing needs you right now.');
  else {
    const oldest = k.oldestNeedsYouSince ? formatDuration(now - Date.parse(k.oldestNeedsYouSince)) : null;
    parts.push(
      `${k.needsYou} item${k.needsYou === 1 ? ' needs' : 's need'} you${oldest ? `; oldest ${oldest}` : ''}.`,
    );
  }
  const done = k.tasksVerifiedToday;
  parts.push(
    `Flow ${done} verified task${done === 1 ? '' : 's'} vs ${Math.round(k.tasksVerifiedBaseline)} baseline.`,
  );
  parts.push(
    k.gateLatencyP50Ms === null
      ? 'No gate decisions resolved in 7d.'
      : `Gate latency p50 ${formatDuration(k.gateLatencyP50Ms)} (SLA ${formatDuration(k.gateSlaMs)}).`,
  );
  if (k.chainOk === false) parts.push('Audit chain verification failed.');
  return parts.join(' ');
}
