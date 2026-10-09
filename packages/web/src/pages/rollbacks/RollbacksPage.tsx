import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import type { BreakglassDTO, PromotionDTO, RollbackDTO } from '@aoc/contracts';
import { useAuth } from '../../api/auth';
import type { StreamMessage } from '../../api/stream';
import { useResource } from '../../api/useResource';
import {
  Button,
  EmptyState,
  FilterBar,
  InlineAlert,
  PageHeader,
  Select,
  Widget,
  WidgetGrid,
} from '../../components';
import { useNow } from '../../lib/clock';
import { formatAge, formatInteger, toEpoch } from '../../lib/format';
import { PeopleProvider } from '../audit/people';
import { can } from '../audit/permissions';
import { LoadFailed, Skeleton } from '../audit/Skeleton';
import { useProjects } from '../changes/projects';
import { BreakglassDialog, BreakglassItem } from './Breakglass';
import { OPEN_ROLLBACK, postIncidentState } from './model';
import { PinsPanel } from './PinsPanel';
import { PromotionsTable } from './Promotions';
import { RequestRollbackDialog, type RollbackPrefill } from './RequestRollbackDialog';
import { RollbackItem } from './RollbackItem';
import './rollbacks.css';

const isRollbackEvent = (m: StreamMessage) => m.kind === 'aoc' && m.event.type.startsWith('rollback.');
const isBreakglassEvent = (m: StreamMessage) =>
  m.kind === 'aoc' &&
  (m.event.type.startsWith('breakglass.') ||
    m.event.type.startsWith('promotion.') ||
    m.event.type === 'change.completed' ||
    m.event.type === 'change.drafted');
const isPromotionEvent = (m: StreamMessage) => m.kind === 'aoc' && m.event.type.startsWith('promotion.');

const ROLLBACKS_SHOWN = 8;

function byOpenThenRecent(a: RollbackDTO, b: RollbackDTO): number {
  const oa = OPEN_ROLLBACK.has(a.status) ? 0 : 1;
  const ob = OPEN_ROLLBACK.has(b.status) ? 0 : 1;
  return oa - ob || toEpoch(b.requestedAt) - toEpoch(a.requestedAt);
}

