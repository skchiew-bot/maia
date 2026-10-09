import type { PublicTicket } from '@aoc/contracts';
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { RelativeTime } from '../../components/RelativeTime';
import { formatDay } from './dates';
import { SEVERITY_META, TESTED_NOTE, viewOf } from './model';
import { PortalStatusBadge, StatusDots } from './status';

/** One request in the list. The title is the card's only link; the whole card is its click target. */
export function TicketCard({ ticket, headingLevel = 3 }: { ticket: PublicTicket; headingLevel?: 2 | 3 }) {
  const view = viewOf(ticket);
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const files = ticket.attachments.length;
  return (
    <li className="portal-card portal-ticket" data-status={view.status}>
      <div className="portal-ticket__head">
        <Heading className="portal-ticket__title">
          <Link to={`/portal/tickets/${encodeURIComponent(ticket.ticketId)}`} className="portal-ticket__link">
            {ticket.title}
          </Link>
        </Heading>
        <PortalStatusBadge status={view.status} size="sm" />
      </div>
      <p className="portal-ticket__desc">{ticket.description}</p>
      {view.needsYou && (
        <p className="portal-ticket__action">
          <Icon name="waiting" size={14} />
          Please test the fix and tell us if it works
        </p>
      )}
      {view.tested && <p className="portal-ticket__note">{TESTED_NOTE}</p>}
      <div className="portal-ticket__foot">
        <StatusDots status={view.status} />
        <span>Sent {formatDay(ticket.submittedAt)}</span>
        <span>
          Updated <RelativeTime value={ticket.updatedAt} suffix=" ago" />
        </span>
        <span>Impact: {SEVERITY_META[ticket.severity].word}</span>
        {files > 0 && (
          <span>
            {files} file{files === 1 ? '' : 's'}
          </span>
        )}
      </div>
    </li>
  );
}
