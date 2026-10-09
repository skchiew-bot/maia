import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type {
  DecisionListResponse,
  LessonDTO,
  OffenceDTO,
  RegistryTypesResponse,
  RootCauseClassDTO,
} from '@aoc/contracts';
import { apiPost, useAuth, useResource, type StreamMessage } from '../../api';
import { Meter } from '../../charts';
import {
  Badge,
  Button,
  ButtonLink,
  Chip,
  DataTable,
  Dialog,
  EmptyState,
  FilterBar,
  InlineAlert,
  KpiStrip,
  KpiTile,
  PageHeader,
  RelativeTime,
  ResourceView,
  SegmentedControl,
  Widget,
  WidgetGrid,
  describeError,
  formatDuration,
  formatInteger,
  formatNumber,
  formatShortDate,
  formatTokens,
  formatUsd,
  useToast,
  type DataTableColumn,
} from '../../components';
import { combine, useSectionScroll } from '../learning/resources';
import { KnowledgeSearch } from './KnowledgeSearch';
import { LessonDrawer } from './LessonDrawer';
import { PayoffChart } from './PayoffChart';
import { ProposeLessonDialog } from './ProposeLessonDialog';
import {
  SCOPE_LABEL,
  STATUS_META,
  blockedReason,
  decisionHref,
  filterLessons,
  isKnowledgeEvent,
  payoffRows,
  pendingDecisions,
  readyToDistil,
  retirementCandidates,
  retirementProgress,
  summarise,
  type StatusFilter,
} from './model';
import './knowledge.css';

const refreshOn = (m: StreamMessage) => m.kind === 'aoc' && isKnowledgeEvent(m.event.type, m.event.meta);
const decisionRefresh = (m: StreamMessage) =>
  m.kind === 'aoc' && m.event.type.startsWith('decision.') && isKnowledgeEvent(m.event.type, m.event.meta);
const classRefresh = (m: StreamMessage) => m.kind === 'aoc' && m.event.type.startsWith('rootcause.');

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'bound', label: 'In force' },
  { value: 'proposed', label: 'Awaiting decision' },
  { value: 'retired', label: 'Retired' },
  { value: 'rejected', label: 'Rejected' },
];

function Skeleton({ height, label }: { height: number; label: string }) {
  return (
    <div className="knowledge-skel" style={{ height }} role="status">
      <span className="aoc-sr-only">{label}</span>
    </div>
  );
}

function signed(n: number): string {
  const v = formatNumber(Math.abs(n), 1);
  return n > 0 ? `+${v}` : n < 0 ? `−${v}` : '0';
}

/**
 * Knowledge (§11, §14): the distilled lessons registry. Lessons are scoped (a process type or a code area,
 * never global), bind only through an Approver decision, track repeats prevented and savings, and retire when
 * unused. Below them, the team knowledge search.
 */
