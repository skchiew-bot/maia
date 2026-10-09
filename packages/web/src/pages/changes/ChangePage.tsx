import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AuditEventPageDTO, ChangeRequestDTO, PinListDTO } from '@aoc/contracts';
import { ApiError } from '../../api/client';
import { useAuth } from '../../api/auth';
import type { StreamMessage } from '../../api/stream';
import { useResource } from '../../api/useResource';
import {
  Badge,
  ButtonLink,
  Chip,
  CopyableHash,
  EmptyState,
  InlineAlert,
  PageHeader,
  RelativeTime,
  Widget,
  WidgetGrid,
} from '../../components';
import { useNow } from '../../lib/clock';
import { formatAge, toEpoch } from '../../lib/format';
import { EventTable } from '../audit/EventTable';
import { PeopleProvider, PersonName, usePeople } from '../audit/people';
import { LoadFailed, Skeleton } from '../audit/Skeleton';
import { RefValue } from './bits';
import { DecisionSummary, SubmitBar, WorkActions } from './ChangeActions';
import { FieldCard } from './FieldCard';
import { LifecycleSteps, LifecycleStrip } from './Lifecycle';
import { FIELD_ORDER, SCOPE_META, STATUS_META, blockedBySoleApprover, canActOn, shortId } from './model';
import { useProjects } from './projects';
import './changes.css';

const isPinEvent = (m: StreamMessage) =>
  m.kind === 'aoc' &&
  ['git.ref_pinned', 'phase.completed', 'change.submitted', 'change.completed'].includes(m.event.type);

