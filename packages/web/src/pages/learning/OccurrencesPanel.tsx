import { useMemo, useState } from 'react';
import type { ErrorOccurrenceDTO } from '@aoc/contracts';
import {
  Badge,
  Button,
  Chip,
  DataTable,
  EmptyState,
  FilterBar,
  RelativeTime,
  Tabs,
  formatDuration,
  formatInteger,
  formatUsd,
  type DataTableColumn,
} from '../../components';
import { SOURCE_LABEL, TIER_LABEL, type SignatureGroup } from './model';

export interface OccurrencesPanelProps {
  /** Newest first. */
  errors: readonly ErrorOccurrenceDTO[];
  /** Unassigned signatures with two or more occurrences. */
  repeating: readonly SignatureGroup[];
  /** Unassigned signatures seen once: transient, logged only. */
  transient: number;
  canCurate: boolean;
  onAssign: (group: SignatureGroup) => void;
  busy?: boolean;
}

const PAGE = 40;

function where(e: ErrorOccurrenceDTO): string {
  return (
    [e.processType, e.modelTier ? TIER_LABEL[e.modelTier] : null, e.codeArea].filter(Boolean).join(' · ') || '—'
  );
}

/**
 * The raw error log behind the learning view. Errors are data, never instructions (escaped as text). A
 * signature repeating without a class is the cue to assign a root cause; one-off errors stay transient.
 */
