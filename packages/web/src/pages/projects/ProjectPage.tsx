import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api';
import {
  Button,
  Chip,
  EmptyState,
  ErrorState,
  InlineAlert,
  KpiStrip,
  KpiTile,
  PageHeader,
  RelativeTime,
  Widget,
  WidgetGrid,
  describeError,
  formatAge,
  formatInteger,
  formatMyr,
  formatPercent,
  formatShortDate,
  formatUsd,
  useNow,
  useToast,
} from '../../components';
import { useProjectData } from './data';
import { EditProjectDialog, EnhancementDialog, NewThreadDialog } from './dialogs';
import { MasterTimeline } from './MasterTimeline';
import { buildPeople, livenessCounts, liveTotal, weightText } from './model';
import {
  ChangeControlPanel,
  DecisionsPanel,
  DriftPanel,
  ProcessTypesPanel,
  ScopePanel,
  SessionsPanel,
  ThreadsPanel,
} from './panels';
import { LiveMix } from './parts';
import type { TimeScale } from './lanes';
import type { TaskFilter } from './TaskTable';
import './projects.css';

type DialogKind = 'edit' | 'enhancement' | 'thread' | null;

const TASK_FILTERS: readonly TaskFilter[] = ['all', 'open', 'flagged'];

function Loading() {
  return (
    <div className="prj-page-skeleton" aria-hidden="true">
      <div className="prj-skel prj-skel--kpis" />
      <div className="prj-skel prj-skel--hero" />
      <div className="prj-skel prj-skel--block" />
    </div>
  );
}