export default function KnowledgePage() {
  const { user } = useAuth();
  // learning.curate (propose, retire) belongs to both operator roles; the server enforces it.
  const canCurate = user?.role === 'approver' || user?.role === 'builder';
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();

  const lessons = useResource<LessonDTO[]>('/api/learning/lessons', { refreshOn });
  const decisions = useResource<DecisionListResponse>('/api/decisions', {
    query: { kind: 'lesson_binding', status: 'open' },
    refreshOn: decisionRefresh,
  });
  const offences = useResource<OffenceDTO[]>('/api/learning/offences', { refreshOn });
  const classes = useResource<RootCauseClassDTO[]>('/api/learning/classes', { refreshOn: classRefresh });
  const types = useResource<RegistryTypesResponse>('/api/registry/process-types');
  useSectionScroll(lessons, decisions, offences, classes, types);

  const [status, setStatus] = useState<StatusFilter>('all');
  const [retireTarget, setRetireTarget] = useState<LessonDTO | null>(null);
  const [retiring, setRetiring] = useState(false);
  const [retireError, setRetireError] = useState<unknown>(undefined);
  const cancelRetireRef = useRef<HTMLButtonElement>(null);

  const list = lessons.data ?? [];
  const summary = useMemo(() => summarise(list), [list]);
  const payoff = useMemo(() => payoffRows(list), [list]);
  const candidates = useMemo(() => retirementCandidates(list), [list]);
  const pending = useMemo(
    () => pendingDecisions(decisions.data?.decisions ?? [], list),
    [decisions.data, list],
  );
  const distil = useMemo(() => readyToDistil(offences.data ?? [], list), [offences.data, list]);
  const shown = useMemo(() => filterLessons(list, status), [list, status]);
  const retireLimit = list[0]?.usage.retireAfterUnusedRuns;

  const setParam = (key: string, value: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );

  const proposeParam = params.get('propose');
  const proposeReady = classes.data !== undefined && offences.data !== undefined && types.data !== undefined;
  const lessonParam = params.get('lesson');
  const openLesson = lessonParam ? (list.find((l) => l.lessonId === lessonParam) ?? null) : null;

  const confirmRetire = async () => {
    if (!retireTarget) return;
    setRetiring(true);
    setRetireError(undefined);
    try {
      await apiPost<LessonDTO>(`/api/learning/lessons/${encodeURIComponent(retireTarget.lessonId)}/retire`);
      toast.notify({
        tone: 'ok',
        title: 'Lesson retired',
        body: `No longer injected into ${SCOPE_LABEL[retireTarget.scopeType].toLowerCase()} ${retireTarget.scopeValue}.`,
      });
      setRetireTarget(null);
      lessons.reload();
    } catch (err) {
      setRetireError(err);
    } finally {
      setRetiring(false);
    }
  };

  const columns = useMemo<DataTableColumn<LessonDTO>[]>(
    () => [
      {
        id: 'rule',
        header: 'Lesson',
        primary: true,
        cell: (l) => (
          <span className="knowledge-lesson">
            <span className="knowledge-lesson__rule">{l.rule}</span>
            {l.className && <span className="knowledge-muted">Class: {l.className}</span>}
          </span>
        ),
      },
      {
        id: 'scope',
        header: 'Scope',
        sortValue: (l) => `${l.scopeType}:${l.scopeValue}`,
        cell: (l) => (
          <Chip icon={l.scopeType === 'process_type' ? 'registry' : 'projects'}>
            <span className="aoc-sr-only">{SCOPE_LABEL[l.scopeType]}: </span>
            {l.scopeValue}
          </Chip>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        sortValue: (l) => l.status,
        cell: (l) => (
          <span className="knowledge-stack">
            <Badge tone={STATUS_META[l.status].tone} icon={STATUS_META[l.status].icon}>
              {STATUS_META[l.status].label}
            </Badge>
            <span className="knowledge-muted aoc-num">
              {l.status === 'bound' && l.boundAt
                ? `bound ${formatShortDate(l.boundAt)}`
                : l.status === 'retired' && l.retiredAt
                  ? `${formatShortDate(l.retiredAt)} · ${l.retireReason ?? 'retired'}`
                  : l.status === 'rejected' && l.rejectedAt
                    ? formatShortDate(l.rejectedAt)
                    : `proposed ${formatShortDate(l.proposedAt)}`}
            </span>
          </span>
        ),
      },
      {
        id: 'usage',
        header: 'Runs',
        numeric: true,
        sortValue: (l) => l.usage.appliedRuns,
        width: '150px',
        cell: (l) => (
          <span className="knowledge-stack is-end">
            <span>
              {formatInteger(l.usage.appliedRuns)} · used {formatInteger(l.usage.usedRuns)}
            </span>
            {l.status === 'bound' && (
              <span
                className={
                  l.usage.unusedStreak > 0 ? 'knowledge-muted knowledge-streak is-on' : 'knowledge-muted'
                }
              >
                {formatInteger(l.usage.unusedStreak)} of {formatInteger(l.usage.retireAfterUnusedRuns)} unused
                in a row
              </span>
            )}
          </span>
        ),
      },
      {
        id: 'payoff',
        header: 'Repeats prevented',
        numeric: true,
        sortValue: (l) => (l.payoff?.measurable ? l.payoff.repeatsPrevented : null),
        cell: (l) =>
          l.payoff?.measurable ? (
            <span className="knowledge-stack is-end">
              <strong>{signed(l.payoff.repeatsPrevented)}</strong>
              <span className="knowledge-muted">
                {formatUsd(l.payoff.usdSaved)} · {formatDuration(Math.max(0, l.payoff.msSaved))}
              </span>
            </span>
          ) : (
            <span className="knowledge-muted">{l.boundAt ? 'no class to measure' : 'after binding'}</span>
          ),
      },
      {
        id: 'action',
        header: 'Action',
        hideHeader: true,
        align: 'end',
        cell: (l) =>
          l.status === 'proposed' ? (
            <ButtonLink to={decisionHref(l.decisionId)} size="sm" icon="decisions">
              Review
            </ButtonLink>
          ) : canCurate && l.status === 'bound' ? (
            <Button size="sm" variant="ghost" onClick={() => setRetireTarget(l)}>
              Retire…
            </Button>
          ) : null,
      },
    ],
    [canCurate],
  );

  const oldestPending = pending[0];
  const overdue = pending.some((p) => p.decision.overdue);

  return (
    <>
      <PageHeader
        title="Knowledge"
        subtitle="Distilled lessons: scoped to a process type or code area, bound only by an Approver's decision, retired when unused."
        actions={
          canCurate ? (
            <Button variant="primary" icon="plus" onClick={() => setParam('propose', '')}>
              Propose lesson
            </Button>
          ) : undefined
        }
        meta={
          <>
            <Chip icon="knowledge">Never global</Chip>
            <span>
              Repeat offences and their fixes live in <Link to="/learning">Learning</Link>
            </span>
          </>
        }
      />

      <KpiStrip label="Lessons at a glance">
        <KpiTile
          label="Lessons in force"
          href="#lessons"
          value={lessons.data ? summary.inForce : '—'}
          footnote={
            lessons.data
              ? `${formatInteger(summary.processTypes)} process type${summary.processTypes === 1 ? '' : 's'} · ${formatInteger(
                  summary.codeAreas,
                )} code area${summary.codeAreas === 1 ? '' : 's'}`
              : undefined
          }
          info="Bound lessons are injected into every session in their scope, and only there."
        />
        <KpiTile
          label="Repeats prevented"
          href="#payoff"
          value={lessons.data ? (summary.measurable > 0 ? signed(summary.repeatsPrevented) : '—') : '—'}
          footnote={
            summary.measurable > 0
              ? `across ${formatInteger(summary.measurable)} lesson${summary.measurable === 1 ? '' : 's'}, vs baseline`
              : 'measured once a bound lesson has runs in scope'
          }
          info="Expected recurrences (each lesson's class rate before binding × runs in scope since) minus actual recurrences. Negative means a lesson is not working."
        />
        <KpiTile
          label="Saved"
          href="#payoff"
          value={lessons.data ? formatUsd(summary.usdSaved) : '—'}
          footnote={`notional · ${formatDuration(Math.max(0, summary.msSaved))} agent time${
            summary.tokensSaved > 0 ? ` · ${formatTokens(summary.tokensSaved)} tokens` : ''
          }`}
          info="Repeats prevented × the class's average occurrence cost: notional API-equivalent dollars, agent time and tokens."
        />
        <KpiTile
          label="Awaiting decision"
          value={decisions.data ? pending.length : '—'}
          tone={overdue ? 'warn' : 'neutral'}
          footnote={
            oldestPending ? (
              <>
                oldest <RelativeTime value={oldestPending.decision.createdAt} />
                {overdue ? ' · overdue' : ''}
              </>
            ) : decisions.data ? (
              'nothing waiting'
            ) : undefined
          }
          href={oldestPending ? decisionHref(oldestPending.decision.id) : undefined}
          info="Binding a lesson is a human-required decision: one bad lesson corrupts the fleet."
        />
        <KpiTile
          label="Retirement candidates"
          href="#lessons"
          value={lessons.data ? candidates.length : '—'}
          tone={candidates.length > 0 ? 'warn' : 'neutral'}
          footnote={
            retireLimit
              ? `retire after ${formatInteger(retireLimit)} unused runs`
              : 'retire when unused for N runs'
          }
          info="Lessons in force that are halfway or more to automatic retirement. A growing global rulebook slows every session (R10)."
        />
      </KpiStrip>

      <WidgetGrid>
        <Widget
          span={7}
          id="payoff"
          title="Payoff by lesson"
          subtitle="Repeats prevented since binding · savings notional"
          info="One shared scale around zero. A bar left of zero means the class recurs more than its baseline predicts: prune that lesson."
          busy={lessons.loading && lessons.data !== undefined}
        >
          {lessons.data === undefined && !lessons.error ? (
            <Skeleton height={140} label="Loading lesson payoff" />
          ) : (
            <ResourceView
              resource={lessons}
              isEmpty={() => payoff.length === 0}
              empty={
                <EmptyState
                  size="sm"
                  icon="knowledge"
                  title="No lesson has been bound yet"
                  body={
                    summary.byStatus.proposed > 0
                      ? `${formatInteger(summary.byStatus.proposed)} proposed lesson${
                          summary.byStatus.proposed === 1 ? ' awaits' : 's await'
                        } an Approver's decision. Payoff is measured from the first run in scope after binding.`
                      : 'Distil a lesson from a repeat offence with a stated fix. Payoff is measured from the first run in scope after binding.'
                  }
                />
              }
              errorTitle="Couldn't load lessons"
            >
              {() => <PayoffChart rows={payoff} onOpen={(id) => setParam('lesson', id)} />}
            </ResourceView>
          )}
        </Widget>

        <Widget
          span={5}
          title="Rulebook"
          subtitle="Kept small on purpose (R10)"
          info="Lessons are scoped, never global, and retire automatically after a run of unused sessions."
        >
          {lessons.data === undefined && !lessons.error ? (
            <Skeleton height={140} label="Loading the rulebook" />
          ) : (
            <ResourceView resource={lessons} isEmpty={() => false} errorTitle="Couldn't load lessons">
              {(all) => (
                <div className="knowledge-rulebook">
                  <ul className="knowledge-rulebook__statuses">
                    {(['bound', 'proposed', 'retired', 'rejected'] as const).map((s) => (
                      <li key={s}>
                        <button
                          type="button"
                          className="knowledge-rulebook__status"
                          onClick={() => setStatus(s)}
                          aria-pressed={status === s}
                        >
                          <strong className="aoc-num">{formatInteger(summary.byStatus[s])}</strong>
                          <Badge tone={STATUS_META[s].tone} icon={STATUS_META[s].icon}>
                            {STATUS_META[s].label}
                          </Badge>
                        </button>
                      </li>
                    ))}
                  </ul>
                  <h3 className="knowledge-rulebook__h">Scopes in force</h3>
                  {summary.inForce === 0 ? (
                    <p className="knowledge-muted">None yet: no session receives a lesson today.</p>
                  ) : (
                    <ul className="knowledge-rulebook__scopes">
                      {[
                        ...new Set(
                          all
                            .filter((l) => l.status === 'bound')
                            .map((l) => `${l.scopeType}|${l.scopeValue}`),
                        ),
                      ].map((key) => {
                        const [type, value] = key.split('|') as [LessonDTO['scopeType'], string];
                        const n = all.filter(
                          (l) => l.status === 'bound' && l.scopeType === type && l.scopeValue === value,
                        ).length;
                        return (
                          <li key={key}>
                            <Chip icon={type === 'process_type' ? 'registry' : 'projects'}>
                              <span className="aoc-sr-only">{SCOPE_LABEL[type]}: </span>
                              {value}
                              <span className="knowledge-rulebook__n aoc-num"> ×{n}</span>
                            </Chip>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </ResourceView>
          )}
        </Widget>

        <Widget
          span={12}
          title="Awaiting a decision"
          subtitle="Lesson binding · oldest first"
          info="Nothing reaches a session until an Approver binds it. The requester of a decision never resolves it."
        >
          {decisions.data === undefined && !decisions.error ? (
            <Skeleton height={64} label="Loading pending lesson decisions" />
          ) : (
            <ResourceView
              resource={decisions}
              isEmpty={() => pending.length === 0}
              empty={
                <p className="knowledge-quiet">
                  No lesson awaits a decision. Proposing a lesson raises a lesson-binding decision for an
                  Approver.
                </p>
              }
              errorTitle="Couldn't load lesson decisions"
            >
              {() => (
                <ul className="knowledge-pending">
                  {pending.map(({ decision: d, lesson: l }) => {
                    const blocked = blockedReason(d);
                    return (
                      <li key={d.id} className="knowledge-pending__item">
                        <div className="knowledge-pending__main">
                          <span className="knowledge-pending__title">{d.title}</span>
                          <span className="knowledge-muted knowledge-pending__rule">
                            {l
                              ? l.rule
                              : 'No matching lesson in the registry: review the decision for details.'}
                          </span>
                        </div>
                        <div className="knowledge-pending__meta aoc-num">
                          <span>
                            waiting <RelativeTime value={d.createdAt} />
                          </span>
                          {d.overdue && (
                            <Badge tone="warn" icon="warn">
                              Overdue
                            </Badge>
                          )}
                        </div>
                        <div className="knowledge-pending__action">
                          {blocked && <span className="knowledge-muted">{blocked}</span>}
                          <ButtonLink
                            to={decisionHref(d.id)}
                            size="sm"
                            variant={blocked ? 'ghost' : 'secondary'}
                            icon="decisions"
                          >
                            {blocked ? 'View' : 'Review and decide'}
                          </ButtonLink>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </ResourceView>
          )}
        </Widget>

        {candidates.length > 0 && (
          <Widget
            span={12}
            title="Retirement candidates"
            subtitle="In force but rarely exercised · closest to automatic retirement first"
          >
            <ul className="knowledge-retire">
              {candidates.map((l) => (
                <li key={l.lessonId} className="knowledge-retire__item">
                  <button
                    type="button"
                    className="knowledge-retire__rule aoc-link-button"
                    onClick={() => setParam('lesson', l.lessonId)}
                  >
                    {l.rule}
                  </button>
                  <Meter
                    label={`${SCOPE_LABEL[l.scopeType]} ${l.scopeValue}`}
                    value={l.usage.unusedStreak}
                    max={l.usage.retireAfterUnusedRuns}
                    warnAt={0.5}
                    dangerAt={0.8}
                    detail={`${l.usage.unusedStreak} of ${l.usage.retireAfterUnusedRuns} unused runs (${Math.round(
                      retirementProgress(l) * 100,
                    )}%)`}
                  />
                  {canCurate && (
                    <Button size="sm" variant="ghost" onClick={() => setRetireTarget(l)}>
                      Retire now…
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Widget>
        )}

        {canCurate && (
          <Widget
            span={12}
            title="Ready to distil"
            subtitle="Repeat offences with a stated fix and no lesson yet · costliest first"
            info="An error earns a lesson only as a repeatable class with a stated fix. Transient errors never do."
          >
            {offences.data === undefined && !offences.error ? (
              <Skeleton height={64} label="Loading repeat offences" />
            ) : (
              <ResourceView
                resource={combine(offences, lessons)}
                isEmpty={() => distil.length === 0}
                empty={
                  <p className="knowledge-quiet">
                    Nothing ready: a repeat offence becomes a candidate once its fix is recorded in{' '}
                    <Link to="/learning#offences">Learning</Link>.
                  </p>
                }
                errorTitle="Couldn't load repeat offences"
              >
                {() => (
                  <ul className="knowledge-distil">
                    {distil.map((o) => (
                      <li key={o.offenceId} className="knowledge-distil__item">
                        <div className="knowledge-distil__main">
                          <Link
                            to={`/learning?class=${encodeURIComponent(o.classId)}`}
                            className="knowledge-distil__name"
                          >
                            {o.className}
                          </Link>
                          <span className="knowledge-muted">{o.fix}</span>
                        </div>
                        <span className="knowledge-distil__cost aoc-num">
                          {formatUsd(o.costOfRecurrenceUsd)}
                          <span className="knowledge-muted">
                            {' '}
                            notional · {formatInteger(o.occurrences)} occurrences
                          </span>
                        </span>
                        <Button size="sm" onClick={() => setParam('propose', o.classId)}>
                          Propose lesson
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </ResourceView>
            )}
          </Widget>
        )}

        <Widget span={12} id="lessons" title="Lessons" subtitle="The registry · newest first" flush>
          {lessons.data === undefined && !lessons.error ? (
            <Skeleton height={160} label="Loading lessons" />
          ) : (
            <ResourceView resource={lessons} isEmpty={() => false} errorTitle="Couldn't load lessons">
              {() => (
                <div className="knowledge-registry">
                  <FilterBar
                    label="Lesson filters"
                    end={
                      <span className="aoc-num">
                        {formatInteger(shown.length)} of {formatInteger(list.length)}
                      </span>
                    }
                  >
                    <SegmentedControl
                      label="Status"
                      size="sm"
                      value={status}
                      options={STATUS_FILTERS}
                      onChange={setStatus}
                    />
                  </FilterBar>
                  <DataTable
                    caption="Distilled lessons"
                    columns={columns}
                    rows={shown}
                    rowKey={(l) => l.lessonId}
                    onRowClick={(l) => setParam('lesson', l.lessonId)}
                    rowLabel={(l) => `Open lesson for ${l.scopeValue}`}
                    activeRowKey={lessonParam ?? undefined}
                    busy={lessons.loading}
                    empty={
                      <EmptyState
                        size="sm"
                        icon="knowledge"
                        title={
                          status === 'all'
                            ? 'No lessons yet'
                            : `No ${STATUS_META[status].label.toLowerCase()} lessons`
                        }
                        body={
                          status === 'all'
                            ? 'Lessons are distilled from repeat offences with a stated fix, then bound by an Approver.'
                            : undefined
                        }
                      />
                    }
                  />
                </div>
              )}
            </ResourceView>
          )}
        </Widget>

        <Widget
          span={12}
          title="Search team knowledge"
          subtitle="Resolved bugs, playbooks, lessons and decisions as institutional memory"
        >
          <KnowledgeSearch />
        </Widget>
      </WidgetGrid>

      <LessonDrawer
        lesson={openLesson}
        canCurate={canCurate}
        onClose={() => setParam('lesson', null)}
        onRetire={(l) => setRetireTarget(l)}
      />

      <ProposeLessonDialog
        open={proposeParam !== null && proposeReady && canCurate}
        initialClassId={proposeParam || null}
        classes={classes.data ?? []}
        offences={offences.data ?? []}
        processTypes={types.data?.types ?? []}
        onClose={() => setParam('propose', null)}
        onDone={(lesson) => {
          setParam('propose', null);
          lessons.reload();
          decisions.reload();
          toast.notify({
            tone: 'ok',
            title: 'Lesson proposed for a decision',
            body: 'An Approver binds it before any session sees it.',
            action: { label: 'Open decision', onClick: () => navigate(decisionHref(lesson.decisionId)) },
          });
        }}
      />

      <Dialog
        open={retireTarget !== null}
        onClose={() => {
          setRetireTarget(null);
          setRetireError(undefined);
        }}
        role="alertdialog"
        size="sm"
        title="Retire this lesson?"
        description={
          retireTarget
            ? `It stops being injected into ${SCOPE_LABEL[retireTarget.scopeType].toLowerCase()} ${retireTarget.scopeValue}.${
                retireTarget.status === 'proposed' ? ' Its open binding decision is withdrawn.' : ''
              } It stays in the registry and the audit log.`
            : undefined
        }
        initialFocus={cancelRetireRef}
        footer={
          <>
            <Button
              ref={cancelRetireRef}
              onClick={() => {
                setRetireTarget(null);
                setRetireError(undefined);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void confirmRetire()}
              loading={retiring}
              loadingText="Retiring…"
            >
              Retire lesson
            </Button>
          </>
        }
      >
        {retireTarget && <p className="knowledge-prose">{retireTarget.rule}</p>}
        {retireError !== undefined && (
          <InlineAlert tone="danger" title="Not retired" live>
            {describeError(retireError)}
          </InlineAlert>
        )}
      </Dialog>
    </>
  );
}
