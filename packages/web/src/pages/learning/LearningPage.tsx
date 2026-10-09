import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type {
  ErrorOccurrenceDTO,
  ModelDimensionReportDTO,
  OffenceDTO,
  RecurrenceTrendDTO,
  RootCauseClassDTO,
} from '@aoc/contracts';
import { useAuth, useResource, type StreamMessage } from '../../api';
import { FunnelBar, RecurrenceTrend } from '../../charts';
import {
  Button,
  Chip,
  DataTable,
  EmptyState,
  KpiStrip,
  KpiTile,
  PageHeader,
  RelativeTime,
  ResourceView,
  Widget,
  WidgetGrid,
  formatDuration,
  formatInteger,
  formatShortDate,
  formatTokens,
  formatUsd,
  useNow,
  type DataTableColumn,
} from '../../components';
import { AssignRootCauseDialog } from './AssignRootCauseDialog';
import { DimensionBars } from './DimensionBars';
import { LifecycleSteps } from './LifecycleSteps';
import { ModelDimensionList } from './ModelDimension';
import { OccurrencesPanel } from './OccurrencesPanel';
import { OffenceDrawer } from './OffenceDrawer';
import { combine, useSectionScroll } from './resources';
import { TransitionDialog } from './TransitionDialog';
import {
  DIMENSION_META,
  STEP_ACTION,
  dimensionShares,
  isLearningEvent,
  lifecycleStages,
  nextSteps,
  outwardCount,
  perOccurrenceUsd,
  prioritise,
  repeatingGroups,
  signatureGroups,
  summarise,
  trendFacets,
  type HumanStep,
  type SignatureGroup,
} from './model';
import './learning.css';

/** Weeks in the recurrence trend (the Registry's trend window). */
const WEEKS = 8;
/** Newest occurrences loaded for the feed and the signature groups. */
const ERROR_LIMIT = 500;

const refreshOn = (m: StreamMessage) => m.kind === 'aoc' && isLearningEvent(m.event.type);

function Skeleton({ height, label }: { height: number; label: string }) {
  return (
    <div className="learning-skel" style={{ height }} role="status">
      <span className="aoc-sr-only">{label}</span>
    </div>
  );
}

/**
 * Learning (§11): repeat offences as tracked objects with a lifecycle, prioritised by the cost of each
 * recurrence. Root-cause classes only — no person appears anywhere on this page (R11).
 */
