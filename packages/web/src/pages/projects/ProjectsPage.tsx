import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { MeteringSummaryDTO, ProjectRollup, ProjectSummary, SessionSummary } from '@aoc/contracts';
import {
  Button,
  EmptyState,
  ErrorState,
  FilterBar,
  InlineAlert,
  KpiStrip,
  KpiTile,
  Money,
  PageHeader,
  RelativeTime,
  SegmentedControl,
  Select,
  TextField,
  Widget,
  WidgetGrid,
  describeError,
  formatInteger,
  formatMyr,
  formatPercent,
  formatShortDate,
  formatUsd,
  useNow,
  useToast,
} from '../../components';
import { useProjectsList, type SpendRange } from './data';
import { NewProjectDialog } from './dialogs';
import {
  attentionFor,
  currentPhase,
  livenessCounts,
  liveTotal,
  phaseStatsFromRollup,
  totalsOf,
  weightText,
  type AttentionReason,
  type LivenessCounts,
  type PhaseStat,
} from './model';
import { AttentionReasons, LiveMix } from './parts';
import { PhaseBar } from './PhaseBar';
import { FlagGlyph } from './glyphs';
import './projects.css';

type SortKey = 'attention' | 'completion' | 'spend' | 'activity' | 'name';
type Show = 'all' | 'attention';

const SORTS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: 'attention', label: 'Attention needed' },
  { value: 'completion', label: 'Least complete first' },
  { value: 'spend', label: 'Spend, 7 days' },
  { value: 'activity', label: 'Most recent activity' },
  { value: 'name', label: 'Name' },
];

interface Row {
  summary: ProjectSummary;
  rollup: ProjectRollup | undefined;
  phases: PhaseStat[];
  current: PhaseStat | null;
  liveness: LivenessCounts;
  score: number;
  reasons: AttentionReason[];
  spend: { usd: number; myr: number | null } | null;
}

const ratio = (r: Row) =>
  r.summary.progress.totalWeight > 0 ? r.summary.progress.doneWeight / r.summary.progress.totalWeight : 0;
const activity = (r: Row) => (r.summary.lastActivityAt ? Date.parse(r.summary.lastActivityAt) : 0);

export function sortRows(rows: readonly Row[], sort: SortKey): Row[] {
  const byName = (a: Row, b: Row) => a.summary.name.localeCompare(b.summary.name);
  const cmp: Record<SortKey, (a: Row, b: Row) => number> = {
    attention: (a, b) => b.score - a.score || ratio(a) - ratio(b) || byName(a, b),
    completion: (a, b) => ratio(a) - ratio(b) || byName(a, b),
    spend: (a, b) => (b.spend?.usd ?? -1) - (a.spend?.usd ?? -1) || byName(a, b),
    activity: (a, b) => activity(b) - activity(a) || byName(a, b),
    name: byName,
  };
  return [...rows].sort(cmp[sort]);
}

function buildRows(
  summaries: readonly ProjectSummary[],
  rollups: readonly ProjectRollup[] | undefined,
  sessions: readonly SessionSummary[] | undefined,
  spend: MeteringSummaryDTO | undefined,
  now: number,
): Row[] {
  const rollupBy = new Map((rollups ?? []).map((r) => [r.projectId, r]));
  const spendBy = new Map((spend?.rows ?? []).map((r) => [r.key, r]));
  return summaries.map((summary) => {
    const rollup = rollupBy.get(summary.projectId);
    const phases = rollup ? phaseStatsFromRollup(rollup.phases) : [];
    const liveness = livenessCounts(
      (sessions ?? []).filter((s) => s.projectId === summary.projectId),
      now,
    );
    const { score, reasons } = attentionFor({ summary, rollup, liveness, now });
    const s = spendBy.get(summary.projectId);
    return {
      summary,
      rollup,
      phases,
      current: rollup ? (phases.find((p) => p.id === rollup.currentPhaseId) ?? currentPhase(phases)) : null,
      liveness,
      score,
      reasons,
      spend: spend ? { usd: s?.notionalUsd ?? 0, myr: s ? s.notionalRm : 0 } : null,
    };
  });
}

