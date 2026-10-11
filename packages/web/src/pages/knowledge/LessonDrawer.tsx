import { Link } from 'react-router-dom';
import type { LessonDTO } from '@aoc/contracts';
import { Meter } from '../../charts';
import {
  Badge,
  Button,
  ButtonLink,
  DescriptionList,
  Drawer,
  HiddenTextWarning,
  RevealedText,
  TokenCount,
  formatDateTime,
  formatDuration,
  formatInteger,
  formatNumber,
  formatUsd,
} from '../../components';
import { decisionHref } from '../../lib/links';
import { RETIRE_REASON, SCOPE_LABEL, STATUS_META } from './model';

export interface LessonDrawerProps {
  lesson: LessonDTO | null;
  canCurate: boolean;
  onClose: () => void;
  onRetire: (lesson: LessonDTO) => void;
}

function signed(n: number): string {
  const v = formatNumber(Math.abs(n), 1);
  return n > 0 ? `+${v}` : n < 0 ? `−${v}` : '0';
}

function Payoff({ lesson }: { lesson: LessonDTO }) {
  const p = lesson.payoff;
  if (!p) return <p className="knowledge-muted">Measured from the first run in scope after binding.</p>;
  if (!p.measurable)
    return (
      <p className="knowledge-muted">
        Not measurable: the lesson has no root-cause class to compare recurrence against.
      </p>
    );
  return (
    <DescriptionList
      columns={2}
      items={[
        {
          term: 'Repeats prevented',
          value: (
            <span className="aoc-num">
              <strong>{signed(p.repeatsPrevented)}</strong>{' '}
              <span className="knowledge-muted">
                expected {formatNumber(p.expectedRecurrences, 1)}, actual {formatInteger(p.recurrencesAfter)}
              </span>
            </span>
          ),
        },
        {
          term: 'Baseline before binding',
          value: (
            <span className="aoc-num">
              {formatNumber(p.baselineRatePerExposure, 2)} per run ({formatInteger(p.occurrencesBefore)} in{' '}
              {formatInteger(p.exposuresBefore)} runs)
            </span>
          ),
        },
        {
          term: 'Runs in scope since binding',
          value: <span className="aoc-num">{formatInteger(p.exposuresAfter)}</span>,
        },
        {
          term: 'Average occurrence',
          value: (
            <span className="aoc-num">
              {formatUsd(p.avgOccurrenceCostUsd)} · {formatDuration(p.avgOccurrenceMs)}
            </span>
          ),
        },
        {
          term: 'Saved (notional)',
          value: <span className="aoc-num">{formatUsd(p.usdSaved)}</span>,
        },
        {
          term: 'Time and tokens saved',
          value: (
            <span className="aoc-num">
              {formatDuration(Math.max(0, p.msSaved))} · <TokenCount value={Math.max(0, p.tokensSaved)} />
            </span>
          ),
        },
      ]}
    />
  );
}

/** One lesson: its rule, scope, decision trail, usage toward retirement and measured payoff. */
export function LessonDrawer({ lesson, canCurate, onClose, onRetire }: LessonDrawerProps) {
  const l = lesson;
  const meta = l ? STATUS_META[l.status] : undefined;
  const active = l?.status === 'bound' || l?.status === 'proposed';
  return (
    <Drawer
      open={l !== null}
      onClose={onClose}
      title={l ? `Lesson for ${SCOPE_LABEL[l.scopeType].toLowerCase()} ${l.scopeValue}` : ''}
      description={meta?.hint}
      width={520}
      footer={
        l ? (
          <div className="knowledge-drawer__actions">
            {l.status === 'proposed' && (
              <ButtonLink to={decisionHref(l.decisionId)} variant="primary" icon="decisions">
                Review decision
              </ButtonLink>
            )}
            {canCurate && active && (
              <Button variant="danger" onClick={() => onRetire(l)}>
                {l.status === 'proposed' ? 'Withdraw and retire…' : 'Retire…'}
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      {l && meta && (
        <div className="knowledge-drawer">
          <div className="knowledge-drawer__status">
            <Badge tone={meta.tone} icon={meta.icon}>
              {meta.label}
            </Badge>
            <span className="knowledge-muted">
              {l.origin === 'ai' ? 'Distilled by AI' : 'Proposed by a person'}
            </span>
          </div>
          <section className="knowledge-drawer__section" aria-labelledby="knowledge-rule-title">
            <h3 id="knowledge-rule-title" className="knowledge-drawer__h">
              Rule
            </h3>
            <HiddenTextWarning texts={[l.rule, l.fix, l.rationale]} />
            <p className="knowledge-prose">
              <RevealedText text={l.rule} />
            </p>
            <h3 className="knowledge-drawer__h">Fix</h3>
            <p className="knowledge-prose">
              <RevealedText text={l.fix} />
            </p>
            {l.rationale && (
              <>
                <h3 className="knowledge-drawer__h">Rationale</h3>
                <p className="knowledge-prose">
                  <RevealedText text={l.rationale} />
                </p>
              </>
            )}
          </section>
          <DescriptionList
            columns={2}
            items={[
              { term: 'Scope', value: `${SCOPE_LABEL[l.scopeType]} · ${l.scopeValue}` },
              {
                term: 'Root-cause class',
                value:
                  l.classId && l.className ? (
                    <Link to={`/learning?class=${encodeURIComponent(l.classId)}`}>{l.className}</Link>
                  ) : (
                    'None'
                  ),
              },
              { term: 'Proposed', value: formatDateTime(l.proposedAt) },
              {
                term: l.status === 'rejected' ? 'Rejected' : l.status === 'retired' ? 'Retired' : 'Bound',
                value:
                  l.status === 'rejected' && l.rejectedAt
                    ? formatDateTime(l.rejectedAt)
                    : l.status === 'retired' && l.retiredAt
                      ? `${formatDateTime(l.retiredAt)}${l.retireReason ? ` · ${RETIRE_REASON[l.retireReason]}` : ''}`
                      : l.boundAt
                        ? formatDateTime(l.boundAt)
                        : 'Not yet',
              },
              {
                term: 'Binding decision',
                value: <Link to={decisionHref(l.decisionId)}>Open in Decisions</Link>,
              },
              {
                term: 'Runs it was injected into',
                value: (
                  <span className="aoc-num">
                    {formatInteger(l.usage.appliedRuns)} · used {formatInteger(l.usage.usedRuns)}, unused{' '}
                    {formatInteger(l.usage.unusedRuns)}
                    {l.usage.pendingRuns > 0 && `, ${formatInteger(l.usage.pendingRuns)} still running`}
                  </span>
                ),
              },
            ]}
          />
          {l.status === 'bound' && (
            <Meter
              label="Toward automatic retirement"
              value={l.usage.unusedStreak}
              max={l.usage.retireAfterUnusedRuns}
              warnAt={0.5}
              dangerAt={0.8}
              detail={`${formatInteger(l.usage.unusedStreak)} of ${formatInteger(
                l.usage.retireAfterUnusedRuns,
              )} consecutive unused runs`}
            />
          )}
          <section className="knowledge-drawer__section" aria-labelledby="knowledge-payoff-title">
            <h3 id="knowledge-payoff-title" className="knowledge-drawer__h">
              Payoff since binding
            </h3>
            <Payoff lesson={l} />
          </section>
        </div>
      )}
    </Drawer>
  );
}
