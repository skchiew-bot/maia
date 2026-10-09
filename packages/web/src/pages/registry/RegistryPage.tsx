import { useMemo, useState } from 'react';
import type {
  DecisionListResponse,
  DistillResponse,
  ModelDimensionReportDTO,
  PlaybookDTO,
  PlaybookRetireReason,
  RegistryEntry,
  RegistryRunsResponse,
  RegistryTypesResponse,
} from '@aoc/contracts';
import { apiPost } from '../../api/client';
import { useResource } from '../../api/useResource';
import {
  Button,
  ErrorState,
  PageHeader,
  ResourceView,
  Widget,
  WidgetGrid,
  useNow,
  useToast,
} from '../../components';
import { DistillationHero, HeroSkeleton } from './DistillationHero';
import { DistillDialog } from './DistillDialog';
import { EconomicsByType, RecentRuns } from './EconomicsPanels';
import { PlaybooksPanel } from './PlaybooksPanel';
import { RoutingPanel } from './RoutingPanel';
import { modelLabel, weekLabel } from './registryModel';
import { isEvent } from './streamEvents';
import { useNames } from './useNames';
import './registry.css';

const ECONOMICS_EVENTS = [
  'playbook.',
  'registry.changed',
  'session.launch_requested',
  'session.ended',
  'session.rollover_completed',
  'lesson.',
  'ratecard.published',
  'fx.rate_recorded',
  'rollup.closed',
];
const RUN_EVENTS = ['session.launch_requested', 'session.ended', 'session.rollover_completed', 'playbook.', 'ratecard.published'];

