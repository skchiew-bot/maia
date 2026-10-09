import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { AffirmRateDTO, ChangeRequestDTO, ChangeScope, ChangeStatus } from '@aoc/contracts';
import { useAuth } from '../../api/auth';
import type { StreamMessage } from '../../api/stream';
import { useResource } from '../../api/useResource';
import {
  Badge,
  Button,
  Chip,
  DataTable,
  EmptyState,
  FilterBar,
  InlineAlert,
  PageHeader,
  RelativeTime,
  Select,
  Widget,
  WidgetGrid,
  type DataTableColumn,
} from '../../components';
import { useNow } from '../../lib/clock';
import { formatAge, formatInteger, formatPercent, toEpoch } from '../../lib/format';
import { PeopleProvider, PersonName, usePeople } from '../audit/people';
import { can } from '../audit/permissions';
import { LoadFailed, Skeleton } from '../audit/Skeleton';
import { ChangePipeline } from './ChangePipeline';
import { FieldPips, RefValue } from './bits';
import {
  SCOPE_META,
  SCOPE_ORDER,
  STAGE_ORDER,
  STATUS_META,
  blockedBySoleApprover,
  buildPipeline,
  isClosed,
  shortId,
  stageSince,
} from './model';
import { NewChangeDialog } from './NewChangeDialog';
import { useProjects, type ProjectIndex } from './projects';
import './changes.css';

const isChangeEvent = (m: StreamMessage) =>
  m.kind === 'aoc' &&
  (m.event.type.startsWith('change.') ||
    m.event.type.startsWith('breakglass.') ||
    m.event.type === 'git.ref_pinned' ||
    m.event.type === 'decision.withdrawn');

const isAffirmEvent = (m: StreamMessage) => m.kind === 'aoc' && m.event.type === 'change.field_affirmed';

/** Attention first (waiting on approval, post-incident records), then open work by age, then closed by recency. */
function rank(c: ChangeRequestDTO): number {
  if (c.breakglassId && c.status !== 'completed') return 0;
  if (c.status === 'submitted') return 1;
  return isClosed(c.status) ? 3 : 2;
}

function sortRows(rows: readonly ChangeRequestDTO[]): ChangeRequestDTO[] {
  return [...rows].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    const ta = toEpoch(stageSince(a));
    const tb = toEpoch(stageSince(b));
    return isClosed(a.status) ? tb - ta : ta - tb;
  });
}

function StatusCell({ c, now }: { c: ChangeRequestDTO; now: number }) {
  const meta = STATUS_META[c.status];
  const { approvers } = usePeople();
  const sodBlocked =
    c.status === 'submitted' && !c.selfApprovable && blockedBySoleApprover(c.submittedBy, approvers);
  return (
    <span className="changes-status">
      <Badge tone={meta.tone} icon={meta.icon}>
        {meta.label}
      </Badge>
      {c.approval?.selfApproved && <Chip>self-approved</Chip>}
      {c.breakglassId && c.dueAt && c.status !== 'completed' && (
        <Badge tone={c.overdue ? 'danger' : 'warn'} icon={c.overdue ? 'danger' : 'clock'} variant="outline">
          {c.overdue
            ? `post-incident overdue ${formatAge(now - toEpoch(c.dueAt))}`
            : `post-incident due in ${formatAge(toEpoch(c.dueAt) - now)}`}
        </Badge>
      )}
      {sodBlocked && (
        <Badge tone="warn" icon="warn" variant="outline">
          needs a second Approver
        </Badge>
      )}
    </span>
  );
}

