import { Link } from 'react-router-dom';
import type { RegistryEntry, RegistryRunDTO } from '@aoc/contracts';
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Money,
  RelativeTime,
  Widget,
  type DataTableColumn,
} from '../../components';
import { formatDateTime, formatDuration, formatMyr, formatTokens } from '../../lib/format';
import { executionCost, formatRunCost, modelLabel } from './registryModel';

function PerRun({ usd, tokens, durationMs, basis }: { usd: number | null; tokens: number | null; durationMs: number | null; basis?: string }) {
  if (usd === null) return <span className="reg-muted">—</span>;
  return (
    <span className="reg-perrun aoc-num">
      <b>{formatRunCost(usd)}</b>
      <span className="reg-sub">
        {basis === 'projected'
          ? 'projected · no execution run yet'
          : `${tokens !== null ? `${formatTokens(tokens)} tokens` : '—'} · ${durationMs !== null ? formatDuration(durationMs) : '—'}`}
      </span>
    </span>
  );
}

/** Runs and economics by process type: spend, cost/tokens/time per run, and what distillation saved. */
export function EconomicsByType({ entries }: { entries: readonly RegistryEntry[] }) {
  const rows = entries.filter((e) => e.discovery.runs + e.execution.runs + e.activeRuns > 0);
  const columns: DataTableColumn<RegistryEntry>[] = [
    {
      id: 'type',
      header: 'Process type',
      primary: true,
      sortValue: (e) => e.name,
      cell: (e) => (
        <span className="reg-rt__type">
          <b>{e.name}</b>
          <code>{e.processType}</code>
        </span>
      ),
    },
    {
      id: 'runs',
      header: 'Runs',
      numeric: true,
      sortValue: (e) => e.discovery.runs + e.execution.runs,
      cell: (e) => (
        <span className="reg-perrun">
          <b>{e.discovery.runs + e.execution.runs} finished</b>
          <span className="reg-sub">
            {e.discovery.runs} discovery · {e.execution.runs} execution
            {e.activeRuns > 0 ? ` · ${e.activeRuns} running` : ''}
          </span>
        </span>
      ),
    },
    {
      id: 'spend',
      header: 'Spend to date',
      numeric: true,
      sortValue: (e) => e.discovery.totalCostUsd + e.execution.totalCostUsd,
      cell: (e) => (
        <span className="reg-perrun">
          <Money usd={e.discovery.totalCostUsd + e.execution.totalCostUsd} usdOnly />
          <span className="reg-sub">{e.costBasis === 'none' ? 'no runs' : `notional · ${e.costBasis}`}</span>
        </span>
      ),
    },
    {
      id: 'disc',
      header: 'Per discovery run',
      numeric: true,
      sortValue: (e) => e.discovery.avgCostUsd,
      cell: (e) => (
        <PerRun
          usd={e.discovery.avgCostUsd}
          tokens={e.efficiency.discovery.avgTokens}
          durationMs={e.efficiency.discovery.avgDurationMs}
        />
      ),
    },
    {
      id: 'exec',
      header: 'Per execution run',
      numeric: true,
      sortValue: (e) => executionCost(e).usd,
      cell: (e) => {
        const x = executionCost(e);
        return (
          <PerRun
            usd={x.usd}
            basis={x.basis}
            tokens={e.efficiency.execution.avgTokens}
            durationMs={e.efficiency.execution.avgDurationMs}
          />
        );
      },
    },
    {
      id: 'saved',
      header: 'Saved to date',
      numeric: true,
      sortValue: (e) => e.realizedSavingsUsd,
      cell: (e) =>
        e.realizedSavingsUsd === null ? (
          <span className="reg-sub">{executionCost(e).basis === 'none' ? 'no execution path' : 'no execution run yet'}</span>
        ) : (
          <span className="reg-perrun">
            <b className="aoc-num">{formatRunCost(e.realizedSavingsUsd)}</b>
            <span className="reg-sub aoc-num">
              {e.savings.realizedRm !== null ? formatMyr(e.savings.realizedRm) : 'RM unavailable'}
              {e.savings.tokensSaved !== null ? ` · ${formatTokens(e.savings.tokensSaved)} tokens` : ''}
              {e.savings.timeSavedMs !== null ? ` · ${formatDuration(Math.max(0, e.savings.timeSavedMs))}` : ''}
            </span>
          </span>
        ),
    },
  ];
  return (
    <Widget
      span={12}
      id="economics"
      title="Runs and economics"
      subtitle="All finished runs · rollover chains count once · notional API-equivalent cost"
      info="Discovery runs ran without an approved playbook (or are discovery-class); execution runs followed one. Time is wall-clock from launch to the final end."
      flush
    >
      <DataTable
        caption="Runs and economics by process type"
        columns={columns}
        rows={rows}
        rowKey={(e) => e.processType}
        empty={<EmptyState size="sm" title="No runs yet" body="Economics appear once managed runs launch." />}
      />
    </Widget>
  );
}