function ChangeRecord({ id }: { id: string }) {
  const { user } = useAuth();
  const now = useNow();
  const projects = useProjects();
  const { approvers } = usePeople();
  const isThis = (m: StreamMessage) =>
    m.kind === 'aoc' &&
    (m.event.meta.changeId === id ||
      m.event.scope.changeId === id ||
      m.event.meta.postIncidentChangeId === id ||
      m.event.type.startsWith('breakglass.'));
  const res = useResource<ChangeRequestDTO>(`/api/changes/${encodeURIComponent(id)}`, { refreshOn: isThis });
  // An action's response is newer than the last fetch until the stream-driven refetch lands.
  const [fresh, setFresh] = useState<ChangeRequestDTO | null>(null);
  useEffect(() => setFresh(null), [res.data]);
  const change = fresh ?? res.data;

  const canAct = !!change && canActOn(change, user);
  const editable = !!change && change.status === 'draft' && canAct;
  const pins = useResource<PinListDTO>(change && editable ? '/api/pins' : null, {
    query: { projectId: change?.projectId, limit: 100 },
    refreshOn: isPinEvent,
  });
  const trail = useResource<AuditEventPageDTO>(change ? '/api/audit/events' : null, {
    query: { projectId: change?.projectId, typePrefix: 'change.', limit: 1000, order: 'desc' },
    refreshOn: isThis,
  });
  const events = useMemo(
    () => (trail.data?.events ?? []).filter((e) => e.scope.changeId === id || e.meta.changeId === id),
    [trail.data, id],
  );

  if (!change) {
    if (res.error instanceof ApiError && res.error.status === 404)
      return (
        <>
          <PageHeader
            title="Change request not found"
            breadcrumbs={[{ label: 'Changes', to: '/changes' }, { label: shortId(id) }]}
          />
          <EmptyState
            icon="changes"
            title="No change request has this id"
            body="It may have been mistyped. Every change request ever drafted is listed on the Changes page."
            action={<ButtonLink to="/changes">All change requests</ButtonLink>}
          />
        </>
      );
    return (
      <>
        <PageHeader
          title="Change request"
          breadcrumbs={[{ label: 'Changes', to: '/changes' }, { label: shortId(id) }]}
        />
        {res.error ? (
          <LoadFailed what="this change request" error={res.error} onRetry={res.reload} />
        ) : (
          <Skeleton label="Loading the change request" blocks={[180, 420]} />
        )}
      </>
    );
  }

  const status = STATUS_META[change.status];
  const scope = SCOPE_META[change.scope];
  const sod =
    change.status === 'submitted' &&
    !change.selfApprovable &&
    blockedBySoleApprover(change.submittedBy, approvers);
  const postIncidentOpen = !!change.breakglassId && change.status !== 'completed' && !!change.dueAt;

  return (
    <>
      <PageHeader
        title={change.erased ? '[erased]' : (change.title ?? 'Change request')}
        breadcrumbs={[{ label: 'Changes', to: '/changes' }, { label: shortId(change.changeId) }]}
        subtitle={
          <>
            {projects.nameOf(change.projectId)} · {scope.label} ·{' '}
            {scope.gate === 'self' ? 'self-approved by a Builder' : 'the Approver decides'}
          </>
        }
        meta={
          <>
            <Badge tone={status.tone} icon={status.icon}>
              {status.label}
            </Badge>
            {change.approval?.selfApproved && <Chip>self-approved, full record</Chip>}
            {change.breakglassId && <Chip icon="warn">post-incident record</Chip>}
            <span>
              developer <PersonName id={change.ownerId ?? change.createdBy} />
            </span>
            <span>
              drafted <RelativeTime value={change.createdAt} suffix=" ago" />
            </span>
            <CopyableHash value={change.changeId} length={30} label="change id" />
          </>
        }
      />

      {postIncidentOpen && (
        <InlineAlert
          tone={change.overdue ? 'danger' : 'warn'}
          title={
            change.overdue
              ? `Post-incident record overdue by ${formatAge(now - toEpoch(change.dueAt!))}`
              : `Post-incident record due in ${formatAge(toEpoch(change.dueAt!) - now)}`
          }
          action={
            <ButtonLink to="/rollbacks#breakglass" size="sm">
              Break-glass
            </ButtonLink>
          }
        >
          Break-glass promotions must be followed by a completed change record within 24 hours (§8). It stays
          an open audit finding until it is completed.
        </InlineAlert>
      )}
      {sod && (
        <InlineAlert tone="warn" title="Waiting for a second Approver">
          The only active Approver raised this request and cannot approve it (separation of duties). It stays
          open until another Approver exists.
        </InlineAlert>
      )}
      {change.erased && (
        <InlineAlert tone="info" title="Free text erased">
          This record's text was crypto-shredded. The ids, statuses and hashes in the chain remain valid.
        </InlineAlert>
      )}

      <WidgetGrid>
        <Widget
          span={8}
          title="Lifecycle"
          subtitle="where this record's time went, and who did each step"
          info="Every step is an event in the hash-chained log under the person who took it (§6). Self-approval of reversible off-main work still produces this full record (§8)."
        >
          <LifecycleStrip change={change} now={now} />
          <LifecycleSteps change={change} />
        </Widget>
        <Widget span={4} title="Gate and rollback point">
          <div className="changes-side">
            <section aria-label="Decision">
              <h3 className="changes-side__title">Decision</h3>
              {change.decisionId ? (
                <DecisionSummary decisionId={change.decisionId} />
              ) : change.approval?.selfApproved ? (
                <p>
                  Self-approved by <PersonName id={change.approval.approverId} />. No Approver decision is
                  needed for reversible off-main work.
                </p>
              ) : (
                <p className="changes-muted">
                  {change.status === 'draft' ? 'Raised when the record is submitted.' : 'No decision card.'}
                </p>
              )}
            </section>
            <section aria-label="Rollback point">
              <h3 className="changes-side__title">
                {change.pinnedTag || change.pinnedSha ? 'Pinned state' : 'Returns to'}
              </h3>
              {change.pinnedTag || change.pinnedSha ? (
                <>
                  <RefValue refName={change.pinnedTag} sha={change.pinnedSha} label="pinned" />
                  <p className="changes-muted">
                    Immutable: completing the record pinned it. It is a rollback target.
                  </p>
                  <ButtonLink
                    size="sm"
                    icon="rollbacks"
                    to={`/rollbacks?project=${encodeURIComponent(change.projectId)}&target=${encodeURIComponent(
                      change.pinnedTag ?? change.pinnedSha ?? '',
                    )}&change=${encodeURIComponent(change.changeId)}`}
                  >
                    Roll back to this state…
                  </ButtonLink>
                </>
              ) : change.rollbackRef ? (
                <>
                  <RefValue refName={change.rollbackRef} sha={change.rollbackSha} label="rollback target" />
                  <p className="changes-muted">
                    The exact state the rollback plan returns to
                    {change.rollbackSha ? ', resolved at submission' : ''}.
                  </p>
                </>
              ) : (
                <p className="changes-muted">Named in the rollback plan before submission.</p>
              )}
            </section>
            {change.breakglassId && (
              <section aria-label="Break-glass">
                <h3 className="changes-side__title">Break-glass</h3>
                <p>
                  Raised by break-glass <code>{shortId(change.breakglassId)}</code>.{' '}
                  <Link to="/rollbacks#breakglass">See the emergency promotion</Link>
                </p>
              </section>
            )}
          </div>
        </Widget>

        <Widget
          span={12}
          title="The four required fields"
          subtitle={
            editable
              ? 'edit or affirm each one; blind one-click confirms are flagged (§14)'
              : 'who wrote each field and who affirmed it'
          }
          info="Impact analysis, mitigation plan, rollback plan naming the exact commit or tag, and acceptance test (§8). AI may draft them; the developer must edit or affirm every field."
        >
          <div className="changes-fields">
            {FIELD_ORDER.map((f) => {
              const field = change.fields.find((x) => x.field === f);
              return field ? (
                <FieldCard
                  key={f}
                  change={change}
                  field={field}
                  editable={editable}
                  pins={pins.data}
                  onSaved={setFresh}
                />
              ) : null;
            })}
          </div>
          {change.status === 'draft' && user && (
            <SubmitBar change={change} viewer={user} canAct={canAct} onSaved={setFresh} />
          )}
        </Widget>

        {(change.status === 'approved' || change.status === 'in_progress') && user && (
          <Widget span={12} title="Do the work" subtitle="link the managed session, then complete and pin">
            <WorkActions change={change} viewer={user} canAct={canAct} onSaved={setFresh} />
          </Widget>
        )}

        <Widget
          span={12}
          flush
          className="gov-flush"
          title="Audit trail"
          subtitle="this record's events in the hash-chained log"
          actions={
            <ButtonLink
              to={`/audit?prefix=change.&project=${encodeURIComponent(change.projectId)}`}
              size="sm"
              variant="ghost"
            >
              Open in Audit
            </ButtonLink>
          }
        >
          {trail.data ? (
            <EventTable
              caption="Audit events for this change request"
              events={events}
              empty={<EmptyState size="sm" title="No events found for this record" />}
            />
          ) : trail.error ? (
            <LoadFailed what="the audit trail" error={trail.error} onRetry={trail.reload} />
          ) : (
            <Skeleton label="Loading the audit trail" blocks={[120]} />
          )}
        </Widget>
      </WidgetGrid>
    </>
  );
}

export default function ChangePage() {
  const { id = '' } = useParams();
  return (
    <PeopleProvider>
      <ChangeRecord id={id} />
    </PeopleProvider>
  );
}
