import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CostPerOutcomeDTO } from '@aoc/contracts';
import { ApiError, type ResourceState } from '../../api';
import {
  Button,
  Chip,
  DataTable,
  EmptyState,
  Icon,
  RelativeTime,
  ResourceView,
  SegmentedControl,
  Widget,
  type DataTableColumn,
} from '../../components';
import { formatInteger, formatShortDate } from '../../lib/format';
import { shortId } from '../audit/ids';
import { OutcomeMarks } from './OutcomeMarks';
import {
  OUTCOME_KINDS,
  activeProcessType,
  byProject,
  noOutcomes,
  outcomeAxis,
  outcomeClasses,
  outcomeMyr,
  outcomeRows,
  outcomeUsd,
  phaseIdOf,
  processTypes,
  rmIncompleteText,
  withProcessType,
  type OutcomeClassView,
  type OutcomeKindInfo,
  type OutcomeRow,
  type ProcessTypeCount,
  type ProjectOutcomes,
} from './outcomeModel';

type View = 'list' | 'project';
const VIEWS: readonly { value: View; label: string }[] = [
  { value: 'list', label: 'Outcomes' },
  { value: 'project', label: 'By project' },
];

const INFO =
  'Notional spend tied to what it produced: a ticket closed as fixed, a change completed, a phase completed. A portfolio lens, never a ranking of people. API-equivalent cost, not a bill.';

function RmIncomplete() {
  return (
    <span className="met-flag">
      <Icon name="warn" size={12} />
      RM incomplete
    </span>
  );
}

/**
 * Notional US$ with the daemon's ringgit under it, never converted here. `rm` is null when there is no figure to show;
 * `rmComplete` false says some usage was left out of it, so the cost never reads as complete. An outcome with usage no
 * rate priced says so too.
 */
function OutcomeMoney({
  usd,
  rm,
  rmComplete,
  unpriced,
}: {
  usd: number;
  rm: number | null;
  rmComplete: boolean;
  unpriced?: boolean;
}) {
  return (
    <span className="met-out__money aoc-num">
      <b>{outcomeUsd(usd)}</b>
      <span className="met-sub">
        {rm !== null && outcomeMyr(rm)}
        {!rmComplete && <RmIncomplete />}
        {unpriced && (
          <span className="met-flag">
            <Icon name="warn" size={12} />
            unpriced
          </span>
        )}
      </span>
    </span>
  );
}

/** How many outcomes the list shows before "Show all" (a phone lays each one out as a card). */
const LIST_SHOWN = 10;

/**
 * The outcomes of the range, newest first, each opening the ticket, change or phase it names. The order is fixed:
 * no column sorts, so the list can never be turned into a cost leaderboard.
 */
function OutcomeList({
  rows,
  projectName,
}: {
  rows: readonly OutcomeRow[];
  projectName: (projectId: string) => string | null;
}) {
  const [all, setAll] = useState(false);
  const columns = useMemo<DataTableColumn<OutcomeRow>[]>(
    () => [
      {
        id: 'outcome',
        header: 'Outcome',
        primary: true,
        cell: (r) => (
          <span className="met-out__ref">
            <span>{r.info.kind === 'phase_completed' ? phaseIdOf(r.item) : shortId(r.item.refId)}</span>
            <span className="met-sub">{r.info.one}</span>
          </span>
        ),
      },
      {
        id: 'project',
        header: 'Project',
        cell: (r) =>
          r.item.projectId ? (
            (projectName(r.item.projectId) ?? r.item.projectId)
          ) : (
            <span className="met-muted">Several projects</span>
          ),
      },
      {
        id: 'process',
        header: 'Process type',
        cell: (r) => r.item.processType ?? <span className="met-muted">Mixed or unknown</span>,
      },
      {
        id: 'completed',
        header: 'Completed',
        cell: (r) => <RelativeTime value={r.item.completedAt} suffix=" ago" />,
      },
      {
        id: 'cost',
        header: 'Notional cost',
        numeric: true,
        cell: (r) => (
          <OutcomeMoney
            usd={r.item.notionalUsd}
            rm={r.item.rmComplete ? r.item.notionalRm : null}
            rmComplete={r.item.rmComplete}
            unpriced={r.item.unpriced}
          />
        ),
      },
      {
        id: 'sessions',
        header: 'Sessions',
        numeric: true,
        hideOnMobile: true,
        cell: (r) => formatInteger(r.item.sessions),
      },
    ],
    [projectName],
  );
  return (
    <>
      <DataTable
        caption="Outcomes completed in this range, newest first"
        columns={columns}
        rows={all ? rows : rows.slice(0, LIST_SHOWN)}
        rowKey={(r) => r.key}
        rowHref={(r) => r.href}
        maxHeight={all ? 480 : undefined}
      />
      {rows.length > LIST_SHOWN && (
        <div className="met-out__more">
          <Button size="sm" variant="ghost" onClick={() => setAll((v) => !v)}>
            {all ? 'Show the newest 10' : `Show all ${formatInteger(rows.length)} outcomes`}
          </Button>
        </div>
      )}
    </>
  );
}