function RollbacksView() {
  const { user } = useAuth();
  const now = useNow();
  const projects = useProjects();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const rollbacks = useResource<{ items: RollbackDTO[] }>('/api/rollbacks', {
    query: { limit: 200 },
    refreshOn: isRollbackEvent,
  });
  const breakglass = useResource<{ items: BreakglassDTO[] }>('/api/breakglass', {
    query: { limit: 100 },
    refreshOn: isBreakglassEvent,
  });
  const promotions = useResource<{ items: PromotionDTO[] }>('/api/promotions', {
    query: { limit: 200 },
    refreshOn: isPromotionEvent,
  });
  const [showAll, setShowAll] = useState(false);
  const [rollbackPrefill, setRollbackPrefill] = useState<RollbackPrefill | null>(null);
  const [invoking, setInvoking] = useState(false);

  const projectFilter = params.get('project') ?? '';
  const pinsProject = projectFilter || projects.projects[0]?.projectId || '';
  const isApprover = user?.role === 'approver';
  const canRequest = can(user, 'rollback.request');
  const canInvoke = can(user, 'breakglass.invoke');

  // Deep link from a change record: ?target=<pinned ref>&change=<id> opens the request prefilled.
  const target = params.get('target');
  useEffect(() => {
    if (!target || !canRequest) return;
    setRollbackPrefill({ projectId: projectFilter || undefined, target, changeId: params.get('change') });
    const next = new URLSearchParams(params);
    next.delete('target');
    next.delete('change');
    setParams(next, { replace: true });
  }, [target, canRequest, params, projectFilter, setParams]);

  const bgLoaded = breakglass.data !== undefined;
  useEffect(() => {
    if (location.hash === '#breakglass' && bgLoaded)
      document.getElementById('breakglass')?.scrollIntoView({ block: 'start' });
  }, [location.hash, bgLoaded]);

  const inProject = useCallback(
    <T extends { projectId: string }>(items: readonly T[] | undefined) =>
      (items ?? []).filter((x) => !projectFilter || x.projectId === projectFilter),
    [projectFilter],
  );
  const rb = useMemo(
    () => inProject(rollbacks.data?.items).sort(byOpenThenRecent),
    [rollbacks.data, inProject],
  );
  const bg = useMemo(() => inProject(breakglass.data?.items), [breakglass.data, inProject]);
  const pr = useMemo(() => inProject(promotions.data?.items), [promotions.data, inProject]);

  if (!rollbacks.data && !breakglass.data) {
    const error = rollbacks.error ?? breakglass.error;
    if (error)
      return (
        <LoadFailed
          what="rollbacks"
          error={error}
          onRetry={() => {
            rollbacks.reload();
            breakglass.reload();
          }}
        />
      );
    return <Skeleton label="Loading rollbacks" blocks={[40, 260, 320]} />;
  }

  const awaiting = rb.filter((r) => r.status === 'awaiting_approval');
  const verifying = rb.filter((r) => r.status === 'requested' || r.status === 'verifying');
  const bgPending = bg.filter((b) => b.status === 'pending');
  const incidents = bg.map((b) => postIncidentState(b, now));
  const overdue = incidents.filter((s) => s.kind === 'overdue').length;
  const nextDue = incidents
    .flatMap((s) => (s.kind === 'due' ? [s.remainingMs] : []))
    .sort((a, b) => a - b)[0];
  const shown = showAll ? rb : rb.slice(0, ROLLBACKS_SHOWN);

  return (
    <>
      <p className="rollbacks-summary" aria-live="polite">
        <strong>
          {formatInteger(awaiting.length)} {awaiting.length === 1 ? 'rollback waits' : 'rollbacks wait'} for
          the Approver's passkey
        </strong>
        {awaiting.length > 0 && (
          <>
            {' '}
            (oldest{' '}
            {formatAge(Math.max(...awaiting.map((r) => now - toEpoch(r.verification?.at ?? r.requestedAt))))})
          </>
        )}
        ; {formatInteger(verifying.length)} verifying on a branch; {formatInteger(bgPending.length)}{' '}
        break-glass {bgPending.length === 1 ? 'request waits' : 'requests wait'} for the Approver
        {overdue > 0
          ? `; ${formatInteger(overdue)} post-incident ${overdue === 1 ? 'record is' : 'records are'} overdue`
          : nextDue !== undefined
            ? `; the next post-incident record is due in ${formatAge(nextDue)}`
            : ''}
        .
      </p>
      <FilterBar
        label="Rollback filters"
        end={
          <span className="aoc-num">
            {formatInteger(rb.length)} rollbacks · {formatInteger(bg.length)} break-glass ·{' '}
            {formatInteger(pr.length)} promotions
          </span>
        }
      >
        <Select
          label="Project"
          fieldClassName="rollbacks-filter"
          value={projectFilter}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            if (e.target.value) next.set('project', e.target.value);
            else next.delete('project');
            setParams(next, { replace: true });
          }}
          options={[
            { value: '', label: 'All projects' },
            ...projects.projects.map((p) => ({ value: p.projectId, label: p.name })),
          ]}
        />
      </FilterBar>
      {(rollbacks.error !== undefined ||
        breakglass.error !== undefined ||
        promotions.error !== undefined) && (
        <InlineAlert tone="warn" title="Some of this page could not be refreshed">
          It shows the last loaded data.{' '}
          <button
            type="button"
            className="aoc-link-button"
            onClick={() => {
              rollbacks.reload();
              breakglass.reload();
              promotions.reload();
            }}
          >
            Retry
          </button>
        </InlineAlert>
      )}
      <WidgetGrid>
        <Widget
          span={12}
          title="Rollbacks through the gate"
          subtitle="requested → verified on its own branch → Approver passkey → restored on main"
          info="Rollback is real, not a form (§8): the supervisor checks the pinned state out on a new branch and runs that state's acceptance tests. Only a clean result raises the Approver's passkey decision, and nothing touches main before approval. The restore is a new commit, so history is kept."
          actions={
            canRequest ? (
              <Button
                size="sm"
                icon="rollbacks"
                onClick={() => setRollbackPrefill({ projectId: projectFilter || undefined })}
              >
                Request rollback
              </Button>
            ) : undefined
          }
        >
          {rb.length === 0 ? (
            <EmptyState
              size="sm"
              icon="rollbacks"
              title="No rollbacks requested"
              body="A rollback returns a project to a pinned state. Pick one under Pinned states to request it."
            />
          ) : (
            <>
              <ol className="rollbacks-list">
                {shown.map((r) => (
                  <RollbackItem
                    key={r.rollbackId}
                    rollback={r}
                    projectName={projects.nameOf(r.projectId)}
                    canApprove={isApprover}
                  />
                ))}
              </ol>
              {rb.length > ROLLBACKS_SHOWN && (
                <button
                  type="button"
                  className="aoc-link-button rollbacks-more"
                  onClick={() => setShowAll((v) => !v)}
                >
                  {showAll ? 'Show fewer' : `Show all ${formatInteger(rb.length)} rollbacks`}
                </button>
              )}
            </>
          )}
        </Widget>

        <Widget
          span={7}
          flush
          className="gov-flush"
          title="Pinned states"
          subtitle={`${projects.nameOf(pinsProject)} · the states a rollback can return to`}
          info="Every phase completion and completed change record pins an immutable tag or SHA (§8). Each is checked against the repository: a tag that was deleted or moved cannot be restored."
          actions={
            !projectFilter && projects.projects.length > 1 ? (
              <Select
                label="Project"
                fieldClassName="rollbacks-pins__project"
                value={pinsProject}
                onChange={(e) => {
                  const next = new URLSearchParams(params);
                  next.set('project', e.target.value);
                  setParams(next, { replace: true });
                }}
                options={projects.projects.map((p) => ({ value: p.projectId, label: p.name }))}
              />
            ) : undefined
          }
        >
          {pinsProject ? (
            <PinsPanel
              projectId={pinsProject}
              canRequest={canRequest}
              onRollback={(ref, changeId) =>
                setRollbackPrefill({ projectId: pinsProject, target: ref, changeId })
              }
            />
          ) : (
            <EmptyState size="sm" title="No projects yet" />
          )}
        </Widget>

        <Widget
          id="breakglass"
          span={5}
          title="Break-glass"
          subtitle="emergency promotion when production is down"
          info="Permitted only when production is down. It is the most heavily audited event, routes straight to the Approver, and auto-raises a mandatory post-incident change record due within 24 hours (§8)."
          actions={
            canInvoke ? (
              <Button size="sm" variant="danger" icon="warn" onClick={() => setInvoking(true)}>
                Break-glass…
              </Button>
            ) : undefined
          }
        >
          {!breakglass.data ? (
            breakglass.error ? (
              <LoadFailed what="break-glass records" error={breakglass.error} onRetry={breakglass.reload} />
            ) : (
              <Skeleton label="Loading break-glass records" blocks={[160]} />
            )
          ) : bg.length === 0 ? (
            <EmptyState
              size="sm"
              icon="warn"
              title="No break-glass used"
              body="Emergency promotions and their post-incident records appear here."
            />
          ) : (
            <ol className="rollbacks-list">
              {bg.map((b) => (
                <BreakglassItem
                  key={b.breakglassId}
                  b={b}
                  projectName={projects.nameOf(b.projectId)}
                  now={now}
                  canApprove={isApprover}
                />
              ))}
            </ol>
          )}
        </Widget>

        <Widget
          span={12}
          flush
          className="gov-flush"
          title="Promotions to main"
          subtitle="with the provenance check: every commit must trace to an approved gate"
          info="No orphan commits reach main (§14): each promotion traces every commit through an approved change record or fix plan, a UAT sign-off and a gate, or it is refused. Break-glass is the sole exception and says so. Select a promotion to see each commit's trace."
        >
          {promotions.data ? (
            <PromotionsTable promotions={pr} projectName={projects.nameOf} />
          ) : promotions.error ? (
            <LoadFailed what="promotions" error={promotions.error} onRetry={promotions.reload} />
          ) : (
            <Skeleton label="Loading promotions" blocks={[140]} />
          )}
        </Widget>
      </WidgetGrid>

      {user && rollbackPrefill && (
        <RequestRollbackDialog
          open
          onClose={() => setRollbackPrefill(null)}
          projects={projects}
          viewer={user}
          prefill={rollbackPrefill}
          onRequested={() => rollbacks.reload()}
        />
      )}
      {user && (
        <BreakglassDialog
          open={invoking}
          onClose={() => setInvoking(false)}
          projects={projects}
          viewer={user}
          defaultProjectId={projectFilter || undefined}
          onInvoked={() => breakglass.reload()}
        />
      )}
    </>
  );
}

export default function RollbacksPage() {
  return (
    <PeopleProvider>
      <PageHeader
        title="Rollbacks"
        subtitle="Gated rollbacks to pinned states, break-glass for production-down emergencies, and every promotion's provenance (§8, §14)."
        meta={<Link to="/changes">Change requests</Link>}
      />
      <RollbacksView />
    </PeopleProvider>
  );
}
