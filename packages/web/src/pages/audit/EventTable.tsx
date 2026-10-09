import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { AuditEventHeaderDTO } from '@aoc/contracts';
import { CopyableHash } from '../../components/CopyableHash';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Icon } from '../../components/Icon';
import { formatDateTime, formatInteger } from '../../lib/format';
import { shortId } from './ids';
import { ActorName } from './people';

/** Ids and enums only: chained meta never holds free text (CLAUDE.md), so it is safe to summarise. */
export function scopeSummary(e: Pick<AuditEventHeaderDTO, 'scope'>): string {
  const s = e.scope;
  return [s.projectId, s.changeId, s.sessionId, s.ticketId, s.decisionId]
    .filter((x): x is string => !!x)
    .map((x) => (x.startsWith('prj_') ? x : shortId(x)))
    .join(' · ');
}

export function eventColumns(
  opts: { onOpen?: (e: AuditEventHeaderDTO) => void } = {},
): DataTableColumn<AuditEventHeaderDTO>[] {
  return [
    {
      id: 'seq',
      header: 'Seq',
      numeric: true,
      primary: true,
      width: '80px',
      sortValue: (e) => e.seq,
      cell: (e) =>
        opts.onOpen ? (
          <button type="button" className="audit-seq" onClick={() => opts.onOpen?.(e)}>
            #{formatInteger(e.seq)}
          </button>
        ) : (
          <Link to={`/audit?seq=${e.seq}`} className="audit-seq">
            #{formatInteger(e.seq)}
          </Link>
        ),
    },
    {
      id: 'ts',
      header: 'Time',
      sortValue: (e) => e.ts,
      cell: (e) => (
        <time dateTime={e.ts} className="aoc-num audit-time">
          {formatDateTime(e.ts)}
        </time>
      ),
    },
    {
      id: 'type',
      header: 'Event',
      sortValue: (e) => e.type,
      cell: (e) => (
        <span className="audit-type">
          <code>{e.type}</code>
          {scopeSummary(e) && <span className="audit-type__scope">{scopeSummary(e)}</span>}
        </span>
      ),
    },
    {
      id: 'actor',
      header: 'Actor',
      sortValue: (e) => `${e.actor.kind}:${e.actor.id}`,
      cell: (e) => <ActorName actor={e.actor} />,
    },
    {
      id: 'body',
      header: 'Body',
      cell: (e) =>
        e.hasBody ? (
          <span
            className="audit-body"
            title="A payload exists in the encrypted body store; only its hash is chained"
          >
            <Icon name="key" size={12} />
            <code>{e.payloadHashPrefix}</code>
          </span>
        ) : (
          <span className="audit-body audit-body--none">header only</span>
        ),
      hideOnMobile: true,
    },
    {
      id: 'hash',
      header: 'Hash',
      cell: (e) => <CopyableHash value={e.hash} label={`event ${e.seq} hash`} />,
    },
    {
      id: 'prev',
      header: 'Previous hash',
      cell: (e) => <CopyableHash value={e.prevHash} label={`event ${e.seq} previous hash`} />,
      hideOnMobile: true,
    },
  ];
}

export function EventTable({
  events,
  caption,
  onOpen,
  empty,
  maxHeight,
}: {
  events: readonly AuditEventHeaderDTO[];
  caption: string;
  onOpen?: (e: AuditEventHeaderDTO) => void;
  empty?: ReactNode;
  maxHeight?: number;
}) {
  return (
    <DataTable
      caption={caption}
      columns={eventColumns({ onOpen })}
      rows={events}
      rowKey={(e) => String(e.seq)}
      empty={empty}
      maxHeight={maxHeight}
    />
  );
}