export function OccurrencesPanel({ errors, repeating, transient, canCurate, onAssign, busy }: OccurrencesPanelProps) {
  const [unclassifiedOnly, setUnclassifiedOnly] = useState(false);
  const [highOnly, setHighOnly] = useState(false);
  const [shown, setShown] = useState(PAGE);

  const filtered = useMemo(
    () =>
      errors.filter(
        (e) => (!unclassifiedOnly || e.classId === null) && (!highOnly || e.priority === 'high'),
      ),
    [errors, unclassifiedOnly, highOnly],
  );

  const groupColumns = useMemo<DataTableColumn<SignatureGroup>[]>(
    () => [
      {
        id: 'signature',
        header: 'Signature',
        primary: true,
        cell: (g) => (
          <span className="learning-sigcell">
            <code className="learning-sigcell__text" title={g.text}>
              {g.text}
            </code>
            <span className="learning-sigcell__meta">
              {g.sources.map((s) => SOURCE_LABEL[s]).join(', ')}
              {g.processTypes.length > 0 && ` · ${g.processTypes.join(', ')}`}
              {g.tiers.length > 0 && ` · ${g.tiers.map((t) => TIER_LABEL[t]).join(', ')}`}
            </span>
          </span>
        ),
      },
      {
        id: 'count',
        header: 'Occurrences',
        numeric: true,
        sortValue: (g) => g.count,
        cell: (g) => (
          <span className="learning-stack">
            <span>{formatInteger(g.count)}</span>
            {g.highPriority > 0 && (
              <span className="learning-muted">{formatInteger(g.highPriority)} high priority</span>
            )}
          </span>
        ),
      },
      {
        id: 'seen',
        header: 'First / last seen',
        numeric: true,
        sortValue: (g) => g.lastSeenAt,
        cell: (g) => (
          <span className="learning-stack">
            <RelativeTime value={g.firstSeenAt} suffix=" ago" />
            <RelativeTime value={g.lastSeenAt} suffix=" ago" className="learning-muted" />
          </span>
        ),
      },
      {
        id: 'cost',
        header: 'Cost (notional)',
        numeric: true,
        sortValue: (g) => g.weightedUsd,
        cell: (g) => (
          <span className="learning-stack">
            <span>{formatUsd(g.weightedUsd)}</span>
            <span className="learning-muted">{formatDuration(g.ms)} agent time</span>
          </span>
        ),
      },
      {
        id: 'action',
        header: 'Action',
        hideHeader: true,
        align: 'end',
        cell: (g) =>
          canCurate ? (
            <Button size="sm" onClick={() => onAssign(g)}>
              Assign root cause
            </Button>
          ) : null,
      },
    ],
    [canCurate, onAssign],
  );

  const errorColumns = useMemo<DataTableColumn<ErrorOccurrenceDTO>[]>(
    () => [
      {
        id: 'when',
        header: 'When',
        sortValue: (e) => e.observedAt,
        firstSort: 'desc',
        sortLabels: ['oldest first', 'newest first'],
        width: '88px',
        cell: (e) => <RelativeTime value={e.observedAt} suffix=" ago" />,
      },
      {
        id: 'what',
        header: 'What happened',
        primary: true,
        cell: (e) => (
          <span className="learning-msg" title={e.message}>
            {e.message}
          </span>
        ),
      },
      {
        id: 'source',
        header: 'Source',
        sortValue: (e) => SOURCE_LABEL[e.source],
        cell: (e) => (
          <span className="learning-inline">
            {SOURCE_LABEL[e.source]}
            {e.priority === 'high' && (
              <Badge tone="warn" icon="arrow-up">
                High
              </Badge>
            )}
          </span>
        ),
      },
      {
        id: 'class',
        header: 'Root-cause class',
        sortValue: (e) => e.className ?? '',
        cell: (e) =>
          e.className ? (
            <span className="learning-classname">{e.className}</span>
          ) : (
            <span className="learning-muted">Unclassified</span>
          ),
      },
      { id: 'where', header: 'Where', hideOnMobile: true, cell: (e) => where(e) },
      {
        id: 'cost',
        header: 'Cost (notional)',
        numeric: true,
        sortValue: (e) => e.cost.weightedUsd,
        cell: (e) => (
          <span
            title={
              e.cost.basis === 'none'
                ? 'No session usage linked to this occurrence'
                : e.cost.provisional
                  ? 'Provisional: the cost window after the error is still open'
                  : undefined
            }
          >
            {e.cost.basis === 'none' ? '—' : formatUsd(e.cost.weightedUsd)}
            {e.cost.provisional && e.cost.basis !== 'none' && <span className="learning-muted"> · open</span>}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <Tabs
      label="Occurrence views"
      items={[
        {
          id: 'repeating',
          label: 'Repeating, no root cause',
          count: repeating.length,
          content: (
            <div className="learning-tabpanel">
              <DataTable
                caption="Repeating error signatures without a root cause"
                columns={groupColumns}
                rows={repeating}
                rowKey={(g) => g.signature}
                busy={busy}
                empty={
                  <EmptyState
                    size="sm"
                    icon="ok"
                    title="Every repeating error has a root cause"
                    body="A signature that shows up twice without a class appears here."
                  />
                }
              />
              <p className="learning-footnote aoc-num">
                {formatInteger(transient)} one-off signature{transient === 1 ? '' : 's'} stay transient: logged,
                never a lesson. A lesson needs a repeatable class with a stated fix.
              </p>
            </div>
          ),
        },
        {
          id: 'all',
          label: 'All occurrences',
          count: errors.length,
          content: (
            <div className="learning-tabpanel">
              <FilterBar
                label="Occurrence filters"
                end={
                  <span className="aoc-num">
                    {formatInteger(Math.min(shown, filtered.length))} of {formatInteger(filtered.length)}
                  </span>
                }
              >
                <Chip selected={unclassifiedOnly} onToggle={setUnclassifiedOnly}>
                  Unclassified only
                </Chip>
                <Chip selected={highOnly} onToggle={setHighOnly}>
                  UAT and high priority
                </Chip>
              </FilterBar>
              <DataTable
                caption="Error occurrences, newest first"
                columns={errorColumns}
                rows={filtered.slice(0, shown)}
                rowKey={(e) => e.errorId}
                busy={busy}
                rowTone={(e) => (e.priority === 'high' ? 'warn' : undefined)}
                empty={<EmptyState size="sm" title="No occurrences match these filters" />}
              />
              {filtered.length > shown && (
                <div className="learning-more">
                  <Button size="sm" variant="ghost" onClick={() => setShown((n) => n + PAGE)}>
                    Show {formatInteger(Math.min(PAGE, filtered.length - shown))} more
                  </Button>
                </div>
              )}
            </div>
          ),
        },
      ]}
    />
  );
}