function SkeletonRows() {
  return (
    <ol className="prj-list" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <li key={i} className="prj-row prj-row--skeleton">
          <div className="prj-row__id">
            <span className="prj-skel prj-skel--title" />
            <span className="prj-skel prj-skel--line" />
          </div>
          <div className="prj-row__completion">
            <span className="prj-skel prj-skel--line" />
            <span className="prj-skel prj-skel--bar" />
          </div>
          <div className="prj-row__sessions">
            <span className="prj-skel prj-skel--chip" />
          </div>
          <div className="prj-row__attention">
            <span className="prj-skel prj-skel--line" />
          </div>
          <div className="prj-row__spend">
            <span className="prj-skel prj-skel--chip" />
          </div>
        </li>
      ))}
    </ol>
  );
}

function ProjectRow({ row, spendKnown }: { row: Row; spendKnown: boolean }) {
  const { summary, phases, current } = row;
  const p = summary.progress;
  const titleId = `prj-row-${summary.projectId}`;
  const href = `/projects/${encodeURIComponent(summary.projectId)}`;
  return (
    <li className="prj-row" aria-labelledby={titleId}>
      <div className="prj-row__id">
        <h3 id={titleId} className="prj-row__name">
          <Link to={href}>{summary.name}</Link>
        </h3>
        <p className="prj-row__meta">
          <code>{summary.slug}</code>
          {current ? (
            <span>
              now in <b>P{current.index} {current.name}</b>
            </span>
          ) : phases.length > 0 ? (
            <span>every phase complete</span>
          ) : (
            <span>no plan declared yet</span>
          )}
        </p>
        <p className="prj-row__meta">
          {summary.lastActivityAt ? (
            <span>
              last activity <RelativeTime value={summary.lastActivityAt} suffix=" ago" />
            </span>
          ) : (
            <span>no activity yet</span>
          )}
        </p>
      </div>

      <div className="prj-row__completion">
        <span className="aoc-sr-only">Completion: </span>
        <p className="prj-row__figures">
          <strong className="aoc-num">{formatPercent(p.totalWeight > 0 ? p.doneWeight / p.totalWeight : 0)}</strong>
          <span className="aoc-num">
            {weightText(p.doneWeight)}/{weightText(p.totalWeight)} weight
          </span>
          <span className="aoc-num">
            {formatInteger(p.doneTasks)}/{formatInteger(p.totalTasks)} tasks
          </span>
          {p.flaggedTasks > 0 && (
            <span className="prj-row__flagged aoc-num">
              <FlagGlyph size={12} /> {formatInteger(p.flaggedTasks)} flagged
            </span>
          )}
        </p>
        {row.rollup ? (
          <PhaseBar phases={phases} label={`${summary.name} completion by phase`} currentId={current?.id} />
        ) : (
          <span className="prj-muted">Phase breakdown unavailable</span>
        )}
      </div>

      <div className="prj-row__sessions">
        <span className="prj-row__label">Sessions</span>
        <LiveMix counts={row.liveness} />
      </div>

      <div className="prj-row__attention">
        <span className="prj-row__label">Needs attention</span>
        <AttentionReasons reasons={row.reasons} projectId={summary.projectId} />
      </div>

      <div className="prj-row__spend">
        <span className="prj-row__label">Spend, 7 days</span>
        {row.spend ? (
          <Money usd={row.spend.usd} myr={row.spend.myr} layout="stacked" />
        ) : (
          <span className="prj-muted">{spendKnown ? '—' : 'unavailable'}</span>
        )}
      </div>
    </li>
  );
}

function spendFootnote(range: SpendRange, dto: MeteringSummaryDTO | undefined) {
  const from = formatShortDate(dto?.from ?? range.from);
  const to = formatShortDate(dto?.to ?? range.to);
  return `notional API-equivalent · ${from}–${to}`;
}

