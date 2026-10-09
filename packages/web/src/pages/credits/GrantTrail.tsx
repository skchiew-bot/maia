import { Link } from 'react-router-dom';
import { Badge, DataTable, EmptyState, RelativeTime, type DataTableColumn } from '../../components';
import { formatDateTime, formatUsd } from '../../lib/format';
import type { GrantRow } from './creditsModel';

export interface GrantTrailProps {
  rows: readonly GrantRow[];
  meId: string | null;
  nameOf: (userId: string | null) => string | null;
}

/** Every grant and top-up (§10): who, how much, against what task, approved by whom, balance before and after. */
export function GrantTrail({ rows, meId, nameOf }: GrantTrailProps) {
  const columns: DataTableColumn<GrantRow>[] = [
    {
      id: 'at',
      header: 'When',
      sortValue: (g) => g.at,
      firstSort: 'desc',
      cell: (g) => (
        <span title={formatDateTime(g.at)}>
          <RelativeTime value={g.at} suffix=" ago" />
        </span>
      ),
    },
    {
      id: 'who',
      header: 'Recipient',
      primary: true,
      cell: (g) => (
        <span>
          {g.userName ?? nameOf(g.userId) ?? g.userId}
          {g.userId === meId && <span className="crd-you">you</span>}
        </span>
      ),
    },
    {
      id: 'kind',
      header: 'Kind',
      cell: (g) =>
        g.kind === 'auto' ? (
          <Badge tone="info" icon="credits">
            Auto-grant · 25%, once
          </Badge>
        ) : (
          <Badge tone="accent" icon="decisions">
            Top-up
          </Badge>
        ),
    },
    { id: 'amount', header: 'Amount', numeric: true, sortValue: (g) => g.amountUsd, cell: (g) => formatUsd(g.amountUsd) },
    {
      id: 'by',
      header: 'Approved by',
      cell: (g) => (g.kind === 'auto' ? 'Policy (AI-approved)' : (nameOf(g.approverId) ?? 'the Approver')),
    },
    {
      id: 'against',
      header: 'Against',
      cell: (g) =>
        g.sessionId ? (
          <span>
            <Link to={`/sessions/${encodeURIComponent(g.sessionId)}`}>{g.sessionId}</Link>
            {g.taskId ? <span className="crd-sub">task {g.taskId}</span> : null}
          </span>
        ) : (
          <span className="crd-muted">no session</span>
        ),
    },
    {
      id: 'balance',
      header: 'Balance',
      numeric: true,
      cell: (g) => (
        <span className="aoc-num">
          {formatUsd(g.balanceBefore)} → <b>{formatUsd(g.balanceAfter)}</b>
        </span>
      ),
    },
    {
      id: 'decision',
      header: 'Decision',
      hideOnMobile: true,
      cell: (g) => (g.decisionId ? <Link to="/decisions">decision</Link> : <span className="crd-muted">—</span>),
    },
  ];
  return (
    <DataTable
      caption="Grant and top-up audit trail"
      columns={columns}
      rows={rows}
      rowKey={(g) => g.key}
      defaultSort={{ columnId: 'at', direction: 'desc' }}
      empty={
        <EmptyState
          size="sm"
          icon="audit"
          title="No grants this period"
          body="The first cap in a period records an automatic 25% grant here; approved top-ups follow. Each row is an audited event."
        />
      }
    />
  );
}
