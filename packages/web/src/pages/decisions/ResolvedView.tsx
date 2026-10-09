import { useMemo } from 'react';
import type { DecisionCardView } from '@aoc/contracts';
import { Badge } from '../../components/Badge';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { EmptyState } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { RelativeTime } from '../../components/RelativeTime';
import { Widget, WidgetGrid } from '../../components/Widget';
import { formatAge, formatInteger } from '../../lib/format';
import type { Directory } from './directory';
import { KIND_LABEL, closedWithinSla, latencyByKind, methodLabel, outcomeLabel, requesterOf } from './model';
import { SlaLatency } from './SlaLatency';

function decidedBy(card: DecisionCardView, directory: Directory): string {
  if (card.resolution) return requesterOf(card.resolution.resolvedBy, directory).name;
  if (card.withdrawal) return requesterOf(card.withdrawal.by, directory).name;
  return '—';
}

function SlaVerdict({ card }: { card: DecisionCardView }) {
  if (card.status !== 'resolved') return <span className="dec-muted">not decided</span>;
  const within = closedWithinSla(card);
  if (within === null) return <span className="dec-muted">no SLA set</span>;
  return within ? (
    <Badge tone="ok" variant="outline" icon="ok">
      within SLA
    </Badge>
  ) : (
    <Badge tone="danger" variant="outline" icon="danger">
      over SLA
    </Badge>
  );
}

export interface ResolvedViewProps {
  cards: readonly DecisionCardView[];
  directory: Directory;
  selectedId: string | null;
  onSelect: (id: string) => void;
  busy: boolean;
}

/** Closed decisions: time to decide per kind against SLA (hero), then every closed card and how it closed. */
export function ResolvedView({ cards, directory, selectedId, onSelect, busy }: ResolvedViewProps) {
  const latency = useMemo(() => latencyByKind(cards), [cards]);
  const columns = useMemo<DataTableColumn<DecisionCardView>[]>(
    () => [
      {
        id: 'decision',
        header: 'Decision',
        primary: true,
        sortValue: (c) => c.title,
        cell: (c) => (
          <span className="dec-cell-title">
            <span className="dec-cell-title__main">{c.title}</span>
            <span className="dec-cell-title__sub">{KIND_LABEL[c.kind]}</span>
          </span>
        ),
      },
      {
        id: 'outcome',
        header: 'Outcome',
        width: '18%',
        sortValue: (c) => outcomeLabel(c),
        cell: (c) => outcomeLabel(c),
      },
      {
        id: 'by',
        header: 'Decided by',
        width: '150px',
        sortValue: (c) => decidedBy(c, directory),
        cell: (c) => <span className="dec-nowrap">{decidedBy(c, directory)}</span>,
      },
      {
        id: 'method',
        header: 'How',
        width: '210px',
        sortValue: (c) => (c.resolution ? methodLabel(c.resolution) : ''),
        cell: (c) =>
          c.resolution ? (
            <span className="dec-method">
              <Icon
                name={
                  c.resolution.method === 'passkey'
                    ? 'key'
                    : c.resolution.method === 'policy'
                      ? 'registry'
                      : 'user'
                }
                size={12}
              />
              {methodLabel(c.resolution)}
            </span>
          ) : (
            <span className="dec-muted">—</span>
          ),
      },
      {
        id: 'latency',
        header: 'Time to decide',
        numeric: true,
        width: '180px',
        sortValue: (c) => c.ageMs,
        cell: (c) => (
          <span className="dec-latency-cell">
            <span className="aoc-num">{formatAge(c.ageMs)}</span>
            <SlaVerdict card={c} />
          </span>
        ),
      },
      {
        id: 'closed',
        header: 'Closed',
        numeric: true,
        width: '110px',
        firstSort: 'desc',
        sortValue: (c) => (c.closedAt ? Date.parse(c.closedAt) : null),
        cell: (c) => (c.closedAt ? <RelativeTime value={c.closedAt} suffix=" ago" /> : '—'),
      },
    ],
    [directory],
  );

  const resolved = cards.filter((c) => c.status === 'resolved');
  const signed = resolved.filter((c) => c.resolution?.method === 'passkey').length;

  return (
    <WidgetGrid>
      <Widget
        span={12}
        title="Time to decide, by kind"
        subtitle={`${formatInteger(resolved.length)} resolved · each kind scaled to its own SLA`}
        info="Time from request to resolution for resolved decisions in the loaded history (up to 500), as p50 (bar) and p90 (whisker). Each row is scaled from 0 to twice its SLA, so the SLA line sits in the middle of every row. SLAs are the CEO-approved ones; withdrawn and expired decisions are left out."
        busy={busy}
      >
        {latency.length ? (
          <SlaLatency rows={latency} />
        ) : (
          <EmptyState
            size="sm"
            icon="decisions"
            title="No resolved decisions yet"
            body="Latency appears once a decision is resolved."
          />
        )}
      </Widget>
      <Widget
        span={12}
        flush
        title="Closed decisions"
        subtitle={`${formatInteger(cards.length)} closed · ${formatInteger(signed)} signed with a passkey`}
        busy={busy}
      >
        <DataTable
          caption="Closed decisions, most recently closed first"
          columns={columns}
          rows={cards}
          rowKey={(c) => c.id}
          defaultSort={{ columnId: 'closed', direction: 'desc' }}
          onRowClick={(c) => onSelect(c.id)}
          rowLabel={(c) => `Open ${c.title}`}
          activeRowKey={selectedId ?? undefined}
          maxHeight={560}
          empty={<EmptyState size="sm" icon="decisions" title="Nothing closed matches these filters" />}
        />
      </Widget>
    </WidgetGrid>
  );
}
