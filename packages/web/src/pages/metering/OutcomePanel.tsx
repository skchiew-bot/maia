import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CostPerOutcomeDTO } from '@aoc/contracts';
import { ApiError, type ResourceState } from '../../api';
import {
  Button,
  DataTable,
  EmptyState,
  Icon,
  RelativeTime,
  ResourceView,
  SegmentedControl,
  Widget,
  type DataTableColumn,
} from '../../components';
import { formatInteger, formatMyr, formatShortDate, formatUsd } from '../../lib/format';
import { shortId } from '../audit/ids';
import { OutcomeMarks } from './OutcomeMarks';
import {
  OUTCOME_KINDS,
  byProject,
  noOutcomes,
  outcomeAxis,
  outcomeClasses,
  outcomeRm,
  outcomeRows,
  outcomeUsd,
  phaseIdOf,
  type OutcomeKindInfo,
  type OutcomeRow,
  type ProjectOutcomes,
  type RateBasis,
} from './outcomeModel';

type View = 'list' | 'project';
const VIEWS: readonly { value: View; label: string }[] = [
  { value: 'list', label: 'Outcomes' },
  { value: 'project', label: 'By project' },
];

const INFO =
  'Notional spend tied to what it produced: a ticket closed as fixed, a change completed, a phase completed. A portfolio lens, never a ranking of people. API-equivalent cost, not a bill.';

/**
 * Notional US$ with ringgit under it (indicative: the daemon prices outcomes in US$). An outcome with usage no rate
 * priced says so on the ringgit line, so the cost never reads as complete.
 */
function OutcomeMoney({ usd, rate, unpriced }: { usd: number; rate: number | null; unpriced?: boolean }) {
  const rm = outcomeRm(usd, rate);
  return (
    <span className="met-out__money aoc-num">
      <b>{outcomeUsd(usd)}</b>
      {(rm || unpriced) && (
        <span className="met-sub">
          {rm}
          {unpriced && (
            <span className="met-flag">
              <Icon name="warn" size={12} />
              unpriced
            </span>
          )}
        </span>
      )}
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
  rate,
  projectName,
}: {
  rows: readonly OutcomeRow[];
  rate: number | null;
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
        id: 'completed',
        header: 'Completed',
        cell: (r) => <RelativeTime value={r.item.completedAt} suffix=" ago" />,
      },
      {
        id: 'cost',
        header: 'Notional cost',
        numeric: true,
        cell: (r) => <OutcomeMoney usd={r.item.notionalUsd} rate={rate} unpriced={r.item.unpriced} />,
      },
      {
        id: 'sessions',
        header: 'Sessions',
        numeric: true,
        hideOnMobile: true,
        cell: (r) => formatInteger(r.item.sessions),
      },
    ],
    [rate, projectName],
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
function ProjectTable({ rows, rate }: { rows: readonly ProjectOutcomes[]; rate: number | null }) {
  const columns = useMemo<DataTableColumn<ProjectOutcomes>[]>(() => {
    const kind = (info: OutcomeKindInfo): DataTableColumn<ProjectOutcomes> => ({
      id: info.key,
      header: info.label,
      numeric: true,
      cell: (r) => {
        const f = r.byKind[info.key];
        if (f.count === 0) return <span className="met-muted">—</span>;
        const median = f.medianUsd ?? 0;
        const rm = outcomeRm(median, rate);
        return (
          <span className="met-out__money aoc-num">
            <b>{outcomeUsd(median)}</b>
            <span className="met-sub">
              median of {f.count}
              {rm ? ` · ${rm}` : ''}
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
      { id: 'total', header: 'Total spend', numeric: true, cell: (r) => <OutcomeMoney usd={r.totalUsd} rate={rate} /> },
    ];
  }, [rate]);
  return (
    <DataTable
      caption="Notional cost of outcomes per project and kind, in project name order"
      columns={columns}
      rows={rows}
      rowKey={(r) => r.projectId ?? 'none'}
    />
  );
}

function Footnote({ dto, basis, unpriced }: { dto: CostPerOutcomeDTO; basis: RateBasis | null; unpriced: number }) {
  return (
    <div className="met-out__foot">
      <p>
        Counted by the day each outcome completed ({formatShortDate(dto.from)} to {formatShortDate(dto.to)}); the spend
        behind one can predate the range.
      </p>
      <p className="aoc-num">
        {basis
          ? `RM is indicative: ≈ US$ × ${basis.rate.toFixed(4)}, this range's blend of the stamped BNM rates (${formatMyr(basis.rm)} ÷ ${formatUsd(basis.usd)} of notional cost). Outcomes are priced in US$.`
          : 'RM is not shown: it needs metered cost in the range and a stamped BNM rate on every day that has some.'}
      </p>
      {unpriced > 0 && (
        <p>
          <Icon name="warn" size={12} /> Unpriced usage counts as US$0, so {unpriced} of these outcomes cost more than shown.
        </p>
      )}
    </div>
  );
}

export interface OutcomePanelProps {
  resource: ResourceState<CostPerOutcomeDTO>;
  /** RM per US$ for the range from the team's daily rollups, with the figures it comes from; null when unknown. */
  basis: RateBasis | null;
  projectName: (projectId: string) => string | null;
}

/**
 * Cost per outcome (§14.4): what the notional spend bought, as a portfolio. Range marks per kind on one scale, then
 * the outcomes themselves (each opening its ticket, change or phase) or the same figures by project. Never per
 * person, never ranked: the daemon refuses a per-person view, and nothing here sorts by cost.
 */
export function OutcomePanel({ resource, basis, projectName }: OutcomePanelProps) {
  const [view, setView] = useState<View>('list');
  const dto = resource.data;
  const rate = basis?.rate ?? null;
  const forbidden = dto === undefined && resource.error instanceof ApiError && resource.error.status === 403;
  const shown = dto && !noOutcomes(dto) ? dto : null;
  const classes = useMemo(() => (dto ? outcomeClasses(dto) : []), [dto]);
  const unpriced = classes.reduce((n, c) => n + c.unpriced, 0);

  return (
    <Widget
      span={12}
      id="outcomes"
      className="met-outcomes"
      title="Cost per outcome"
      subtitle="What the notional spend bought · the whole portfolio, never a person"
      info={dto ? `${dto.costLabel}. ${INFO} ${dto.method.attribution} ${dto.method.window} ${dto.method.percentile}` : INFO}
      actions={
        shown ? (
          <SegmentedControl label="Outcome view" size="sm" value={view} onChange={setView} options={VIEWS} />
        ) : undefined
      }
      footer={shown ? <Footnote dto={shown} basis={basis} unpriced={unpriced} /> : undefined}
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
          {(d) => (
            <>
              <p className="met-quiet met-out__notice">
                <Icon name="info" size={12} /> {d.notice}
              </p>
              <OutcomeMarks classes={classes} axis={outcomeAxis(d)} rate={rate} />
              {view === 'list' ? (
                <OutcomeList rows={outcomeRows(d)} rate={rate} projectName={projectName} />
              ) : (
                <ProjectTable rows={byProject(d, projectName)} rate={rate} />
              )}
            </>
          )}
        </ResourceView>
      )}
    </Widget>
  );
}