export default function ProjectPage() {
  const { id = '' } = useParams();
  const now = useNow();
  const toast = useToast();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const data = useProjectData(id);
  const { detail, timeline, history, sessions, decisions, changes, rollbacks, registry, playbooks, spend } =
    data;

  const filterParam = params.get('tasks');
  const filter: TaskFilter = TASK_FILTERS.includes(filterParam as TaskFilter)
    ? (filterParam as TaskFilter)
    : 'all';
  const setFilter = (f: TaskFilter) => {
    const next = new URLSearchParams(params);
    if (f === 'all') next.delete('tasks');
    else next.set('tasks', f);
    setParams(next, { replace: true });
  };

  const project = detail.data;
  const sessionList = useMemo(() => sessions.data ?? [], [sessions.data]);
  const sessionsById = useMemo(() => new Map(sessionList.map((s) => [s.sessionId, s])), [sessionList]);
  const people = useMemo(
    () =>
      buildPeople(sessionList, [
        ...(timeline.data?.phases.flatMap((p) => p.segments.map((s) => [s.ownerId, s.ownerName] as const)) ??
          []),
        ...(history.data?.scope.map((s) => [s.ownerId ?? '', s.ownerName] as const) ?? []),
        ...(timeline.data?.amendments.map((a) => [a.by, a.byName] as const) ?? []),
      ]),
    [sessionList, timeline.data, history.data],
  );

  const scale = useMemo<TimeScale | null>(() => {
    if (!project) return null;
    const times = [
      Date.parse(project.createdAt),
      ...(history.data?.scope.map((s) => Date.parse(s.at)) ?? []),
      ...(history.data?.drift.map((d) => Date.parse(d.at)) ?? []),
      ...(timeline.data?.manifest.flatMap((p) =>
        p.tasks.map((t) => (t.doneAt ? Date.parse(t.doneAt) : NaN)),
      ) ?? []),
    ].filter(Number.isFinite);
    const start = Math.min(...times);
    return { start, end: Math.max(now, ...times), now };
  }, [project, history.data, timeline.data, now]);

  // In-page links (#timeline, #drift…) and deep links from the list scroll once the target has rendered.
  const ready = Boolean(project && timeline.data);
  useEffect(() => {
    if (!ready || !location.hash) return;
    document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView?.({ block: 'start' });
  }, [ready, location.hash, location.key]);

  if (!project) {
    const notFound = detail.error instanceof ApiError && detail.error.status === 404;
    return (
      <>
        <PageHeader
          title={notFound ? 'Project not found' : 'Project'}
          breadcrumbs={[{ label: 'Projects', to: '/projects' }, { label: id }]}
        />
        {notFound ? (
          <EmptyState
            icon="projects"
            title="No project with this id"
            body={`Nothing in the ledger is called ${id}. It may have been typed wrong; projects are never deleted.`}
            action={<Link to="/projects">All projects</Link>}
          />
        ) : detail.error !== undefined ? (
          <ErrorState title="Couldn't load this project" error={detail.error} onRetry={detail.reload} />
        ) : (
          <>
            <p className="aoc-sr-only" role="status">
              Loading project…
            </p>
            <Loading />
          </>
        )}
      </>
    );
  }

  const progress = timeline.data?.progress ?? project.progress;
  const ratio = progress.totalWeight > 0 ? progress.doneWeight / progress.totalWeight : 0;
  const live = livenessCounts(sessionList, now);
  const openDecisions = decisions.data?.decisions ?? [];
  const oldestDecision = openDecisions.map((d) => d.createdAt).sort()[0];
  const spendRow = spend.resource.data?.rows.find((r) => r.key === project.projectId);
  const drift7d = history.data?.drift.filter((d) => now - Date.parse(d.at) <= 7 * 86_400_000) ?? [];
  const typeNames = new Map((registry.data?.types ?? []).map((t) => [t.id, t.name]));

  return (
    <>
      <PageHeader
        title={project.name}
        subtitle={project.description ?? 'No description yet.'}
        breadcrumbs={[{ label: 'Projects', to: '/projects' }, { label: project.name }]}
        actions={
          <>
            <Button icon="plus" onClick={() => setDialog('enhancement')}>
              Record enhancement
            </Button>
            <Button variant="ghost" onClick={() => setDialog('edit')}>
              Edit details
            </Button>
          </>
        }
        meta={
          <>
            {project.repoPath ? (
              <span className="prj-meta-item" title="Repository path">
                <span className="prj-meta-item__label">repo</span>
                <code>{project.repoPath}</code>
              </span>
            ) : (
              <span className="prj-meta-item prj-muted">no repository set</span>
            )}
            <Chip icon="changes">{project.defaultBranch ?? 'no default branch'}</Chip>
            <span className="prj-meta-item">
              <span className="prj-meta-item__label">slug</span>
              <code>{project.slug}</code>
            </span>
            <span className="prj-meta-item">created {formatShortDate(project.createdAt)}</span>
            <span className="prj-meta-item">
              {formatInteger(project.threads.length)} {project.threads.length === 1 ? 'thread' : 'threads'}
            </span>
          </>
        }
      />

      <KpiStrip label={`${project.name} at a glance`}>
        <KpiTile
          label="Completion"
          value={formatPercent(ratio)}
          unit="by weight"
          href="#timeline"
          footnote={`${weightText(progress.doneWeight)} of ${weightText(progress.totalWeight)} declared weight${
            progress.etaMs !== null ? ` · ETA ≈ ${formatAge(progress.etaMs)}` : ''
          }`}
          info="Weighted tasks done over tasks declared across every developer (xs 1 · s 2 · m 3 · l 5 · xl 8). ETA is hidden until three tasks are done."
        />
        <KpiTile
          label="Tasks done"
          value={progress.doneTasks}
          unit={`of ${formatInteger(progress.totalTasks)}`}
          tone={progress.flaggedTasks > 0 ? 'warn' : 'neutral'}
          href="?tasks=flagged#timeline"
          footnote={
            progress.flaggedTasks > 0
              ? `${formatInteger(progress.flaggedTasks)} flagged: no file change, counted until reviewed`
              : 'every close carried evidence'
          }
        />
        <KpiTile
          label="Open decisions"
          value={decisions.data ? openDecisions.length : project.openDecisions}
          tone={project.openDecisions > 0 ? 'warn' : 'neutral'}
          href="#decisions"
          footnote={
            oldestDecision ? (
              <>
                oldest waiting <RelativeTime value={oldestDecision} />
              </>
            ) : (
              'nothing waiting'
            )
          }
        />
        <KpiTile
          label="Live sessions"
          value={sessions.data ? liveTotal(live) : '—'}
          href="#sessions"
          footnote={<LiveMix counts={live} empty="none running" />}
        />
        <KpiTile
          label="Spend, 7 days"
          value={spend.resource.data ? formatUsd(spendRow?.notionalUsd ?? 0) : '—'}
          href="/metering"
          footnote={
            spend.resource.data
              ? `${spendRow?.notionalRm !== null && spendRow?.notionalRm !== undefined ? `${formatMyr(spendRow.notionalRm)} · ` : ''}notional, not a bill`
              : spend.resource.error
                ? 'unavailable for your role'
                : undefined
          }
          info="Notional API-equivalent cost of this project's tokens at the rate card over the last seven days, with RM at each day's BNM rate."
        />
        <KpiTile
          label="Drift, 7 days"
          value={history.data ? drift7d.length : '—'}
          tone={
            drift7d.some((d) => d.severity === 'high') ? 'danger' : drift7d.length > 0 ? 'warn' : 'neutral'
          }
          href="#drift"
          footnote={
            history.data
              ? `${formatInteger(drift7d.filter((d) => d.severity === 'high').length)} high · ${formatInteger(history.data.drift.length)} all time`
              : undefined
          }
        />
      </KpiStrip>

      <WidgetGrid>
        <Widget
          id="timeline"
          span={12}
          title="Master timeline"
          subtitle="tasks done over tasks declared across every developer, phases in manifest order"
          info="The project's plan manifest is the single master timeline (§9). Each phase completion pins an immutable git tag — the rollback points. Every task close carries evidence; closes with no file-changing tool call are flagged and still count until reviewed."
          busy={timeline.loading && timeline.data !== undefined}
        >
          {timeline.data && scale ? (
            timeline.data.manifest.length === 0 ? (
              <EmptyState
                size="sm"
                icon="projects"
                title="No plan declared yet"
                body="The master timeline starts when a session launched into this project declares its plan manifest (a managed session without one is blocked)."
              />
            ) : (
              <MasterTimeline
                manifest={timeline.data.manifest}
                progress={progress}
                history={history.data}
                rollbacks={rollbacks.data?.items}
                sessions={sessionList}
                people={people}
                scale={scale}
                filter={filter}
                onFilterChange={setFilter}
              />
            )
          ) : timeline.error !== undefined ? (
            <ErrorState
              size="sm"
              title="Couldn't load the master timeline"
              error={timeline.error}
              onRetry={timeline.reload}
            />
          ) : (
            <div className="prj-skel prj-skel--hero" aria-hidden="true" />
          )}
          {history.error !== undefined && timeline.data && (
            <InlineAlert
              tone="warn"
              title="Pins, drift and scope marks are unavailable"
              action={
                <button type="button" className="aoc-link-button" onClick={history.reload}>
                  Retry
                </button>
              }
            >
              {describeError(history.error)}
            </InlineAlert>
          )}
        </Widget>

        <Widget
          id="scope"
          span={7}
          title="Scope changes"
          subtitle="every change to the denominator · no silent scope creep"
          info="Plans declared into the project and audited amendments, each with who, when and the change to the declared weight. Tasks carried over at a rollover were already counted, so they add nothing."
          busy={history.loading && history.data !== undefined}
        >
          {history.data && timeline.data && scale ? (
            <ScopePanel
              history={history.data}
              manifest={timeline.data.manifest}
              scale={scale}
              people={people}
            />
          ) : history.error !== undefined ? (
            <ErrorState size="sm" error={history.error} onRetry={history.reload} />
          ) : (
            <div className="prj-skel prj-skel--block" aria-hidden="true" />
          )}
        </Widget>

        <Widget
          id="drift"
          span={5}
          title="Drift"
          subtitle="work that left the declared plan"
          info="Amber marks: file changes with no open task, playbook deviations, scope growth past the threshold, and tasks over their size budget."
          busy={history.loading && history.data !== undefined}
        >
          {history.data ? (
            <DriftPanel drift={history.data.drift} sessions={sessionsById} now={now} />
          ) : history.error !== undefined ? (
            <ErrorState size="sm" error={history.error} onRetry={history.reload} />
          ) : (
            <div className="prj-skel prj-skel--block" aria-hidden="true" />
          )}
        </Widget>

        <Widget
          id="sessions"
          span={12}
          flush
          title="Sessions"
          subtitle="disposable episodes under the project's threads, most urgent first"
          busy={sessions.loading && sessions.data !== undefined}
        >
          {sessions.data ? (
            <SessionsPanel sessions={sessionList} now={now} typeNames={typeNames} />
          ) : sessions.error !== undefined ? (
            <ErrorState size="sm" error={sessions.error} onRetry={sessions.reload} />
          ) : (
            <div className="prj-skel prj-skel--block" aria-hidden="true" />
          )}
        </Widget>

        <Widget
          id="threads"
          span={6}
          title="Threads and rollover lineage"
          subtitle="one writer at a time; rollover only at clean task boundaries"
          actions={
            <Button size="sm" variant="ghost" icon="plus" onClick={() => setDialog('thread')}>
              New thread
            </Button>
          }
        >
          <ThreadsPanel threads={project.threads} projectId={project.projectId} sessions={sessionsById} />
        </Widget>

        <Widget
          id="decisions"
          span={6}
          title="Open decisions"
          subtitle="human-required, oldest first"
          busy={decisions.loading && decisions.data !== undefined}
        >
          {decisions.data ? (
            <DecisionsPanel decisions={openDecisions} />
          ) : decisions.error !== undefined ? (
            <ErrorState size="sm" error={decisions.error} onRetry={decisions.reload} />
          ) : (
            <div className="prj-skel prj-skel--block" aria-hidden="true" />
          )}
        </Widget>

        <Widget
          id="changes"
          span={6}
          title="Change control"
          subtitle="change requests, rollbacks and the pinned rollback points"
          info="Rollback targets must be a pinned tag or a SHA recorded by a phase completion or change record. The supervisor verifies the target on a new branch before the Approver signs it off."
        >
          <ChangeControlPanel
            changes={changes.data?.items}
            rollbacks={rollbacks.data?.items}
            pins={history.data?.pins ?? []}
            projectId={project.projectId}
            errors={{
              changes: changes.error !== undefined && !changes.data,
              rollbacks: rollbacks.error !== undefined && !rollbacks.data,
            }}
          />
        </Widget>

        <Widget
          id="types"
          span={6}
          title="Process types and playbooks"
          subtitle="what ran here and how it is routed now"
          info="Process types are declared at launch from the fixed registry. A type with an approved playbook runs on its cheaper execution model; discovery always runs on Opus."
        >
          <ProcessTypesPanel sessions={sessionList} types={registry.data?.types} playbooks={playbooks.data} />
        </Widget>
      </WidgetGrid>

      {dialog === 'edit' && (
        <EditProjectDialog
          project={project}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            toast.notify({
              tone: 'ok',
              title: 'Project details saved',
              body: 'Recorded as project.updated under your name.',
            });
            detail.reload();
          }}
        />
      )}
      {dialog === 'enhancement' && (
        <EnhancementDialog
          projectId={project.projectId}
          sessions={sessionList}
          onClose={() => setDialog(null)}
          onRecorded={(e) => {
            setDialog(null);
            toast.notify({
              tone: 'ok',
              title: `Enhancement recorded: ${e.title}`,
              body: 'It shows as a teal mark on the master timeline.',
            });
            history.reload();
          }}
        />
      )}
      {dialog === 'thread' && (
        <NewThreadDialog
          projectId={project.projectId}
          onClose={() => setDialog(null)}
          onCreated={(t) => {
            setDialog(null);
            toast.notify({ tone: 'ok', title: `Thread created: ${t.title}` });
            detail.reload();
          }}
        />
      )}
    </>
  );
}
