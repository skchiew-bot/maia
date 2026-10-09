import type { AuditEventDetailDTO } from '@aoc/contracts';
import { useResource } from '../../api/useResource';
import {
  Badge,
  Button,
  CopyableHash,
  DescriptionList,
  Drawer,
  Icon,
  InlineAlert,
  RelativeTime,
} from '../../components';
import { formatDateTime, formatInteger } from '../../lib/format';
import { LoadFailed, Skeleton } from './Skeleton';
import { ActorName } from './people';

const WITHHELD: Record<NonNullable<AuditEventDetailDTO['payloadWithheldReason']>, string> = {
  not_approver: 'Bodies are shown to Approvers only. Builders see every header, hash and id.',
  ticket_media: 'This is intake data behind the role boundary: it needs the ticket media permission.',
};

/** The body of an event, as far as the viewer may see it, and whether it still matches its chained hash. */
function Body({ e }: { e: AuditEventDetailDTO }) {
  switch (e.body) {
    case 'none':
      return <p className="audit-muted">Header-only event: nothing was written to the body store.</p>;
    case 'erased':
      return (
        <p className="audit-body-state is-erased">
          <Icon name="minus" size={14} /> [erased] — the body was crypto-shredded. Its blinded hash stays in
          the chain, so the chain still verifies.
        </p>
      );
    case 'missing':
      return (
        <InlineAlert tone="danger" title="Body missing">
          The chain records a body for this event, but the body store has none and no erasure covers it.
        </InlineAlert>
      );
    case 'present':
      return (
        <div className="audit-body-state">
          <p>
            {e.bodyVerified ? (
              <Badge tone="ok" icon="ok">
                body matches its chained hash
              </Badge>
            ) : (
              <Badge tone="danger" icon="danger">
                body does not match its chained hash
              </Badge>
            )}
          </p>
          {e.payloadVisible ? (
            <pre className="audit-json" aria-label="Event body">
              {JSON.stringify(e.payload, null, 2)}
            </pre>
          ) : (
            <p className="audit-muted">
              <Icon name="eye-off" size={12} />{' '}
              {e.payloadWithheldReason ? WITHHELD[e.payloadWithheldReason] : 'Withheld.'}
            </p>
          )}
        </div>
      );
  }
}

export function EventDrawer({
  seq,
  headSeq,
  onClose,
  onOpenSeq,
}: {
  seq: number | null;
  headSeq: number | null;
  onClose: () => void;
  onOpenSeq: (seq: number) => void;
}) {
  const res = useResource<AuditEventDetailDTO>(seq ? `/api/audit/events/${seq}` : null);
  const e = res.data;
  return (
    <Drawer
      open={seq !== null}
      onClose={onClose}
      width={600}
      title={seq ? `Event #${formatInteger(seq)}` : 'Event'}
      description={e ? <code>{e.type}</code> : undefined}
      footer={
        seq ? (
          <>
            <Button size="sm" icon="chevron-left" disabled={seq <= 1} onClick={() => onOpenSeq(seq - 1)}>
              #{formatInteger(Math.max(1, seq - 1))}
            </Button>
            <Button
              size="sm"
              iconAfter="chevron-right"
              disabled={headSeq !== null && seq >= headSeq}
              onClick={() => onOpenSeq(seq + 1)}
            >
              #{formatInteger(seq + 1)}
            </Button>
          </>
        ) : undefined
      }
    >
      {!e ? (
        res.error ? (
          <LoadFailed what={`event #${seq}`} error={res.error} onRetry={res.reload} />
        ) : (
          <Skeleton label="Loading the event" blocks={[120, 160]} />
        )
      ) : (
        <div className="audit-drawer">
          <DescriptionList
            columns={2}
            items={[
              {
                term: 'Committed',
                value: (
                  <>
                    <span className="aoc-num">{formatDateTime(e.ts)}</span>{' '}
                    <span className="audit-muted">
                      (<RelativeTime value={e.ts} suffix=" ago" />)
                    </span>
                  </>
                ),
              },
              { term: 'Actor', value: <ActorName actor={e.actor} /> },
              { term: 'Source', value: e.source },
              { term: 'Event id', value: <CopyableHash value={e.id} length={30} label="event id" /> },
              ...Object.entries(e.scope)
                .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
                .map(([k, v]) => ({ term: `Scope · ${k}`, value: <code>{v}</code> })),
              ...(e.bodyScope ? [{ term: 'Body key scope', value: <code>{e.bodyScope}</code> }] : []),
              ...(e.causationId
                ? [
                    {
                      term: 'Caused by',
                      value: <CopyableHash value={e.causationId} length={30} label="causing event id" />,
                    },
                  ]
                : []),
              ...(e.sourceTs
                ? [
                    {
                      term: 'Source time',
                      value: <span className="aoc-num">{formatDateTime(e.sourceTs)}</span>,
                    },
                  ]
                : []),
            ]}
          />
          <section aria-label="Chain" className="audit-drawer__section">
            <h3 className="audit-drawer__title">Chain</h3>
            <p className="audit-muted">This event's hash covers its header and the previous event's hash.</p>
            <DescriptionList
              columns={1}
              items={[
                { term: 'Hash', value: <CopyableHash value={e.hash} length={64} label="event hash" /> },
                {
                  term: 'Previous hash',
                  value: <CopyableHash value={e.prevHash} length={64} label="previous hash" />,
                },
                {
                  term: 'Payload hash (blinded, chained)',
                  value: e.payloadHashPrefix ? (
                    <code>{e.payloadHashPrefix}…</code>
                  ) : (
                    <span className="audit-muted">none</span>
                  ),
                },
              ]}
            />
          </section>
          <section aria-label="Metadata" className="audit-drawer__section">
            <h3 className="audit-drawer__title">Metadata (chained in clear: ids, enums, numbers, hashes)</h3>
            <pre className="audit-json">{JSON.stringify(e.meta, null, 2)}</pre>
          </section>
          <section aria-label="Body" className="audit-drawer__section">
            <h3 className="audit-drawer__title">Body (encrypted store)</h3>
            <Body e={e} />
          </section>
        </div>
      )}
    </Drawer>
  );
}