export default function ProjectsPage() {
  const now = useNow();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const { summaries, rollups, sessions, spend } = useProjectsList();

  const show: Show = params.get('show') === 'attention' ? 'attention' : 'all';
  const sort = (SORTS.find((s) => s.value === params.get('sort'))?.value ?? 'attention') as SortKey;
  const query = params.get('q') ?? '';
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null || value === '') next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const rows = useMemo(
    () =>
      summaries.data ? buildRows(summaries.data, rollups.data, sessions.data, spend.resource.data, now) : [],
    [summaries.data, rollups.data, sessions.data, spend.resource.data, now],
  );
  const needAttention = rows.filter((r) => r.score > 0);
  const visible = sortRows(
    rows.filter(
      (r) =>
        (show === 'all' || r.score > 0) &&
        (!query ||
          r.summary.name.toLowerCase().includes(query.toLowerCase()) ||
          r.summary.slug.toLowerCase().includes(query.toLowerCase())),
    ),
    sort,
  );

  const portfolioLive: LivenessCounts = {};
  for (const r of rows)
    for (const [state, n] of Object.entries(r.liveness))
      portfolioLive[state as keyof LivenessCounts] = (portfolioLive[state as keyof LivenessCounts] ?? 0) + (n ?? 0);
  const openDecisions = rows.reduce((a, r) => a + r.summary.openDecisions, 0);
  const totals = totalsOf(rows.flatMap((r) => r.phases));
  const spendTotals = spend.resource.data?.totals;

  const header = (
    <PageHeader
      title="Projects"
      subtitle="Each project's master timeline: tasks done over tasks declared across every developer, weighted by declared size."
      actions={
        <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
          New project
        </Button>
      }
    />
  );

  const dialog = creating && (
    <NewProjectDialog
      onClose={() => setCreating(false)}
      onCreated={(p) => {
        setCreating(false);
        toast.notify({ tone: 'ok', title: `Project ${p.name} created`, body: 'Recorded as project.created under your name.' });
        navigate(`/projects/${encodeURIComponent(p.projectId)}`);
      }}
    />
  );

  if (summaries.data === undefined && summaries.error !== undefined) {
    return (
      <>
        {header}
        <ErrorState title="Couldn't load projects" error={summaries.error} onRetry={summaries.reload} />
        {dialog}
      </>
    );
  }

  const loading = summaries.data === undefined;
  return (
    <>
      {header}
      <KpiStrip label="Portfolio at a glance">
        <KpiTile
          label="Need attention"
          value={loading ? '—' : needAttention.length}
          unit={loading ? undefined : `of ${formatInteger(rows.length)} projects`}
          tone={needAttention.length > 0 ? 'warn' : 'neutral'}
          href="/projects?show=attention"
          info="Open decisions, dead or stalled sessions, drift in the last 7 days, flagged closes awaiting review, recent amendments, or no activity for 3 days with work still open."
        />
        <KpiTile
          label="Open decisions"
          value={loading ? '—' : openDecisions}
          tone={openDecisions > 0 ? 'warn' : 'neutral'}
          href="/decisions"
          footnote={openDecisions > 0 ? 'human-required, across projects' : 'nothing waiting'}
        />
        <KpiTile
          label="Live sessions"
          value={loading || sessions.data === undefined ? '—' : liveTotal(portfolioLive)}
          footnote={<LiveMix counts={portfolioLive} empty="none running" />}
        />
        <KpiTile
          label="Completion"
          value={loading || !rollups.data ? '—' : formatPercent(totals.totalWeight > 0 ? totals.doneWeight / totals.totalWeight : 0)}
          unit="by weight"
          footnote={
            rollups.data
              ? `${weightText(totals.doneWeight)} of ${weightText(totals.totalWeight)} declared weight · ${formatInteger(totals.flaggedTasks)} flagged`
              : undefined
          }
          info="Weighted tasks done over tasks declared, summed across every project's master timeline. Flagged closes count until reviewed."
        />
        <KpiTile
          label="Spend, 7 days"
          value={spendTotals ? formatUsd(spendTotals.notionalUsd) : '—'}
          footnote={
            spendTotals
              ? `${spendTotals.notionalRm !== null ? `${formatMyr(spendTotals.notionalRm)} · ` : ''}${spendFootnote(spend.range, spend.resource.data)}`
              : spend.resource.error
                ? 'unavailable for your role'
                : undefined
          }
          href="/metering"
          info="Notional API-equivalent cost of every session's tokens at the rate card — decision support on a Max plan, not a bill."
        />
      </KpiStrip>

      <FilterBar
        end={
          loading ? undefined : (
            <span className="aoc-num">
              {formatInteger(visible.length)} of {formatInteger(rows.length)} projects
            </span>
          )
        }
      >
        <SegmentedControl
          label="Show"
          value={show}
          onChange={(v) => setParam('show', v === 'all' ? null : v)}
          options={[
            { value: 'all', label: 'All' },
            { value: 'attention', label: 'Needs attention' },
          ]}
        />
        <Select
          label="Sort"
          fieldClassName="prj-inline-field"
          value={sort}
          onChange={(e) => setParam('sort', e.target.value === 'attention' ? null : e.target.value)}
          options={SORTS}
        />
        <TextField
          label="Find"
          type="search"
          fieldClassName="prj-inline-field prj-search"
          placeholder="Name or slug"
          value={query}
          onChange={(e) => setParam('q', e.target.value)}
        />
      </FilterBar>

      {(rollups.error !== undefined || sessions.error !== undefined || spend.resource.error !== undefined) && !loading && (
        <div className="prj-alerts">
          {rollups.error !== undefined && (
            <InlineAlert
              tone="warn"
              title="Completion by phase is unavailable"
              action={
                <button type="button" className="aoc-link-button" onClick={rollups.reload}>
                  Retry
                </button>
              }
            >
              {describeError(rollups.error)}
            </InlineAlert>
          )}
          {sessions.error !== undefined && (
            <InlineAlert
              tone="warn"
              title="Live sessions are unavailable"
              action={
                <button type="button" className="aoc-link-button" onClick={sessions.reload}>
                  Retry
                </button>
              }
            >
              {describeError(sessions.error)}
            </InlineAlert>
          )}
          {spend.resource.error !== undefined && (
            <InlineAlert tone="info" title="Spend is not shown">
              {describeError(spend.resource.error)}
            </InlineAlert>
          )}
        </div>
      )}

      <WidgetGrid>
        <Widget
          span={12}
          flush
          title="Master timelines"
          subtitle={`sorted by ${SORTS.find((s) => s.value === sort)?.label.toLowerCase()}`}
          info="Bar segments are phases in manifest order, sized by declared weight. Purple is done with evidence; amber is done but flagged (closed with no file change) — it counts until reviewed; the rest is open."
          busy={summaries.loading && !loading}
        >
          {loading ? (
            <>
              <p className="aoc-sr-only" role="status">
                Loading projects…
              </p>
              <SkeletonRows />
            </>
          ) : rows.length === 0 ? (
            <EmptyState
              size="sm"
              icon="projects"
              title="No projects yet"
              body="A project appears here when someone creates it, or when a managed session launches against a new project. Its master timeline fills as sessions declare plans."
              action={
                <Button size="sm" icon="plus" onClick={() => setCreating(true)}>
                  New project
                </Button>
              }
            />
          ) : visible.length === 0 ? (
            <EmptyState
              size="sm"
              icon="filter"
              title={query ? `No project matches “${query}”` : 'No project needs attention'}
              body={
                query
                  ? 'Try another name or slug.'
                  : 'No open decisions, dead or stalled sessions, recent drift, flagged closes or recent amendments.'
              }
              action={
                <Button size="sm" variant="ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <>
              <div className="prj-list__head" aria-hidden="true">
                <span>Project</span>
                <span>Completion by phase</span>
                <span>Sessions</span>
                <span>Needs attention</span>
                <span className="prj-list__head-end">Spend, 7 days · notional</span>
              </div>
              <ol className="prj-list">
                {visible.map((r) => (
                  <ProjectRow key={r.summary.projectId} row={r} spendKnown={spend.resource.error === undefined} />
                ))}
              </ol>
              <p className="prj-legend">
                <span className="prj-legend__item">
                  <span className="prj-legend__swatch prj-legend__swatch--done" /> done with evidence
                </span>
                <span className="prj-legend__item">
                  <span className="prj-legend__swatch prj-legend__swatch--flagged" /> flagged: closed with no file change,
                  counts until reviewed
                </span>
                <span className="prj-legend__item">
                  <span className="prj-legend__swatch prj-legend__swatch--open" /> declared, not done
                </span>
              </p>
            </>
          )}
        </Widget>
      </WidgetGrid>
      {dialog}
    </>
  );
}