const OUTCOME_TONE: Record<string, 'ok' | 'danger' | 'warn' | 'neutral'> = {
  completed: 'ok',
  failed: 'danger',
  killed: 'danger',
  abandoned: 'warn',
};

export interface RecentRunsProps {
  runs: readonly RegistryRunDTO[];
  entries: readonly RegistryEntry[];
  onDistill: (runId: string) => void;
}

/** Recent runs, newest first: kind, outcome, cost, tokens and time — completed runs can seed a playbook. */
export function RecentRuns({ runs, entries, onDistill }: RecentRunsProps) {
  const nameOf = (t: string) => entries.find((e) => e.processType === t)?.name ?? t;
  const pendingFor = (t: string) => entries.find((e) => e.processType === t)?.playbook.status === 'proposed';
  const columns: DataTableColumn<RegistryRunDTO>[] = [
    {
      id: 'run',
      header: 'Run',
      primary: true,
      cell: (r) => (
        <span className="reg-rt__type">
          <Link to={`/sessions/${encodeURIComponent(r.lastSessionId)}`}>{nameOf(r.processType)}</Link>
          <code>{r.runId}</code>
        </span>
      ),
    },
    {
      id: 'kind',
      header: 'Kind',
      sortValue: (r) => r.kind,
      cell: (r) => (
        <span className="reg-kind">
          <span className={`reg-sw reg-sw--${r.kind === 'execution' ? 'exec' : 'disc'}`} aria-hidden="true" />
          {r.kind === 'execution' ? 'Execution' : 'Discovery'} · {modelLabel(r.model)}
        </span>
      ),
    },
    {
      id: 'launched',
      header: 'Launched',
      sortValue: (r) => r.launchedAt,
      firstSort: 'desc',
      cell: (r) => (
        <span className="reg-perrun">
          <span title={formatDateTime(r.launchedAt)}>
            <RelativeTime value={r.launchedAt} suffix=" ago" />
          </span>
          <span className="reg-sub">{r.durationMs !== null ? `ran ${formatDuration(r.durationMs)}` : 'still running'}</span>
        </span>
      ),
    },
    {
      id: 'outcome',
      header: 'Outcome',
      sortValue: (r) => r.outcome ?? 'running',
      cell: (r) =>
        r.finished ? (
          <Badge tone={OUTCOME_TONE[r.outcome ?? ''] ?? 'neutral'} icon={r.outcome === 'completed' ? 'ok' : 'warn'}>
            {r.outcome ?? 'ended'}
          </Badge>
        ) : (
          <Badge icon="clock">running</Badge>
        ),
    },
    {
      id: 'cost',
      header: 'Cost',
      numeric: true,
      sortValue: (r) => r.costUsd,
      cell: (r) => (
        <span className="reg-perrun">
          <b>{formatRunCost(r.costUsd)}</b>
          <span className="reg-sub">
            {formatTokens(r.tokens)} tokens{r.finished && r.costUsd === 0 && r.tokens > 0 ? ' · unpriced' : ''}
          </span>
        </span>
      ),
    },
    {
      id: 'action',
      header: 'Playbook',
      align: 'end',
      cell: (r) =>
        r.playbookId ? (
          <a href="#playbooks" className="reg-sub">
            distilled
          </a>
        ) : r.finished && r.outcome === 'completed' ? (
          pendingFor(r.processType) ? (
            <span className="reg-sub">proposal for this type pending</span>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => onDistill(r.runId)}>
              Distill<span className="aoc-sr-only"> a playbook from run {r.runId}</span>
            </Button>
          )
        ) : null,
    },
  ];
  return (
    <Widget span={12} id="runs" title="Recent runs" subtitle={`Newest first · ${runs.length} shown`} flush>
      <DataTable
        caption="Recent runs"
        columns={columns}
        rows={runs}
        rowKey={(r) => r.runId}
        maxHeight={420}
        empty={<EmptyState size="sm" title="No runs yet" body="Runs launched with aoc run --type appear here." />}
      />
    </Widget>
  );
}