function AffirmLens({ data }: { data: AffirmRateDTO }) {
  const t = data.totals;
  return (
    <div className="changes-lens">
      <dl className="changes-lens__totals">
        <div>
          <dt>Fields affirmed</dt>
          <dd className="aoc-num">{formatInteger(t.affirmations)}</dd>
        </div>
        <div>
          <dt>Affirmed without edit</dt>
          <dd className="aoc-num">
            {formatPercent(t.affirmWithoutEditRate)} <span>({formatInteger(t.affirmedWithoutEdit)})</span>
          </dd>
        </div>
        <div>
          <dt>Blind one-click confirms</dt>
          <dd className="aoc-num">
            {formatInteger(t.flagged)} <span>under {formatAge(data.blindDwellMs)} without an edit</span>
          </dd>
        </div>
        <div>
          <dt>Mean change from the draft</dt>
          <dd className="aoc-num">
            {formatPercent(t.meanEditRatio)} <span>100% = written from scratch</span>
          </dd>
        </div>
      </dl>
      {data.rows.length > 0 && (
        <details className="changes-lens__people">
          <summary>Per developer, ordered by name ({formatInteger(data.rows.length)})</summary>
          <table className="changes-lens__table">
            <caption className="aoc-sr-only">Affirmations per developer, ordered by name</caption>
            <thead>
              <tr>
                <th scope="col">Developer</th>
                <th scope="col" className="is-end">
                  Affirmed
                </th>
                <th scope="col" className="is-end">
                  Without edit
                </th>
                <th scope="col" className="is-end">
                  Blind
                </th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.userId}>
                  <th scope="row">{r.name ?? <PersonName id={r.userId} />}</th>
                  <td className="is-end aoc-num">{formatInteger(r.affirmations)}</td>
                  <td className="is-end aoc-num">{formatPercent(r.affirmWithoutEditRate)}</td>
                  <td className="is-end aoc-num">{formatInteger(r.flagged)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

function ChangesView({ projects }: { projects: ProjectIndex }) {
  const { user } = useAuth();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const changes = useResource<{ items: ChangeRequestDTO[] }>('/api/changes', {
    query: { limit: 500 },
    refreshOn: isChangeEvent,
  });
  const isApprover = user?.role === 'approver';
  const lens = useResource<AffirmRateDTO>(isApprover ? '/api/governance/affirm-rate' : null, {
    refreshOn: isAffirmEvent,
  });
  const { approvers } = usePeople();

  const stage = (STAGE_ORDER as readonly string[]).includes(params.get('stage') ?? '')
    ? (params.get('stage') as ChangeStatus)
    : null;
  const projectFilter = params.get('project') ?? '';
  const scopeFilter = (SCOPE_ORDER as readonly string[]).includes(params.get('scope') ?? '')
    ? (params.get('scope') as ChangeScope)
    : '';
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const all = changes.data?.items;
  const scoped = useMemo(
    () =>
      (all ?? []).filter(
        (c) => (!projectFilter || c.projectId === projectFilter) && (!scopeFilter || c.scope === scopeFilter),
      ),
    [all, projectFilter, scopeFilter],
  );
  const stages = useMemo(() => buildPipeline(scoped, now), [scoped, now]);
  const rows = useMemo(
    () => sortRows(stage ? scoped.filter((c) => c.status === stage) : scoped),
    [scoped, stage],
  );

  const columns = useMemo<DataTableColumn<ChangeRequestDTO>[]>(
    () => [
      {
        id: 'title',
        header: 'Change request',
        primary: true,
        sortValue: (c) => c.title ?? c.changeId,
        cell: (c) => (
          <span className="changes-cell-title">
            <span className="changes-cell-title__text">
              {c.erased ? '[erased]' : (c.title ?? 'Untitled change')}
            </span>
            <span className="changes-cell-title__id">
              {shortId(c.changeId)}
              {c.breakglassId ? ' · post-incident' : ''}
            </span>
          </span>
        ),
      },
      {
        id: 'project',
        header: 'Project',
        sortValue: (c) => projects.nameOf(c.projectId),
        cell: (c) => projects.nameOf(c.projectId),
      },
      {
        id: 'scope',
        header: 'Scope',
        sortValue: (c) => SCOPE_ORDER.indexOf(c.scope),
        cell: (c) => (
          <span className="changes-scope-cell">
            {SCOPE_META[c.scope].label}
            <span className="changes-scope-cell__gate">
              {SCOPE_META[c.scope].gate === 'self' ? 'self-approve' : 'Approver'}
            </span>
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        sortValue: (c) => STAGE_ORDER.indexOf(c.status),
        sortLabels: ['Pipeline order', 'Reverse pipeline order'],
        cell: (c) => <StatusCell c={c} now={now} />,
      },
      {
        id: 'fields',
        header: 'Fields',
        sortValue: (c) => c.affirmedCount,
        numeric: true,
        cell: (c) => <FieldPips change={c} />,
      },
      {
        id: 'owner',
        header: 'Developer',
        sortValue: (c) => c.ownerId ?? '',
        cell: (c) => <PersonName id={c.ownerId ?? c.createdBy} />,
      },
      {
        id: 'age',
        header: 'In stage',
        numeric: true,
        sortValue: (c) => now - toEpoch(stageSince(c)),
        cell: (c) => <RelativeTime value={stageSince(c)} now={now} />,
      },
      {
        id: 'rollback',
        header: 'Rollback point',
        hideOnMobile: true,
        cell: (c) =>
          c.pinnedTag || c.pinnedSha ? (
            <RefValue refName={c.pinnedTag} sha={c.pinnedSha} label="pinned" />
          ) : c.rollbackRef ? (
            <RefValue refName={c.rollbackRef} sha={c.rollbackSha} label="returns to" />
          ) : (
            <span className="changes-muted">not named yet</span>
          ),
      },
    ],
    [now, projects],
  );

  if (!all) {
    if (changes.error)
      return <LoadFailed what="change requests" error={changes.error} onRetry={changes.reload} />;
    return <Skeleton label="Loading change requests" blocks={[40, 150, 360]} />;
  }

  const awaiting = scoped.filter((c) => c.status === 'submitted');
  const postIncident = scoped.filter((c) => c.breakglassId && c.status !== 'completed');
  const overdue = postIncident.filter((c) => c.overdue);
  const nextDue = postIncident
    .filter((c) => !c.overdue && c.dueAt)
    .map((c) => toEpoch(c.dueAt!))
    .sort((a, b) => a - b)[0];
  const oldestAwaiting = awaiting.length
    ? Math.max(...awaiting.map((c) => now - toEpoch(stageSince(c))))
    : undefined;
  const sodWaiting = awaiting.filter(
    (c) => !c.selfApprovable && blockedBySoleApprover(c.submittedBy, approvers),
  );
  const selfApproved = scoped.filter((c) => c.approval?.selfApproved).length;

  return (
    <>
      {changes.error !== undefined && (
        <InlineAlert tone="warn" title="Showing the last loaded change requests">
          The latest refresh failed.{' '}
          <button type="button" className="aoc-link-button" onClick={changes.reload}>
            Retry
          </button>
        </InlineAlert>
      )}
      <p className="changes-summary" aria-live="polite">
        <strong>
          {formatInteger(awaiting.length + postIncident.length)}{' '}
          {awaiting.length + postIncident.length === 1 ? 'record needs' : 'records need'} a human
        </strong>
        {': '}
        {formatInteger(awaiting.length)} awaiting approval
        {oldestAwaiting !== undefined && <> (oldest {formatAge(oldestAwaiting)})</>}
        {sodWaiting.length > 0 && (
          <>
            , {formatInteger(sodWaiting.length)} of them raised by the only Approver and waiting for a second
            Approver
          </>
        )}
        {'; '}
        {postIncident.length === 0 ? (
          'no post-incident record open'
        ) : (
          <>
            {formatInteger(postIncident.length)} post-incident{' '}
            {postIncident.length === 1 ? 'record' : 'records'}
            {overdue.length > 0
              ? ` (${formatInteger(overdue.length)} overdue)`
              : nextDue !== undefined
                ? ` (next due in ${formatAge(nextDue - now)})`
                : ''}
          </>
        )}
        . {formatInteger(selfApproved)} self-approved {selfApproved === 1 ? 'record' : 'records'} kept in
        full.
      </p>
      <FilterBar
        label="Change filters"
        end={
          <span className="aoc-num">
            {formatInteger(rows.length)} of {formatInteger(all.length)} records
          </span>
        }
      >
        <Select
          label="Project"
          fieldClassName="changes-filter"
          value={projectFilter}
          onChange={(e) => setParam('project', e.target.value || null)}
          options={[
            { value: '', label: 'All projects' },
            ...projects.projects.map((p) => ({ value: p.projectId, label: p.name })),
          ]}
        />
        <Select
          label="Scope"
          fieldClassName="changes-filter"
          value={scopeFilter}
          onChange={(e) => setParam('scope', e.target.value || null)}
          options={[
            { value: '', label: 'All scopes' },
            ...SCOPE_ORDER.map((s) => ({ value: s, label: SCOPE_META[s].label })),
          ]}
        />
        {stage && (
          <Chip onRemove={() => setParam('stage', null)} removeLabel="Clear the stage filter">
            Stage: {STATUS_META[stage].label}
          </Chip>
        )}
      </FilterBar>
      <WidgetGrid>
        <Widget
          span={12}
          title="Change pipeline"
          subtitle="time waiting in each stage; select a stage to filter"
          info="Every post-MVP change is a change request (§8). Drafting ends when all four fields are affirmed and it is submitted. Main, production and data changes wait for the Approver; reversible off-main work is self-approved but kept as a full record. Completed records pin an immutable tag."
        >
          <ChangePipeline stages={stages} selected={stage} onSelect={(s) => setParam('stage', s)} />
        </Widget>
        <Widget
          span={12}
          flush
          title="Change requests"
          subtitle={stage ? `${STATUS_META[stage].label} only` : 'needs-a-human first, then by time in stage'}
        >
          <DataTable
            caption="Change requests"
            columns={columns}
            rows={rows}
            rowKey={(c) => c.changeId}
            rowHref={(c) => `/changes/${encodeURIComponent(c.changeId)}`}
            rowTone={(c) =>
              c.breakglassId && c.overdue ? 'danger' : c.status === 'submitted' ? 'warn' : undefined
            }
            empty={
              <EmptyState
                size="sm"
                icon="changes"
                title={all.length ? 'No change requests match these filters' : 'No change requests yet'}
                body={
                  all.length
                    ? 'Clear a filter to see the others.'
                    : 'A change request appears when a developer drafts one here, an agent drafts one for its session, or a break-glass raises its post-incident record.'
                }
              />
            }
          />
        </Widget>
        {isApprover && (
          <Widget
            span={12}
            title="Edit-or-affirm accountability"
            subtitle="portfolio lens · ordered by name, never ranked"
            info="AI drafts the change-record fields; each must be actively edited or affirmed (§14). An affirmation without an edit after only a moment's review is flagged as a blind one-click confirm."
          >
            {lens.data ? (
              <AffirmLens data={lens.data} />
            ) : lens.error ? (
              <LoadFailed what="the affirmation lens" error={lens.error} onRetry={lens.reload} />
            ) : (
              <Skeleton label="Loading the affirmation lens" blocks={[56]} />
            )}
          </Widget>
        )}
      </WidgetGrid>
    </>
  );
}

export default function ChangesPage() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const projects = useProjects();
  const [creating, setCreating] = useState(false);
  const canCreate = can(user, 'change.create');
  return (
    <PeopleProvider>
      <PageHeader
        title="Changes"
        subtitle="Change requests are first-class decisions: impact, mitigation, rollback target and acceptance test before work starts (§8)."
        actions={
          canCreate ? (
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              New change request
            </Button>
          ) : undefined
        }
        meta={
          <Link to="/rollbacks" className="changes-headlink">
            Rollbacks and break-glass
          </Link>
        }
      />
      <ChangesView projects={projects} />
      {user && canCreate && (
        <NewChangeDialog
          open={creating}
          onClose={() => setCreating(false)}
          projects={projects}
          viewerId={user.id}
          defaultProjectId={params.get('project') || undefined}
        />
      )}
    </PeopleProvider>
  );
}
