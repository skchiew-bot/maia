import type {
  ErrorOccurrenceDTO,
  ModelDimensionClassDTO,
  OffenceDTO,
  RootCauseClassDTO,
} from '@aoc/contracts';
import {
  Badge,
  Button,
  ButtonLink,
  DescriptionList,
  Drawer,
  Money,
  RelativeTime,
  TokenCount,
  formatDateTime,
  formatDuration,
  formatInteger,
  formatShortDate,
  formatUsd,
} from '../../components';
import { LifecycleSteps } from './LifecycleSteps';
import { ModelVerdict } from './ModelDimension';
import {
  DIMENSION_META,
  SOURCE_LABEL,
  STATE_META,
  STEP_ACTION,
  nextSteps,
  perOccurrenceUsd,
  type HumanStep,
} from './model';

export interface OffenceDrawerProps {
  offence: OffenceDTO | null;
  rootCauseClass?: RootCauseClassDTO;
  model?: ModelDimensionClassDTO;
  minRunsPerTier: number;
  /** Newest first; only this class's occurrences are shown. */
  occurrences: readonly ErrorOccurrenceDTO[];
  canCurate: boolean;
  onClose: () => void;
  onStep: (offence: OffenceDTO, step: HumanStep) => void;
}

const RECENT = 8;

function verification(o: OffenceDTO): string {
  if (o.state === 'verified_closed' && o.verifiedClosedAt)
    return `Closed ${formatShortDate(o.verifiedClosedAt)}: no recurrence during the window after the fix.`;
  if (o.state === 'fix_applied' && o.verifyDueAt)
    return `Closes ${formatShortDate(o.verifyDueAt)} if nothing recurs (${formatInteger(o.occurrencesSinceFix)} since the fix).`;
  if (o.state === 'reopened') return 'Recurred after the fix. Record a new fix to restart verification.';
  return 'Starts when a fix is recorded.';
}

/** Everything about one repeat offence: lifecycle, cost, history, the model test and recent occurrences. */
export function OffenceDrawer({
  offence,
  rootCauseClass,
  model,
  minRunsPerTier,
  occurrences,
  canCurate,
  onClose,
  onStep,
}: OffenceDrawerProps) {
  const o = offence;
  const steps = o ? nextSteps(o.state) : [];
  const recent = o ? occurrences.filter((e) => e.classId === o.classId).slice(0, RECENT) : [];
  const dimension = o ? DIMENSION_META[o.dimension] : undefined;
  return (
    <Drawer
      open={o !== null}
      onClose={onClose}
      title={o?.className ?? ''}
      description={dimension ? `${dimension.label} · ${dimension.hint}` : undefined}
      width={520}
      footer={
        o ? (
          <div className="learning-drawer__actions">
            {canCurate &&
              steps.map((s, i) => (
                <Button key={s} variant={i === 0 ? 'primary' : 'secondary'} onClick={() => onStep(o, s)}>
                  {STEP_ACTION[s]}…
                </Button>
              ))}
            {o.fix ? (
              <ButtonLink to={`/knowledge?propose=${encodeURIComponent(o.classId)}`} icon="knowledge">
                Propose a lesson
              </ButtonLink>
            ) : (
              <span className="learning-drawer__why">A lesson needs a stated fix: record the fix first.</span>
            )}
          </div>
        ) : undefined
      }
    >
      {o && (
        <div className="learning-drawer">
          <LifecycleSteps state={o.state} reopenCount={o.reopenCount} />
          <DescriptionList
            columns={2}
            items={[
              {
                term: 'Cost of recurrence',
                value: (
                  <span className="learning-stack">
                    <Money usd={o.costOfRecurrenceUsd} notional />
                    <span className="learning-muted aoc-num">
                      ≈ {formatUsd(perOccurrenceUsd(o))} per occurrence
                    </span>
                  </span>
                ),
              },
              {
                term: 'Occurrences',
                value: (
                  <span className="aoc-num">
                    {formatInteger(o.occurrences)}
                    {o.highPriorityOccurrences > 0 &&
                      ` · ${formatInteger(o.highPriorityOccurrences)} UAT or high priority (weighted ×3)`}
                  </span>
                ),
              },
              {
                term: 'Agent time after occurrences',
                value: (
                  <span className="learning-stack aoc-num">
                    {formatDuration(o.costMs)}
                    {o.costTokens > 0 && <TokenCount value={o.costTokens} />}
                  </span>
                ),
              },
              {
                term: 'Last seen',
                value: rootCauseClass?.lastSeenAt ? (
                  <RelativeTime value={rootCauseClass.lastSeenAt} suffix=" ago" />
                ) : (
                  '—'
                ),
              },
              { term: 'Detected', value: formatDateTime(o.detectedAt) },
              { term: 'Verification', value: verification(o) },
            ]}
          />
          {o.fix && (
            <section className="learning-drawer__section" aria-labelledby="learning-fix-title">
              <h3 id="learning-fix-title" className="learning-drawer__h">
                Stated fix
              </h3>
              <p className="learning-prose">{o.fix}</p>
            </section>
          )}
          <section className="learning-drawer__section" aria-labelledby="learning-model-title">
            <h3 id="learning-model-title" className="learning-drawer__h">
              Model as a root-cause dimension
            </h3>
            {model ? (
              <ModelVerdict cls={model} minRunsPerTier={minRunsPerTier} detailed />
            ) : (
              <p className="learning-muted">
                Not tested yet: the class needs two or more occurrences with a known model.
              </p>
            )}
          </section>
          <section className="learning-drawer__section" aria-labelledby="learning-history-title">
            <h3 id="learning-history-title" className="learning-drawer__h">
              History
            </h3>
            <ol className="learning-history">
              {[...o.history].reverse().map((h, i) => (
                <li key={`${h.at}-${i}`} className="learning-history__item">
                  <div className="learning-history__head">
                    <Badge tone={STATE_META[h.to].tone} icon={STATE_META[h.to].icon}>
                      {STATE_META[h.to].label}
                    </Badge>
                    <time className="learning-muted aoc-num" dateTime={h.at} title={formatDateTime(h.at)}>
                      {formatDateTime(h.at)}
                    </time>
                  </div>
                  <p className="learning-muted aoc-num">
                    {formatInteger(h.occurrences)} occurrence{h.occurrences === 1 ? '' : 's'} ·{' '}
                    {formatUsd(h.costOfRecurrenceUsd)} notional at the time
                  </p>
                  {h.note && <p className="learning-prose">{h.note}</p>}
                </li>
              ))}
            </ol>
          </section>
          <section className="learning-drawer__section" aria-labelledby="learning-recent-title">
            <h3 id="learning-recent-title" className="learning-drawer__h">
              Recent occurrences
            </h3>
            {recent.length === 0 ? (
              <p className="learning-muted">None in the latest occurrences loaded.</p>
            ) : (
              <ul className="learning-recent">
                {recent.map((e) => (
                  <li key={e.errorId} className="learning-recent__item">
                    <span className="learning-recent__meta aoc-num">
                      <RelativeTime value={e.observedAt} suffix=" ago" /> · {SOURCE_LABEL[e.source]}
                      {e.processType ? ` · ${e.processType}` : ''}
                    </span>
                    <span className="learning-recent__text">{e.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
    </Drawer>
  );
}