const LONG_DATE = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export default function RegistryPage() {
  const now = useNow();
  const toast = useToast();
  const nameOf = useNames();
  const entries = useResource<RegistryEntry[]>('/api/registry', { refreshOn: (m) => isEvent(m, ECONOMICS_EVENTS) });
  const types = useResource<RegistryTypesResponse>('/api/registry/process-types', {
    refreshOn: (m) => isEvent(m, ['registry.changed', 'playbook.']),
  });
  const playbooks = useResource<PlaybookDTO[]>('/api/playbooks', { refreshOn: (m) => isEvent(m, ['playbook.']) });
  const decisions = useResource<DecisionListResponse>('/api/decisions', {
    query: { kind: 'playbook_approval', status: 'open' },
    refreshOn: (m) => isEvent(m, ['decision.', 'playbook.']),
  });
  const runs = useResource<RegistryRunsResponse>('/api/registry/runs', {
    query: { limit: 200 },
    refreshOn: (m) => isEvent(m, RUN_EVENTS),
  });
  const modelReport = useResource<ModelDimensionReportDTO>('/api/learning/model-dimension', {
    refreshOn: (m) => isEvent(m, ['error.observed', 'rootcause.', 'offence.']),
  });
  const [distill, setDistill] = useState<{ open: boolean; runId: string | null }>({ open: false, runId: null });

  const openDecisions = useMemo(
    () => new Map((decisions.data?.decisions ?? []).map((d) => [d.id, d])),
    [decisions.data],
  );
  const reloadAll = () => {
    entries.reload();
    types.reload();
    playbooks.reload();
    decisions.reload();
    runs.reload();
  };

  const nameOfType = (t: string) => entries.data?.find((e) => e.processType === t)?.name ?? t;
  const actions = {
    resolve: async (decisionId: string, optionId: 'approve' | 'reject') => {
      await apiPost(`/api/decisions/${encodeURIComponent(decisionId)}/resolve`, { optionId });
      toast.notify({
        tone: 'ok',
        title: optionId === 'approve' ? 'Playbook approved' : 'Playbook rejected',
        body:
          optionId === 'approve'
            ? 'New runs of this process type launch on its execution model.'
            : 'Routing is unchanged; the run can be distilled again later.',
      });
      reloadAll();
    },
    retire: async (playbookId: string, reason: PlaybookRetireReason) => {
      await apiPost(`/api/playbooks/${encodeURIComponent(playbookId)}/retire`, { reason });
      toast.notify({ tone: 'ok', title: 'Playbook retired', body: 'New runs of this type launch on the discovery model.' });
      reloadAll();
    },
    distill: async (sessionId: string) => {
      const res = await apiPost<DistillResponse>('/api/playbooks/distill', { sessionId });
      toast.notify({
        tone: 'ok',
        title: `Playbook v${res.playbook.version} proposed for ${nameOfType(res.playbook.processType)}`,
        body: 'It waits for the Approver; routing changes only after approval.',
      });
      reloadAll();
    },
  };

  const weeks = entries.data?.[0]?.trend ?? [];
  const period =
    weeks.length > 0
      ? `${weekLabel(weeks[0]!.weekStart)}–${weekLabel(weeks[weeks.length - 1]!.weekStart)}, ${weeks.length} weeks to ${LONG_DATE.format(now)}`
      : null;

  return (
    <>
      <PageHeader
        title="Registry"
        subtitle={`Process types, playbooks and model routing${period ? ` · ${period}` : ''}`}
        actions={
          <Button icon="plus" onClick={() => setDistill({ open: true, runId: null })}>
            Distill a playbook
          </Button>
        }
      />
      {entries.data === undefined ? (
        entries.error ? (
          <ErrorState title="Couldn't load registry economics" error={entries.error} onRetry={entries.reload} />
        ) : (
          <HeroSkeleton />
        )
      ) : (
        <div className={entries.loading ? 'reg-busy' : undefined} aria-busy={entries.loading || undefined}>
          <DistillationHero
            entries={entries.data}
            playbooks={playbooks.data ?? []}
            runs={runs.data?.runs ?? []}
            modelReport={modelReport.data}
            nameOf={nameOf}
          />
        </div>
      )}

      <WidgetGrid>
        {types.data ? (
          <RoutingPanel types={types.data} entries={entries.data ?? []} />
        ) : (
          <Widget span={12} title="Model routing">
            <ResourceView resource={types} loadingText="Loading the process-type registry…" errorTitle="Couldn't load routing">
              {() => null}
            </ResourceView>
          </Widget>
        )}
      </WidgetGrid>

      <WidgetGrid>
        {playbooks.data ? (
          <PlaybooksPanel
            playbooks={playbooks.data}
            entries={entries.data ?? []}
            decisions={openDecisions}
            nameOf={nameOf}
            actions={actions}
            onDistill={() => setDistill({ open: true, runId: null })}
          />
        ) : (
          <Widget span={12} title="Playbooks">
            <ResourceView resource={playbooks} loadingText="Loading playbooks…" errorTitle="Couldn't load playbooks">
              {() => null}
            </ResourceView>
          </Widget>
        )}
      </WidgetGrid>

      <WidgetGrid>
        {entries.data && <EconomicsByType entries={entries.data} />}
        {runs.data ? (
          <RecentRuns
            runs={runs.data.runs}
            entries={entries.data ?? []}
            onDistill={(runId) => setDistill({ open: true, runId })}
          />
        ) : (
          <Widget span={12} title="Recent runs">
            <ResourceView resource={runs} loadingText="Loading runs…" errorTitle="Couldn't load runs">
              {() => null}
            </ResourceView>
          </Widget>
        )}
      </WidgetGrid>

      <DistillDialog
        open={distill.open}
        onClose={() => setDistill({ open: false, runId: null })}
        runs={runs.data?.runs ?? []}
        entries={entries.data ?? []}
        initialRunId={distill.runId}
        onDistill={actions.distill}
      />
      <p className="reg-foot">
        Costs are notional API-equivalent figures (decision support, not a bill). Routing never consults credits or
        budget: {modelLabel('opus')} for discovery is fixed by the registry.
      </p>
    </>
  );
}
