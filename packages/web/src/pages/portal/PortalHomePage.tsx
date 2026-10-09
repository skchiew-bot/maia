import type { PublicTicket } from '@aoc/contracts';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../api/auth';
import { useResource } from '../../api/useResource';
import { Button, ButtonLink, EmptyState, Icon, PageHeader } from '../../components';
import { useClock } from '../../lib/clock';
import { cx } from '../../lib/dom';
import { formatTime } from './dates';
import { canUsePortal, useRefreshOnReturn } from './hooks';
import {
  countByStatus,
  GROUP_TITLE,
  groupTickets,
  portalErrorMessage,
  STATUS_META,
  viewOf,
  type PortalStatus,
} from './model';
import { BuilderNotice, CardSkeleton } from './notices';
import { TicketCard } from './TicketCard';
import './portal.css';

type Filter = PortalStatus | 'all';
const FILTER_ORDER: readonly PortalStatus[] = [
  'ready_for_testing',
  'received',
  'being_worked_on',
  'completed',
  'closed',
];

/** The requester's home: what needs them first, then every request with its abstracted status (§7). */
export default function PortalHomePage() {
  const { user } = useAuth();
  const allowed = canUsePortal(user);
  const tickets = useResource<PublicTicket[]>('/portal/api/tickets', { enabled: allowed });
  useRefreshOnReturn(tickets.reload, allowed);
  const clock = useClock();
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    if (tickets.data) setCheckedAt(clock.now());
  }, [tickets.data, clock]);

  const newRequest = (
    <ButtonLink to="/portal/new" variant="primary" icon="plus" className="portal-cta">
      New request
    </ButtonLink>
  );

  return (
    <div className="portal-page">
      <PageHeader
        title="My requests"
        subtitle="Everything you have reported, and where each one stands."
        actions={allowed ? newRequest : undefined}
      />
      {!allowed && user ? (
        <BuilderNotice user={user} />
      ) : tickets.data === undefined ? (
        tickets.error ? (
          <LoadError error={tickets.error} onRetry={tickets.reload} />
        ) : (
          <CardSkeleton label="Loading your requests…" />
        )
      ) : tickets.data.length === 0 ? (
        <EmptyState
          icon="inbox"
          title="You haven't reported anything yet"
          body="When something isn't working, tell us here. You can follow your request on this page and test the fix when it's ready."
          action={
            <ButtonLink to="/portal/new" variant="primary" icon="plus" className="portal-cta">
              Report a problem
            </ButtonLink>
          }
        />
      ) : (
        <RequestList
          tickets={tickets.data}
          filter={filter}
          onFilter={setFilter}
          refreshing={tickets.loading}
          checkedAt={checkedAt}
          onRefresh={tickets.reload}
          staleError={tickets.error}
        />
      )}
    </div>
  );
}

function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="portal-card portal-error" role="alert">
      <p className="portal-error__title">
        <Icon name="danger" size={16} />
        We couldn&apos;t load your requests
      </p>
      <p>{portalErrorMessage(error)}</p>
      <Button icon="retry" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

interface RequestListProps {
  tickets: PublicTicket[];
  filter: Filter;
  onFilter: (f: Filter) => void;
  refreshing: boolean;
  checkedAt: number | null;
  onRefresh: () => void;
  staleError: unknown;
}

function RequestList({
  tickets,
  filter,
  onFilter,
  refreshing,
  checkedAt,
  onRefresh,
  staleError,
}: RequestListProps) {
  const counts = useMemo(() => countByStatus(tickets), [tickets]);
  const groups = useMemo(() => groupTickets(tickets), [tickets]);
  const waiting = groups.find((g) => g.group === 'needs_you')?.tickets ?? [];
  const active: Filter = filter !== 'all' && counts[filter] === 0 ? 'all' : filter;
  const filtered =
    active === 'all'
      ? []
      : tickets
          .filter((t) => viewOf(t).status === active)
          .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  return (
    <>
      {waiting.length > 0 && <NeedsYou tickets={waiting} />}
      <div className="portal-toolbar">
        <div className="portal-filters" role="group" aria-label="Show requests by status">
          <FilterChip
            label="All"
            count={tickets.length}
            pressed={active === 'all'}
            onClick={() => onFilter('all')}
          />
          {FILTER_ORDER.filter((s) => counts[s] > 0).map((s) => (
            <FilterChip
              key={s}
              label={STATUS_META[s].word}
              count={counts[s]}
              pressed={active === s}
              onClick={() => onFilter(s)}
            />
          ))}
        </div>
        <p className="portal-checked" aria-live="polite">
          {staleError ? (
            <span className="portal-checked__warn">Couldn&apos;t refresh. Showing what we last loaded.</span>
          ) : refreshing ? (
            'Checking for updates…'
          ) : checkedAt !== null ? (
            <>Up to date as of {formatTime(checkedAt)}</>
          ) : null}
          <button type="button" className="aoc-link-button" onClick={onRefresh} disabled={refreshing}>
            Refresh
          </button>
        </p>
      </div>
      {active === 'all' ? (
        groups.map((g) => (
          <section key={g.group} className="portal-group" aria-labelledby={`group-${g.group}`}>
            <h2 id={`group-${g.group}`} className="portal-group__title">
              {GROUP_TITLE[g.group]} <span className="portal-group__count aoc-num">{g.tickets.length}</span>
            </h2>
            <ul className="portal-list">
              {g.tickets.map((t) => (
                <TicketCard key={t.ticketId} ticket={t} />
              ))}
            </ul>
          </section>
        ))
      ) : (
        <section className="portal-group" aria-labelledby="group-filtered">
          <h2 id="group-filtered" className="portal-group__title">
            {STATUS_META[active].word} <span className="portal-group__count aoc-num">{filtered.length}</span>
          </h2>
          <ul className="portal-list">
            {filtered.map((t) => (
              <TicketCard key={t.ticketId} ticket={t} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function FilterChip({
  label,
  count,
  pressed,
  onClick,
}: {
  label: string;
  count: number;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cx('portal-chip', pressed && 'is-pressed')}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <span>{label}</span>
      <span className="portal-chip__count aoc-num">{count}</span>
    </button>
  );
}

/** The one thing a requester may need to do: test a fix. */
function NeedsYou({ tickets }: { tickets: PublicTicket[] }) {
  const n = tickets.length;
  return (
    <section className="portal-callout" aria-labelledby="needs-you-title">
      <div className="portal-callout__icon" aria-hidden="true">
        <Icon name="waiting" size={20} />
      </div>
      <div className="portal-callout__body">
        <h2 id="needs-you-title" className="portal-callout__title">
          {n === 1 ? 'A fix is ready for your testing' : `${n} fixes are ready for your testing`}
        </h2>
        <p className="portal-callout__text">Try it on the test environment, then tell us whether it works.</p>
        <ul className="portal-callout__list">
          {tickets.map((t) => (
            <li key={t.ticketId}>
              <Link to={`/portal/tickets/${encodeURIComponent(t.ticketId)}`} className="portal-callout__link">
                <span className="portal-callout__name">{t.title}</span>
                <span className="portal-callout__go">
                  Test it now
                  <Icon name="chevron-right" size={14} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