export default function LearningPage() {
  const { user } = useAuth();
  // learning.curate: both operator roles may assign root causes and move offences (the server enforces it).
  const canCurate = user?.role === 'approver' || user?.role === 'builder';
  // Waiting ages are text: the shared minute clock is enough, and nothing redraws between events.
  const now = useNow();

  const offences = useResource<OffenceDTO[]>('/api/learning/offences', { refreshOn });
  const classes = useResource<RootCauseClassDTO[]>('/api/learning/classes', { refreshOn });
  const trend = useResource<RecurrenceTrendDTO>('/api/learning/trends', {
    query: { weeks: WEEKS },
    refreshOn,
  });
  const model = useResource<ModelDimensionReportDTO>('/api/learning/model-dimension', { refreshOn });
  const errors = useResource<ErrorOccurrenceDTO[]>('/api/learning/errors', {
    query: { limit: ERROR_LIMIT },
    refreshOn,
  });
  useSectionScroll(offences, classes, trend, model, errors);

  // The open offence lives in the URL (`?class=<classId>`) so other pages can link straight to it.
  const [params, setParams] = useSearchParams();
  const openClassId = params.get('class');
  const setOpenClass = useCallback(
    (classId: string | null) =>
      setParams(
        (p) => {
          const next = new URLSearchParams(p);
          if (classId === null) next.delete('class');
          else next.set('class', classId);
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  const [transition, setTransition] = useState<{ offenceId: string; step: HumanStep } | null>(null);
  const [assign, setAssign] = useState<SignatureGroup | null>(null);

  const ranked = useMemo(() => prioritise(offences.data ?? []), [offences.data]);
  const summary = useMemo(() => summarise(offences.data ?? []), [offences.data]);
  const groups = useMemo(() => signatureGroups(errors.data ?? []), [errors.data]);
  const repeating = useMemo(() => repeatingGroups(groups), [groups]);
  const shares = useMemo(() => dimensionShares(classes.data ?? []), [classes.data]);
  const classById = useMemo(() => new Map((classes.data ?? []).map((c) => [c.classId, c])), [classes.data]);
  const modelById = useMemo(
    () => new Map((model.data?.classes ?? []).map((c) => [c.classId, c])),
    [model.data],
  );

  const openOffence = openClassId ? (ranked.find((o) => o.classId === openClassId) ?? null) : null;
  const transitionOffence = transition
    ? (ranked.find((o) => o.offenceId === transition.offenceId) ?? null)
    : null;

  const startStep = useCallback((o: OffenceDTO, step: HumanStep) => {
    setTransition({ offenceId: o.offenceId, step });
  }, []);

  const offenceColumns = useMemo<DataTableColumn<OffenceDTO>[]>(
    () => [
      {
        id: 'class',
        header: 'Root-cause class',
        primary: true,
        sortValue: (o) => o.className,
        cell: (o) => (
          <span className="learning-stack">
            <span className="learning-classname">{o.className}</span>
            <span className="learning-muted">{DIMENSION_META[o.dimension].label}</span>
          </span>
        ),
      },
      {
        id: 'lifecycle',
        header: 'Lifecycle',
        width: '196px',
        cell: (o) => <LifecycleSteps state={o.state} reopenCount={o.reopenCount} compact />,
      },
      {
        id: 'cost',
        header: 'Cost of recurrence',
        numeric: true,
        sortValue: (o) => o.costOfRecurrenceUsd,
        sortLabels: ['cheapest first', 'costliest first'],
        cell: (o) => (
          <span className="learning-stack">
            <span>{formatUsd(o.costOfRecurrenceUsd)}</span>
            <span className="learning-muted">≈ {formatUsd(perOccurrenceUsd(o))} each</span>
          </span>
        ),
      },
      {
        id: 'occurrences',
        header: 'Occurrences',
        numeric: true,
        sortValue: (o) => o.occurrences,
        cell: (o) => (
          <span className="learning-stack">
            <span>{formatInteger(o.occurrences)}</span>
            {o.highPriorityOccurrences > 0 && (
              <span className="learning-muted">{formatInteger(o.highPriorityOccurrences)} UAT / high</span>
            )}
          </span>
        ),
      },
      {
        id: 'time',
        header: 'Agent time',
        numeric: true,
        sortValue: (o) => o.costMs,
        hideOnMobile: true,
        cell: (o) => formatDuration(o.costMs),
      },
      {
        id: 'seen',
        header: 'Last seen',
        numeric: true,
        sortValue: (o) => classById.get(o.classId)?.lastSeenAt ?? null,
        cell: (o) => {
          const seen = classById.get(o.classId)?.lastSeenAt;
          return seen ? <RelativeTime value={seen} suffix=" ago" /> : '—';
        },
      },
      {
        id: 'next',
        header: 'Next step',
        align: 'end',
        cell: (o) => {
          const steps = nextSteps(o.state);
          if (canCurate && steps.length > 0)
            return (
              <Button size="sm" onClick={() => startStep(o, steps[0]!)}>
                {STEP_ACTION[steps[0]!]}…
              </Button>
            );
          if (o.state === 'fix_applied' && o.verifyDueAt)
            return (
              <span className="learning-muted">Verifying · closes {formatShortDate(o.verifyDueAt)}</span>
            );
          if (o.state === 'verified_closed' && o.verifiedClosedAt)
            return <span className="learning-muted">Closed {formatShortDate(o.verifiedClosedAt)}</span>;
          return <span className="learning-muted">—</span>;
        },
      },
    ],
    [canCurate, classById, startStep],
  );

  const outward = outwardCount(shares);
  const unclassifiedInWindow = (trend.data?.unclassified ?? []).reduce((a, b) => a + b, 0);
  const repeatingOccurrences = repeating.reduce((a, g) => a + g.count, 0);
  const loaded = offences.data !== undefined;

  return (
    <>
      <PageHeader
        title="Learning"
        subtitle="Repeat offences by root cause, prioritised by what each recurrence costs, not how often it happens. Classes and causes only: never people."
        meta={
          <>
            <Chip icon="learning">Cluster by cause, not error text</Chip>
            <span>
              Distilled lessons live in <Link to="/knowledge">Knowledge</Link>
            </span>
          </>
        }
      />

      <KpiStrip label="Learning at a glance">
        <KpiTile
          label="Open repeat offences"
          value={loaded ? summary.open : '—'}
          tone={summary.needsRootCause > 0 ? 'warn' : 'neutral'}
          footnote={
            loaded
              ? `${formatInteger(summary.needsRootCause)} need a root cause · ${formatInteger(
                  summary.byState.root_caused,
                )} need a fix · ${formatInteger(summary.byState.fix_applied)} verifying`
              : undefined
          }
          href="#offences"
          info="A root-cause class becomes a tracked repeat offence at its second occurrence."
        />
        <KpiTile
          label="Cost of recurrence"
          href="#offences"
          value={loaded ? formatUsd(summary.openCostUsd) : '—'}
          footnote="notional · open offences · UAT and high priority ×3"
          info="Each occurrence costs its session's usage in the 30 minutes after it (notional API-equivalent, not a bill). UAT and high-priority occurrences weigh three times. This is the ranking key, not the count."
        />
        <KpiTile
          label="Agent time lost"
          href="#offences"
          value={loaded ? formatDuration(summary.openCostMs) : '—'}
          footnote={
            loaded && summary.openCostTokens > 0
              ? `${formatTokens(summary.openCostTokens)} tokens after occurrences`
              : 'session time after each occurrence'
          }
          info="Session time spent after each occurrence of an open repeat offence (the 30-minute cost window)."
        />
        <KpiTile
          label="Repeating, no root cause"
          value={errors.data ? repeating.length : '—'}
          unit={errors.data ? `signature${repeating.length === 1 ? '' : 's'}` : undefined}
          tone={repeating.length > 0 ? 'warn' : 'neutral'}
          footnote={errors.data ? `${formatInteger(repeatingOccurrences)} occurrences waiting` : undefined}
          href="#occurrences"
          info="Unclassified errors whose normalised text repeats. Assign a root cause to start the lifecycle."
        />
        <KpiTile
          label="Verified closed"
          href="#offences"
          value={loaded ? summary.closed : '—'}
          footnote="no recurrence for a full window after the fix"
        />
      </KpiStrip>

      <WidgetGrid>
        <Widget
          span={12}
          title="Recurrence by root-cause class"
          subtitle={`Occurrences per week, last ${WEEKS} weeks · ordered by cost of recurrence, not count`}
          info="One panel per tracked repeat class, on one shared scale. Each panel prints its latest week, total and peak. Classes cluster occurrences by cause, not error text."
          busy={trend.loading && trend.data !== undefined}
          footer={
            trend.data ? (
              <span className="aoc-num">
                {formatInteger(unclassifiedInWindow)} unclassified occurrences in the window: transient unless
                their signature repeats (see Occurrences).
              </span>
            ) : undefined
          }
        >
          {trend.data === undefined && !trend.error ? (
            <Skeleton height={168} label="Loading the recurrence trend" />
          ) : (
            <ResourceView
              resource={combine(trend, offences)}
              isEmpty={([t, o]) => trendFacets(t, o).length === 0}
              empty={
                <EmptyState
                  size="sm"
                  icon="learning"
                  title="No repeat offences yet"
                  body="A root-cause class appears here once it has two occurrences. Assign root causes to repeating errors below."
                />
              }
              errorTitle="Couldn't load the recurrence trend"
            >
              {([t, o]) => <RecurrenceTrend classes={trendFacets(t, o)} minFacetWidth={240} tableView />}
            </ResourceView>
          )}
        </Widget>

        <Widget
          span={12}
          id="offences"
          title="Repeat offences"
          subtitle="Detected → root-caused → fix applied → verified closed · open first, costliest first"
          info="Verified closed is automatic: the offence closes after a full verification window with no recurrence after the fix. Any recurrence reopens it."
          flush
        >
          {offences.data === undefined && !offences.error ? (
            <Skeleton height={140} label="Loading repeat offences" />
          ) : (
            <ResourceView
              resource={offences}
              isEmpty={() => false}
              errorTitle="Couldn't load repeat offences"
            >
              {() => (
                <div className="learning-flush">
                  <DataTable
                    caption="Repeat offences by cost of recurrence"
                    columns={offenceColumns}
                    rows={ranked}
                    rowKey={(o) => o.offenceId}
                    onRowClick={(o) => setOpenClass(o.classId)}
                    rowLabel={(o) => `Open details for ${o.className}`}
                    activeRowKey={openOffence?.offenceId}
                    rowTone={(o) => (o.state === 'reopened' ? 'danger' : undefined)}
                    empty={
                      <EmptyState
                        size="sm"
                        icon="ok"
                        title="No repeat offences"
                        body="Nothing has recurred yet. A class with two or more occurrences becomes a tracked offence."
                      />
                    }
                  />
                </div>
              )}
            </ResourceView>
          )}
        </Widget>

        <Widget
          span={6}
          title="Lifecycle"
          subtitle="Repeat offences per step · how long they have waited there"
          info="Detected → root-caused → fix applied → verified closed. Reopened offences wait at detection again. Verified closed only accumulates."
        >
          {offences.data === undefined && !offences.error ? (
            <Skeleton height={104} label="Loading the lifecycle" />
          ) : (
            <ResourceView resource={offences} isEmpty={() => false} errorTitle="Couldn't load the lifecycle">
              {(list) => <FunnelBar stages={lifecycleStages(list, now)} label="Repeat-offence lifecycle" />}
            </ResourceView>
          )}
        </Widget>

        <Widget
          span={6}
          title="Where root causes point"
          subtitle="Cost of recurrence by dimension · all classes"
          info="Root causes often point outward — an ambiguous spec, a confusing codebase, a missing guardrail. The agent is frequently the symptom, not the cause."
          footer={
            outward.known > 0 ? (
              <span className="aoc-num">
                {formatInteger(outward.outward)} of {formatInteger(outward.known)} classes point outward, away
                from the model.
              </span>
            ) : undefined
          }
        >
          {classes.data === undefined && !classes.error ? (
            <Skeleton height={120} label="Loading root-cause dimensions" />
          ) : (
            <ResourceView
              resource={classes}
              isEmpty={() => shares.length === 0}
              empty={<EmptyState size="sm" title="No root-cause classes yet" />}
              errorTitle="Couldn't load root-cause classes"
            >
              {() => <DimensionBars shares={shares} />}
            </ResourceView>
          )}
        </Widget>

        <Widget
          span={12}
          title="Model as a root-cause dimension"
          subtitle="Tested per process type on metered runs"
          info="Model capability is the verdict only when a class recurs on the cheaper model but not the stronger one, with enough runs on both. The fix is then a targeted upgrade for that process type, never a blanket one. If it recurs on both, the cause is spec, context or tooling."
        >
          {model.data === undefined && !model.error ? (
            <Skeleton height={120} label="Loading the model test" />
          ) : (
            <ResourceView
              resource={model}
              isEmpty={(m) => m.classes.length === 0}
              empty={
                <EmptyState
                  size="sm"
                  title="Nothing to test yet"
                  body="Repeat classes with a known model appear here."
                />
              }
              errorTitle="Couldn't load the model test"
            >
              {(m) => (
                <ModelDimensionList
                  classes={m.classes}
                  minRunsPerTier={m.minRunsPerTier}
                  onOpen={setOpenClass}
                />
              )}
            </ResourceView>
          )}
        </Widget>

        <Widget
          span={12}
          id="occurrences"
          title="Occurrences"
          subtitle={`Newest ${formatInteger(ERROR_LIMIT)} error occurrences · transient errors are logged, not lessons`}
          info="Error text comes from tools, tests and UAT: it is shown as data, never followed as instructions."
          flush
        >
          {errors.data === undefined && !errors.error ? (
            <Skeleton height={220} label="Loading occurrences" />
          ) : (
            <ResourceView resource={errors} isEmpty={() => false} errorTitle="Couldn't load occurrences">
              {(list) => (
                <OccurrencesPanel
                  errors={list}
                  repeating={repeating}
                  transient={groups.length - repeating.length}
                  canCurate={canCurate}
                  onAssign={setAssign}
                  busy={errors.loading}
                />
              )}
            </ResourceView>
          )}
        </Widget>
      </WidgetGrid>

      <OffenceDrawer
        offence={openOffence}
        rootCauseClass={openOffence ? classById.get(openOffence.classId) : undefined}
        model={openOffence ? modelById.get(openOffence.classId) : undefined}
        minRunsPerTier={model.data?.minRunsPerTier ?? 3}
        occurrences={errors.data ?? []}
        canCurate={canCurate}
        onClose={() => setOpenClass(null)}
        onStep={startStep}
      />
      <TransitionDialog
        offence={transitionOffence}
        initialStep={transition?.step}
        onClose={() => setTransition(null)}
        onDone={() => {
          setTransition(null);
          offences.reload();
        }}
      />
      <AssignRootCauseDialog
        group={assign}
        classes={classes.data ?? []}
        onClose={() => setAssign(null)}
        onDone={() => {
          setAssign(null);
          errors.reload();
          classes.reload();
          offences.reload();
        }}
      />
    </>
  );
}
