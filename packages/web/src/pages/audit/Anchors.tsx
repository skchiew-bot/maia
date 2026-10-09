import { useMemo } from 'react';
import type { AnchorDTO, AnchorListDTO, AuditHealthDTO } from '@aoc/contracts';
import {
  Badge,
  CopyableHash,
  DataTable,
  EmptyState,
  Icon,
  InlineAlert,
  RelativeTime,
  type DataTableColumn,
} from '../../components';
import { formatDateTime, formatDuration, formatInteger } from '../../lib/format';
import { anchorAge, parseProofRef } from './model';

export function AnchorsPanel({
  anchors,
  health,
  now,
}: {
  anchors: AnchorListDTO;
  health: AuditHealthDTO;
  now: number;
}) {
  const last = health.lastAnchor;
  const age = anchorAge(last?.at, now, health.staleAfterMs);
  const rows = useMemo(() => [...anchors.anchors].sort((a, b) => b.eventSeq - a.eventSeq), [anchors.anchors]);
  const columns = useMemo<DataTableColumn<AnchorDTO>[]>(
    () => [
      {
        id: 'seq',
        header: 'Anchors head',
        primary: true,
        numeric: true,
        sortValue: (a) => a.seq,
        cell: (a) => <span className="aoc-num">#{formatInteger(a.seq)}</span>,
      },
      {
        id: 'provider',
        header: 'Proof',
        cell: (a) => {
          const p = parseProofRef(a.proofRef);
          return (
            <span className="audit-anchor-proof">
              {a.provider === 'git' ? 'Git commit' : 'RFC 3161 timestamp'}
              <span className="audit-muted">
                {p.kind === 'git' ? (
                  <>
                    <code>{p.commit.slice(0, 10)}</code> · {p.path}
                  </>
                ) : (
                  p.ref
                )}
              </span>
            </span>
          );
        },
      },
      {
        id: 'hash',
        header: 'Chain hash',
        cell: (a) => <CopyableHash value={a.hash} label={`anchored hash at ${a.seq}`} />,
      },
      {
        id: 'signed',
        header: 'Signed',
        cell: (a) => (a.signed === null ? <span className="audit-muted">n/a</span> : a.signed ? 'yes' : 'no'),
        hideOnMobile: true,
      },
      {
        id: 'pushed',
        header: 'Pushed off-host',
        cell: (a) =>
          a.pushed === null ? <span className="audit-muted">no remote</span> : a.pushed ? 'yes' : 'not yet',
        hideOnMobile: true,
      },
      {
        id: 'at',
        header: 'Anchored',
        numeric: true,
        sortValue: (a) => a.anchoredAt,
        cell: (a) => (
          <span title={formatDateTime(a.anchoredAt)}>
            <RelativeTime value={a.anchoredAt} now={now} suffix=" ago" />
          </span>
        ),
      },
    ],
    [now],
  );

  return (
    <div className="audit-anchors">
      <div className="audit-anchors__status">
        <p className="audit-anchors__age">
          <span className="audit-muted">Last anchor</span>
          <strong className="aoc-num">
            {age.ageMs === null ? 'never' : `${formatDuration(age.ageMs)} ago`}
          </strong>
          {age.stale ? (
            <Badge tone="warn" icon="warn">
              older than {formatDuration(health.staleAfterMs)}
            </Badge>
          ) : (
            <Badge tone="ok" icon="ok">
              within {formatDuration(health.staleAfterMs)}
            </Badge>
          )}
        </p>
        <p className="audit-anchors__meta">
          provider <strong>{anchors.provider === 'none' ? 'disabled' : anchors.provider}</strong> ·{' '}
          {anchors.offHost ? (
            <span className="audit-yesno is-yes">
              <Icon name="check" size={12} /> off-host
            </span>
          ) : (
            <span className="audit-yesno is-no">
              <Icon name="warn" size={12} /> local only
            </span>
          )}{' '}
          · <span className="aoc-num">{formatInteger(health.unanchoredTail)}</span> events since the last
          anchor
        </p>
      </div>
      {!anchors.offHost && anchors.provider !== 'none' && (
        <InlineAlert tone="warn" title="Anchors are not off-host">
          They are committed to a repository on this host, so a host-level attacker could rewrite them too
          (R2). Set audit.anchorRemote, or use RFC 3161, before production.
        </InlineAlert>
      )}
      {health.lastAnchorFailure && (
        <InlineAlert
          tone="danger"
          title={`Anchoring failed ${formatDuration(now - Date.parse(health.lastAnchorFailure.at))} ago`}
        >
          {health.lastAnchorFailure.provider}: {health.lastAnchorFailure.reason}
        </InlineAlert>
      )}
      <DataTable
        caption="Off-host anchors"
        columns={columns}
        rows={rows}
        rowKey={(a) => `${a.anchorId}:${a.eventSeq}`}
        maxHeight={300}
        empty={
          <EmptyState
            size="sm"
            icon="audit"
            title="No anchor yet"
            body="The nightly job anchors the chain head; Anchor now does it immediately."
          />
        }
      />
    </div>
  );
}
