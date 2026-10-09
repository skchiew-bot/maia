import type { DecisionCardView } from '@aoc/contracts';
import { useMemo } from 'react';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { formatAge, formatClock, formatShortDate } from '../../lib/format';
import { DECISION_KIND_WORD, DecisionCard, TestChip } from '../console/DecisionRail';

export interface SessionDecisionsProps {
  decisions: readonly DecisionCardView[];
  nameOf: (id: string) => string | null;
  now: number;
  onResolved: () => void;
}

/** Who closed a card, in words: a name when known, else the role the policy required (never a raw id). */
export function resolverText(d: DecisionCardView, nameOf: (id: string) => string | null): string {
  if (d.status === 'withdrawn') return d.withdrawal ? (nameOf(d.withdrawal.by) ?? 'withdrawn') : 'withdrawn';
  if (d.status === 'expired') return 'expired';
  const r = d.resolution;
  if (!r) return '—';
  if (r.method === 'policy') return 'policy';
  return nameOf(r.resolvedBy) ?? (d.requiredRole === 'approver' ? 'an Approver' : 'a Builder');
}

function outcomeOf(d: DecisionCardView): string {
  if (d.status === 'open') return 'Waiting';
  if (d.status !== 'resolved' || !d.resolution) return d.status === 'withdrawn' ? 'Withdrawn' : 'Expired';
  const option = d.options.find((o) => o.id === d.resolution!.optionId);
  const rec = d.recommendation?.optionId === d.resolution.optionId ? ' (recommended)' : '';
  return `${option?.label ?? d.resolution.optionId}${rec}`;
}

/** Decisions this session raised: open ones as actionable cards, then the log with how long each waited. */
export function SessionDecisions({ decisions, nameOf, now, onResolved }: SessionDecisionsProps) {
  const open = decisions.filter((d) => d.status === 'open').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const closed = decisions.filter((d) => d.status !== 'open');
  const columns = useMemo<DataTableColumn<DecisionCardView>[]>(
    () => [
      {
        id: 'asked',
        header: 'Asked',
        sortValue: (d) => d.createdAt,
        firstSort: 'desc',
        cell: (d) => {
          const t = Date.parse(d.createdAt);
          return <time dateTime={d.createdAt}>{now - t > 20 * 3600_000 ? `${formatShortDate(t)} ${formatClock(t)}` : formatClock(t)}</time>;
        },
      },
      {
        id: 'question',
        header: 'Question',
        primary: true,
        cell: (d) => (
          <span className="session-dlog__q">
            {d.title}
            {d.question && d.question !== d.title && <span className="session-dlog__ask">{d.question}</span>}
            <span className="session-dlog__kind">
              {DECISION_KIND_WORD[d.kind] ?? d.kind} <TestChip test={d.test} />
            </span>
          </span>
        ),
      },
      { id: 'outcome', header: 'Outcome', cell: (d) => outcomeOf(d) },
      { id: 'by', header: 'By', cell: (d) => resolverText(d, nameOf) },
      {
        id: 'waited',
        header: 'Waited',
        numeric: true,
        sortValue: (d) => d.ageMs,
        cell: (d) => formatAge(d.ageMs),
      },
    ],
    [nameOf, now],
  );
  if (decisions.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon="decisions"
        title="No decisions raised"
        body="When this session needs a person (main, production, data, irreversible or ambiguous work), it ends its turn and the decision appears here."
      />
    );
  }
  return (
    <div className="session-decisions">
      {open.length > 0 && (
        <ol className="console-dlist session-decisions__open" aria-label="Open decisions">
          {open.map((d) => (
            <DecisionCard key={d.id} decision={d} session={undefined} onResolved={onResolved} />
          ))}
        </ol>
      )}
      {closed.length > 0 && (
        <DataTable
          caption="Decisions this session raised"
          columns={columns}
          rows={closed}
          rowKey={(d) => d.id}
          defaultSort={{ columnId: 'asked', direction: 'desc' }}
        />
      )}
    </div>
  );
}
