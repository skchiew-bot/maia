import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { PromotionDTO, ProvenanceDTO } from '@aoc/contracts';
import { useResource } from '../../api/useResource';
import {
  Badge,
  CopyableHash,
  DataTable,
  DescriptionList,
  Drawer,
  EmptyState,
  Icon,
  RelativeTime,
  type DataTableColumn,
} from '../../components';
import { formatInteger } from '../../lib/format';
import { actorKindOf, shortId } from '../changes/model';
import { ActorName, PersonName } from '../audit/people';
import { LoadFailed, Skeleton } from '../audit/Skeleton';
import { RefValue } from '../changes/bits';
import { REFUSAL_TEXT, promotionOutcome } from './model';

const VIA_TEXT: Record<NonNullable<ProvenanceDTO['commits'][number]['via']>, string> = {
  change: 'AOC-Change trailer → approved change record',
  session_change: 'session linked to an approved change record',
  session_ticket: 'session on a ticket with an approved fix plan',
};

function Requester({ id }: { id: string }) {
  const kind = actorKindOf(id);
  return kind === 'human' ? <PersonName id={id} /> : <ActorName actor={{ kind, id }} />;
}

/** Every commit in `<default>..<sha>` and how it traces to a gate — the provenance guarantee (§14). */
function ProvenanceDetail({ projectId, sha }: { projectId: string; sha: string }) {
  const res = useResource<ProvenanceDTO>('/api/provenance', { query: { projectId, sha } });
  if (!res.data) {
    if (res.error) return <LoadFailed what="the provenance check" error={res.error} onRetry={res.reload} />;
    return <Skeleton label="Tracing commits" blocks={[96]} />;
  }
  const p = res.data;
  return (
    <div className="rollbacks-prov">
      <p className={p.ok ? 'rollbacks-prov__ok' : 'rollbacks-prov__bad'}>
        <Icon name={p.ok ? 'ok' : 'danger'} size={14} />
        {p.ok
          ? `All ${formatInteger(p.commits.length)} commits trace to a gate`
          : `${formatInteger(p.orphanShas.length)} of ${formatInteger(p.commits.length)} commits trace to no gate`}
        {p.baseRef && <span className="rollbacks-muted"> · checked against {p.baseRef}</span>}
      </p>
      {p.commits.length === 0 && p.reasons.length > 0 && (
        <ul className="rollbacks-prov__reasons">
          {p.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      <ol className="rollbacks-prov__commits">
        {p.commits.map((c) => (
          <li key={c.sha} className={c.traced ? 'is-traced' : 'is-orphan'}>
            <Icon name={c.traced ? 'check' : 'danger'} size={12} />
            <CopyableHash value={c.sha} label="commit" />
            <span className="rollbacks-prov__subject">{c.subject}</span>
            <span className="rollbacks-prov__via">
              {c.traced && c.via ? VIA_TEXT[c.via] : (c.reason ?? 'no trace')}
              {c.changeIds.map((id) => (
                <span key={id}>
                  {' '}
                  · <Link to={`/changes/${encodeURIComponent(id)}`}>{shortId(id)}</Link>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function PromotionsTable({
  promotions,
  projectName,
}: {
  promotions: readonly PromotionDTO[];
  projectName: (id: string) => string;
}) {
  const [open, setOpen] = useState<PromotionDTO | null>(null);
  const columns = useMemo<DataTableColumn<PromotionDTO>[]>(
    () => [
      {
        id: 'from',
        header: 'Promotion',
        primary: true,
        cell: (p) => (
          <span className="rollbacks-promo">
            <span>
              {projectName(p.projectId)}
              {p.breakglass && (
                <Badge tone="danger" variant="outline" icon="warn">
                  break-glass
                </Badge>
              )}
            </span>
            <RefValue refName={p.fromRef} sha={p.fromSha} label="promoted" />
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Outcome',
        sortValue: (p) => p.status,
        cell: (p) => {
          const o = promotionOutcome(p);
          return (
            <span className="rollbacks-outcome">
              <Badge tone={o.tone} icon={o.icon}>
                {o.label}
              </Badge>
              <span className="rollbacks-outcome__detail">{o.detail}</span>
            </span>
          );
        },
      },
      {
        id: 'by',
        header: 'Requested by',
        cell: (p) => <Requester id={p.requestedBy} />,
      },
      {
        id: 'when',
        header: 'When',
        numeric: true,
        sortValue: (p) => p.requestedAt,
        cell: (p) => <RelativeTime value={p.requestedAt} suffix=" ago" />,
      },
    ],
    [projectName],
  );
  return (
    <>
      <DataTable
        caption="Promotions to main"
        columns={columns}
        rows={promotions}
        rowKey={(p) => p.promotionId}
        onRowClick={setOpen}
        rowLabel={(p) => `Promotion ${shortId(p.promotionId)}: open the provenance check`}
        activeRowKey={open?.promotionId}
        rowTone={(p) => (p.status === 'refused' || p.status === 'failed' ? 'danger' : undefined)}
        empty={
          <EmptyState
            size="sm"
            icon="changes"
            title="No promotions yet"
            body="Go-live requests and break-glass promotions appear here with their provenance check."
          />
        }
      />
      <Drawer
        open={open !== null}
        onClose={() => setOpen(null)}
        width={560}
        title={open ? `Promotion ${shortId(open.promotionId)}` : ''}
        description={open ? `${projectName(open.projectId)} · ${promotionOutcome(open).label}` : undefined}
      >
        {open && (
          <div className="rollbacks-drawer">
            <DescriptionList
              columns={2}
              items={[
                {
                  term: 'From',
                  value: <RefValue refName={open.fromRef} sha={open.fromSha} label="promoted" />,
                },
                { term: 'To', value: open.targetBranch ?? '—' },
                { term: 'Requested by', value: <Requester id={open.requestedBy} /> },
                { term: 'Requested', value: <RelativeTime value={open.requestedAt} suffix=" ago" /> },
                {
                  term: 'Gate',
                  value: open.decisionId ? (
                    <Link to={`/decisions?focus=${encodeURIComponent(open.decisionId)}`}>
                      go-live decision
                    </Link>
                  ) : open.breakglass ? (
                    'break-glass decision (provenance waived)'
                  ) : (
                    'none raised'
                  ),
                },
                {
                  term: 'Change record',
                  value: open.changeId ? (
                    <Link to={`/changes/${encodeURIComponent(open.changeId)}`}>{shortId(open.changeId)}</Link>
                  ) : (
                    '—'
                  ),
                },
                ...(open.refusal
                  ? [{ term: 'Refused because', value: REFUSAL_TEXT[open.refusal.reason] }]
                  : []),
                ...(open.failure
                  ? [
                      {
                        term: 'Not executed',
                        value: `${open.failure.reason}${open.failure.detail ? `: ${open.failure.detail}` : ''}`,
                      },
                    ]
                  : []),
                ...(open.completion
                  ? [
                      {
                        term: 'Main moved',
                        value: (
                          <span className="rollbacks-exec">
                            <CopyableHash value={open.completion.mainShaBefore} label="main before" />
                            <Icon name="chevron-right" size={12} />
                            <CopyableHash value={open.completion.mainShaAfter} label="main after" />
                          </span>
                        ),
                      },
                    ]
                  : []),
              ]}
            />
            <h3 className="rollbacks-drawer__title">Provenance check</h3>
            {open.breakglass ? (
              <p>
                Break-glass is the sole exception: provenance was not required, and that is recorded in the
                chain.
              </p>
            ) : open.fromSha ? (
              <ProvenanceDetail projectId={open.projectId} sha={open.fromSha} />
            ) : (
              <p className="rollbacks-muted">No commit was resolved for this promotion.</p>
            )}
            {open.refusal && open.refusal.orphanShas.length > 0 && (
              <>
                <h3 className="rollbacks-drawer__title">Orphan commits recorded at refusal</h3>
                <ul className="rollbacks-orphans">
                  {open.refusal.orphanShas.map((s) => (
                    <li key={s}>
                      <CopyableHash value={s} label="orphan commit" />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </Drawer>
    </>
  );
}