/** Projects in name order (never by cost), with each kind's median and how many outcomes it rests on. */
function ProjectTable({ rows }: { rows: readonly ProjectOutcomes[] }) {
  const columns = useMemo<DataTableColumn<ProjectOutcomes>[]>(() => {
    const kind = (info: OutcomeKindInfo): DataTableColumn<ProjectOutcomes> => ({
      id: info.key,
      header: info.label,
      numeric: true,
      cell: (r) => {
        const f = r.byKind[info.key];
        if (f.count === 0) return <span className="met-muted">—</span>;
        return (
          <span className="met-out__money aoc-num">
            <b>{outcomeUsd(f.medianUsd ?? 0)}</b>
            <span className="met-sub">
              median of {f.count}
              {f.medianRm !== null && ` · ${outcomeMyr(f.medianRm)}`}
              {!f.rmComplete && <RmIncomplete />}
            </span>
          </span>
        );
      },
    });
    return [
      {
        id: 'project',
        header: 'Project',
        primary: true,
        cell: (r) => (r.projectId ? <Link to={`/projects/${encodeURIComponent(r.projectId)}`}>{r.name}</Link> : r.name),
      },
      ...OUTCOME_KINDS.map(kind),
      {
        id: 'total',
        header: 'Total spend',
        numeric: true,
        cell: (r) => <OutcomeMoney usd={r.total.totalUsd} rm={r.total.totalRm} rmComplete={r.total.rmComplete} />,
      },
    ];
  }, []);
  return (
    <DataTable
      caption="Notional cost of outcomes per project and kind, in project name order"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.projectId ?? 'none'}
    />
  );
}

/**
 * Chips to look at one process type at a time (single choice; "All" clears it). Offered only when the outcomes name
 * more than one. Types are in name order; a count is how many outcomes the type is the main spend of.
 */
function ProcessTypeFilter({
  types,
  total,
  value,
  onChange,
}: {
  types: readonly ProcessTypeCount[];
  total: number;
  value: string | null;
  onChange: (processType: string | null) => void;
}) {
  return (
    <div className="met-out__filter" role="group" aria-label="Filter outcomes by process type">
      <span className="met-out__filter-label">Process type</span>
      <Chip selected={value === null} onToggle={() => onChange(null)}>
        All <span className="aoc-num">{total}</span>
      </Chip>
      {types.map((t) => (
        <Chip
          key={t.processType}
          selected={value === t.processType}
          onToggle={(on) => onChange(on ? t.processType : null)}
        >
          {t.processType} <span className="aoc-num">{t.count}</span>
        </Chip>
      ))}
      <p className="met-quiet met-out__filter-note">
        An outcome is filed under the process type that spent most on it; mixed ones appear only under All.
      </p>
    </div>
  );
}

