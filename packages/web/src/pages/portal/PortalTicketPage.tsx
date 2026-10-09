import type { PublicTicket } from '@aoc/contracts';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { useAuth } from '../../api/auth';
import { useResource } from '../../api/useResource';
import {
  Button,
  ButtonLink,
  EmptyState,
  Icon,
  InlineAlert,
  PageHeader,
  RelativeTime,
} from '../../components';
import { formatDayTime } from './dates';
import { AttachmentList } from './files';
import { canUsePortal, useRefreshOnReturn } from './hooks';
import { portalErrorMessage, SEVERITY_META, STATUS_META, TESTED_NOTE, viewOf } from './model';
import { BuilderNotice, CardSkeleton } from './notices';
import { PortalStatusBadge, StatusTracker } from './status';
import { THANKS, UatSignoff, type Verdict } from './UatSignoff';
import './portal.css';

/** One request: its abstracted status, the test request when a fix is ready, and what the requester sent. */
export default function PortalTicketPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const allowed = canUsePortal(user);
  const location = useLocation();
  const navigate = useNavigate();
  const resource = useResource<PublicTicket>(`/portal/api/tickets/${encodeURIComponent(id)}`, {
    enabled: allowed,
  });
  useRefreshOnReturn(resource.reload, allowed);
  const [answered, setAnswered] = useState<PublicTicket | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const justSent = (location.state as { sent?: boolean } | null)?.sent === true;

  // A fresh load supersedes the copy (and the confirmation) an answer left behind.
  useEffect(() => {
    setAnswered(null);
    setVerdict(null);
  }, [resource.data]);

  const ticket = answered ?? resource.data;
  const crumbs = [{ label: 'My requests', to: '/portal' }, { label: ticket?.title ?? 'Request' }];

  if (!allowed && user) {
    return (
      <div className="portal-page">
        <PageHeader title="Request" breadcrumbs={crumbs} />
        <BuilderNotice user={user} />
      </div>
    );
  }

  if (!ticket) {
    const notFound = resource.error instanceof ApiError && resource.error.status === 404;
    return (
      <div className="portal-page">
        <PageHeader title={notFound ? 'Request not found' : 'Request'} breadcrumbs={crumbs} />
        {notFound ? (
          <EmptyState
            icon="inbox"
            title="We couldn't find that request"
            body="The link may be out of date, or the request belongs to someone else."
            action={
              <ButtonLink to="/portal" variant="primary" className="portal-cta">
                Back to my requests
              </ButtonLink>
            }
          />
        ) : resource.error ? (
          <div className="portal-card portal-error" role="alert">
            <p className="portal-error__title">
              <Icon name="danger" size={16} />
              We couldn&apos;t load this request
            </p>
            <p>{portalErrorMessage(resource.error)}</p>
            <Button icon="retry" onClick={resource.reload}>
              Try again
            </Button>
          </div>
        ) : (
          <CardSkeleton count={2} label="Loading your request…" />
        )}
      </div>
    );
  }

  const view = viewOf(ticket);
  // Until the server moves a rejected fix back into work, the answer itself says what happens next.
  const rejectedJustNow = verdict === 'fail' && view.tested;
  const explain = rejectedJustNow
    ? STATUS_META.being_worked_on.explain
    : view.tested
      ? TESTED_NOTE
      : STATUS_META[view.status].explain;
  return (
    <div className="portal-page">
      <PageHeader
        title={ticket.title}
        documentTitle="Your request"
        breadcrumbs={crumbs}
        subtitle={
          <>
            Sent {formatDayTime(ticket.submittedAt)} · Last update{' '}
            <RelativeTime value={ticket.updatedAt} suffix=" ago" />
          </>
        }
      />
      {justSent && (
        <InlineAlert
          tone="ok"
          title="Thanks — we have your request"
          className="portal-sent"
          onDismiss={() => navigate(location.pathname, { replace: true, state: null })}
        >
          You can follow it here. We will ask you to test the fix on this page when it is ready.
        </InlineAlert>
      )}
      <section
        className="portal-card portal-status-card"
        aria-labelledby="status-title"
        data-status={view.status}
      >
        <div className="portal-status-card__head">
          <h2 id="status-title" className="portal-section-title">
            Status
          </h2>
          <PortalStatusBadge status={view.status} />
        </div>
        <StatusTracker status={view.status} />
        <p className="portal-status-card__explain">{explain}</p>
        {verdict && (
          <InlineAlert tone="ok" live className="portal-thanks">
            {THANKS[verdict]}
          </InlineAlert>
        )}
        {resource.error !== undefined && (
          <p className="portal-checked__warn">Couldn&apos;t refresh just now. This is what we last loaded.</p>
        )}
        {view.needsYou && (
          <UatSignoff
            key={ticket.ticketId}
            ticket={ticket}
            canAnswer={user?.role === 'requester'}
            onAnswered={(updated, said) => {
              setVerdict(said);
              setAnswered(updated);
            }}
            onStale={resource.reload}
          />
        )}
      </section>
      <div className="portal-detail">
        <section className="portal-card portal-detail__main" aria-labelledby="request-title">
          <h2 id="request-title" className="portal-section-title">
            What you told us
          </h2>
          <dl className="portal-facts">
            <div>
              <dt>How much it affects you</dt>
              <dd>
                <strong>{SEVERITY_META[ticket.severity].word}</strong> — {SEVERITY_META[ticket.severity].hint}
              </dd>
            </div>
            <div>
              <dt>What happened</dt>
              <dd className="portal-text">{ticket.description}</dd>
            </div>
            {ticket.comment && (
              <div>
                <dt>Anything else</dt>
                <dd className="portal-text">{ticket.comment}</dd>
              </div>
            )}
          </dl>
        </section>
        <section className="portal-card portal-detail__files" aria-labelledby="files-title">
          <h2 id="files-title" className="portal-section-title">
            Your files <span className="portal-group__count aoc-num">{ticket.attachments.length}</span>
          </h2>
          {ticket.attachments.length ? (
            <>
              <AttachmentList attachments={ticket.attachments} />
              <p className="portal-files__privacy">
                Stored encrypted. Only the people working on your request open them, and only when they need
                to.
              </p>
            </>
          ) : (
            <p className="portal-muted">You didn&apos;t attach any files.</p>
          )}
        </section>
      </div>
    </div>
  );
}