function Footnote({
  dto,
  classes,
  filtered,
}: {
  dto: CostPerOutcomeDTO;
  classes: readonly OutcomeClassView[];
  filtered: boolean;
}) {
  const shown = classes.reduce((n, c) => n + c.stats.count, 0);
  const unpriced = classes.reduce((n, c) => n + c.unpriced, 0);
  const rmIncomplete = classes.reduce((n, c) => n + c.rmIncomplete, 0);
  return (
    <div className="met-out__foot">
      <p>
        Counted by the day each outcome completed ({formatShortDate(dto.from)} to {formatShortDate(dto.to)}); the
        spend behind one can predate the range. Ringgit is converted by the daemon, usage day by usage day, at that
        day's stamped BNM rate.
      </p>
      {rmIncomplete > 0 && (
        <p>
          <Icon name="warn" size={12} /> RM incomplete: {rmIncompleteText(rmIncomplete, shown)}. Their US$ is complete.
        </p>
      )}
      {unpriced > 0 && (
        <p>
          <Icon name="warn" size={12} /> Unpriced usage counts as US$0, so {unpriced} of these outcomes cost more than
          shown.
        </p>
      )}
      {filtered && <p>Figures cover the {shown} outcomes of the chosen process type; the scale is the whole range's.</p>}
    </div>
  );
}

/** What the panel shows for the loaded outcomes: the chosen process type's, on the scale of the whole range. */
function usePanelView(dto: CostPerOutcomeDTO | undefined, picked: string | null) {
  return useMemo(() => {
    if (!dto) return null;
    const types = processTypes(dto);
    const processType = activeProcessType(picked, types);
    const narrowed = withProcessType(dto, processType);
    return {
      types,
      total: OUTCOME_KINDS.reduce((n, k) => n + dto[k.key].stats.count, 0),
      processType,
      narrowed,
      axis: outcomeAxis(dto),
      classes: outcomeClasses(narrowed),
    };
  }, [dto, picked]);
}

export interface OutcomePanelProps {
  resource: ResourceState<CostPerOutcomeDTO>;
  projectName: (projectId: string) => string | null;
}

/**
 * Cost per outcome (§14.4): what the notional spend bought, as a portfolio. Range marks per kind on one scale, then
 * the outcomes themselves (each opening its ticket, change or phase) or the same figures by project, in US$ with the
 * daemon's ringgit beside it, and by process type when the outcomes name more than one. Never per person, never
 * ranked: the daemon refuses a per-person view, and nothing here sorts by cost.
 */
export function OutcomePanel({ resource, projectName }: OutcomePanelProps) {
  const [view, setView] = useState<View>('list');
  const [picked, setPicked] = useState<string | null>(null);
  const dto = resource.data;
  const forbidden = dto === undefined && resource.error instanceof ApiError && resource.error.status === 403;
  const show = usePanelView(dto, picked);
  const shown = dto && show && !noOutcomes(dto) ? { dto, ...show } : null;

  return (
    <Widget
      span={12}
      id="outcomes"
      className="met-outcomes"
      title="Cost per outcome"
      subtitle="What the notional spend bought · the whole portfolio, never a person"
      info={
        dto
          ? `${dto.costLabel}. ${INFO} ${dto.method.attribution} ${dto.method.window} ${dto.method.percentile} ${dto.method.fx} ${dto.method.processType}`
          : INFO
      }
      actions={
        shown ? (
          <SegmentedControl label="Outcome view" size="sm" value={view} onChange={setView} options={VIEWS} />
        ) : undefined
      }
      footer={
        shown ? <Footnote dto={shown.dto} classes={shown.classes} filtered={shown.processType !== null} /> : undefined
      }
    >
      {forbidden ? (
        <EmptyState
          size="sm"
          icon="compliance"
          title="Not available for your role"
          body="Cost per outcome is a team-wide portfolio view, so it needs permission to view the team's metering (audit view or credit view-all). Your own usage is above."
        />
      ) : (
        <ResourceView
          resource={resource}
          loadingText="Loading outcome costs…"
          errorTitle="Couldn't load cost per outcome"
          isEmpty={noOutcomes}
          empty={
            <EmptyState
              size="sm"
              icon="metering"
              title="No outcomes completed in this range"
              body="Cost per outcome appears once a ticket is closed as fixed, a change request completes or a project phase completes. Each is priced from the sessions that worked on it. Try a longer range."
            />
          }
        >
          {() =>
            shown && (
              <>
                <p className="met-quiet met-out__notice">
                  <Icon name="info" size={12} /> {shown.dto.notice}
                </p>
                {shown.types.length > 1 && (
                  <ProcessTypeFilter
                    types={shown.types}
                    total={shown.total}
                    value={shown.processType}
                    onChange={setPicked}
                  />
                )}
                <OutcomeMarks classes={shown.classes} axis={shown.axis} filtered={shown.processType !== null} />
                {view === 'list' ? (
                  <OutcomeList rows={outcomeRows(shown.narrowed)} projectName={projectName} />
                ) : (
                  <ProjectTable rows={byProject(shown.narrowed, projectName)} />
                )}
              </>
            )
          }
        </ResourceView>
      )}
    </Widget>
  );
}
