import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { DecisionCardView, DecisionListResponse } from '@aoc/contracts';
import { useResource } from '../../api/useResource';
import { Chip } from '../../components/Chip';
import { Drawer } from '../../components/Dialog';
import { EmptyState, ErrorState, InlineAlert, describeError } from '../../components/EmptyState';
import { KpiStrip, KpiTile } from '../../components/KpiStrip';
import { FilterBar } from '../../components/Layout';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';
import { useNow } from '../../lib/clock';
import { useMediaQuery } from '../../lib/dom';
import { formatAge, formatClock } from '../../lib/format';
import { usePasskeys, useDecisionActions } from './actions';
import { DecisionDetail } from './DecisionDetail';
import { useDirectory } from './directory';
import {
  applyFilters,
  countByKind,
  filtersToParams,
  hasNarrowing,
  parseFilters,
  type DecisionFilters,
} from './filters';
import { isDecisionEvent } from './inbox';
import { KIND_LABEL, agingOf, medianDecisionMs, sortByUrgency } from './model';
import { QueueSection } from './Queue';
import { ResolvedView } from './ResolvedView';
import './decisions.css';

const OPEN_QUERY = { status: 'open', limit: 500 };
const CLOSED_QUERY = { status: 'resolved,withdrawn,expired', limit: 500 };

/** Static placeholder blocks that hold the layout while the first load is in flight (no shimmer, §12). */
function QueueSkeleton() {
  return (
    <div className="dec-skeleton" aria-busy="true">
      <p className="aoc-sr-only" role="status">
        Loading decisions…
      </p>
      <div className="dec-skeleton__kpis" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className="dec-skeleton__block dec-skeleton__block--kpi" />
        ))}
      </div>
      <div className="dec-layout" aria-hidden="true">
        <div className="dec-skeleton__list">
          {[0, 1, 2].map((i) => (
            <span key={i} className="dec-skeleton__block dec-skeleton__block--card" />
          ))}
        </div>
        <span className="dec-skeleton__block dec-skeleton__block--detail" />
      </div>
    </div>
  );
}

/**
 * Decisions inbox (§2.3, §6, §8, §10, §11, R15): one queue of open human-required decisions, most urgent first
 * against the CEO-approved SLAs, split into what the signed-in user can resolve and what waits on someone else
 * (with the reason). Detail beside the queue (a drawer on phones), resolution by button or by passkey, and a
 * Resolved tab with time to decide. Refreshes on every `decision.*` event; `?focus=<id>` selects a card.
 */
export default function DecisionsPage() {
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  const now = useNow();
  const wide = useMediaQuery('(min-width: 1024px)');

  const open = useResource<DecisionListResponse>('/api/decisions', {
    query: OPEN_QUERY,
    refreshOn: isDecisionEvent,
  });
  const closed = useResource<DecisionListResponse>('/api/decisions', {
    query: CLOSED_QUERY,
    refreshOn: isDecisionEvent,
  });
  const directory = useDirectory();
  const needPasskeys = open.data?.decisions.some((d) => d.requiresPasskey && d.viewer.canResolve) ?? false;
  const passkeys = usePasskeys(needPasskeys);

  const reloadOpen = open.reload;
  const reloadClosed = closed.reload;
  const onChanged = useCallback(() => {
    reloadOpen();
    reloadClosed();
  }, [reloadOpen, reloadClosed]);
  const actions = useDecisionActions(onChanged, passkeys);

  const update = useCallback(
    (patch: Partial<DecisionFilters>, replace = true) =>
      setParams(filtersToParams({ ...filters, ...patch }), { replace }),
    [filters, setParams],
  );

  const openCards = open.data?.decisions ?? [];
  const closedCards = closed.data?.decisions ?? [];
  const visibleOpen = useMemo(
    () => sortByUrgency(applyFilters(openCards, filters, now), now),
    [openCards, filters, now],
  );
  const mine = visibleOpen.filter((c) => c.viewer.canResolve);
  const others = visibleOpen.filter((c) => !c.viewer.canResolve);
  const visibleClosed = useMemo(
    () => applyFilters(closedCards, { ...filters, aging: null, mine: false }, now),
    [closedCards, filters, now],
  );

  const allMine = openCards.filter((c) => c.viewer.canResolve);
  const overCount = openCards.filter((c) => agingOf(c, now).state === 'over').length;
  const passkeyCount = openCards.filter((c) => c.requiresPasskey).length;
  const oldestMine = allMine.reduce<string | null>(
    (min, c) => (min === null || c.createdAt < min ? c.createdAt : min),
    null,
  );
  const median = medianDecisionMs(closedCards);
  const resolvedCount = closedCards.filter((c) => c.status === 'resolved').length;

  // Selection: an explicit ?focus, else (wide screens) the most urgent card the viewer can act on.
  const byId = useMemo(() => {
    const m = new Map<string, DecisionCardView>();
    for (const c of closedCards) m.set(c.id, c);
    for (const c of openCards) m.set(c.id, c);
    return m;
  }, [openCards, closedCards]);
  const focused = filters.focus ? (byId.get(filters.focus) ?? null) : null;
  const fallback = filters.tab === 'open' && wide ? (mine[0] ?? others[0] ?? null) : null;
  const selected = focused ?? (filters.focus ? null : fallback);
  const focusMissing = Boolean(filters.focus && open.data && closed.data && !focused);

  const select = useCallback((id: string) => update({ focus: id }), [update]);
  const clearSelection = useCallback(() => update({ focus: null }), [update]);

  // Bring a deep-linked card into view once the list has loaded.
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!focused || scrolledFor.current === focused.id) return;
    scrolledFor.current = focused.id;
    document.getElementById(`dec-q-${focused.id}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [focused]);

  const snapshot = open.data?.generatedAt;
  const loadingFirst = open.data === undefined && !open.error;
  const tabs = [
    { id: 'open', label: 'Open', count: openCards.length },
    { id: 'resolved', label: 'Resolved', count: closedCards.length },
  ];

  const kindChips = countByKind(filters.tab === 'open' ? openCards : closedCards);
  const filterBar = (
    <FilterBar
      label="Decision filters"
      end={
        hasNarrowing(filters) ? (
          <button
            type="button"
            className="aoc-link-button"
            onClick={() => update({ kinds: new Set(), aging: null, passkey: false, mine: false })}
          >
            Clear filters
          </button>
        ) : undefined
      }
    >
      {kindChips.map(([kind, n]) => (
        <Chip
          key={kind}
          selected={filters.kinds.has(kind)}
          onToggle={(on) => {
            const next = new Set(filters.kinds);
            if (on) next.add(kind);
            else next.delete(kind);
            update({ kinds: next });
          }}
        >
          {KIND_LABEL[kind]} <span className="aoc-num">{n}</span>
        </Chip>
      ))}
      {filters.tab === 'open' && filters.aging && (
        <Chip tone="warn" onRemove={() => update({ aging: null })} removeLabel="Remove the SLA filter">
          {filters.aging === 'over' ? 'Over SLA' : 'Due soon'}
        </Chip>
      )}
      {filters.passkey && (
        <Chip onRemove={() => update({ passkey: false })} removeLabel="Remove the passkey filter">
          Passkey-gated
        </Chip>
      )}
      {filters.tab === 'open' && filters.mine && (
        <Chip
          tone="accent"
          onRemove={() => update({ mine: false })}
          removeLabel="Show decisions waiting on others too"
        >
          Waiting on you
        </Chip>
      )}
    </FilterBar>
  );

  const detail = selected ? (
    <DecisionDetail card={selected} directory={directory} actions={actions} passkeys={passkeys} />
  ) : null;

  let openView;
  if (open.data === undefined) {
    openView = open.error ? (
      <ErrorState title="Couldn't load decisions" error={open.error} onRetry={open.reload} />
    ) : (
      <QueueSkeleton />
    );
  } else if (!openCards.length) {
    openView = (
      <EmptyState
        icon="decisions"
        title="No open decisions"
        body="Decisions appear here when an agent hits a decision test, a gate is reached (fix plan, go-live, rollback, break-glass) or someone asks for a credit top-up or a lesson binding."
      />
    );
  } else {
    const queueProps = {
      now,
      onSelect: select,
      selectedId: selected?.id ?? null,
      directory,
      actions,
      passkeys,
    };
    openView = (
      <div className="dec-layout">
        <div className="dec-layout__queue" aria-busy={open.loading || undefined}>
          {open.error !== undefined && (
            <InlineAlert tone="warn" title="Showing the last loaded decisions">
              {describeError(open.error) ?? 'The latest refresh failed.'}
            </InlineAlert>
          )}
          <p className="dec-snapshot">
            Most urgent first · SLA bars as of {snapshot ? formatClock(snapshot) : '—'}, redrawn on each
            decision event
          </p>
          <QueueSection
            id="dec-mine"
            title="Waiting on you"
            hint="You can resolve these now."
            cards={mine}
            empty={
              hasNarrowing(filters)
                ? 'Nothing waiting on you matches these filters.'
                : 'Nothing is waiting on you. Decisions you can resolve will appear here.'
            }
            {...queueProps}
          />
          {!filters.mine && (
            <QueueSection
              id="dec-others"
              title="Waiting on others"
              hint="Read-only for you: each card says who it is routed to and why."
              cards={others}
              empty="No other open decisions match."
              {...queueProps}
            />
          )}
        </div>
        {wide && (
          <aside className="dec-layout__detail" aria-label="Selected decision">
            {detail ?? (
              <EmptyState
                size="sm"
                icon="decisions"
                title={focusMissing ? 'Decision not found' : 'Select a decision'}
                body={
                  focusMissing
                    ? `No decision with id ${filters.focus} is visible to you.`
                    : 'Its question, context, options and history appear here.'
                }
              />
            )}
          </aside>
        )}
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Decisions"
        subtitle="Human-required decisions, most urgent first against their SLA. Approve applies the recommended option."
      />
      <p className="aoc-sr-only" aria-live="polite">
        {open.data ? `${allMine.length} decisions waiting on you, ${overCount} over SLA.` : ''}
      </p>
      {loadingFirst ? null : (
        <KpiStrip label="Decisions at a glance">
          <KpiTile
            label="Waiting on you"
            value={allMine.length}
            href="/decisions?scope=mine"
            tone={
              allMine.some((c) => agingOf(c, now).state === 'over')
                ? 'danger'
                : allMine.length
                  ? 'warn'
                  : 'neutral'
            }
            footnote={
              oldestMine ? `oldest waiting ${formatAge(now - Date.parse(oldestMine))}` : 'nothing waiting'
            }
          />
          <KpiTile
            label="Over SLA"
            value={overCount}
            href="/decisions?aging=over"
            tone={overCount ? 'danger' : 'neutral'}
            footnote={`of ${openCards.length} open`}
            info="SLAs approved by the CEO: rollback 30m, agent decision 1h (protected operations too), credit top-up 1h, go-live 2h, fix plan 4h, lesson binding 2 days."
          />
          <KpiTile
            label="Need a passkey"
            value={passkeyCount}
            href="/decisions?passkey=1"
            footnote="go-live · rollback · break-glass"
          />
          <KpiTile
            label="Median time to decide"
            value={median === null ? '—' : formatAge(median)}
            href="/decisions?tab=resolved"
            footnote={`${resolvedCount} resolved`}
          />
        </KpiStrip>
      )}
      {focusMissing && !wide && (
        <InlineAlert tone="warn" title="Decision not found">
          No decision with id {filters.focus} is visible to you.
        </InlineAlert>
      )}
      <Tabs
        label="Decision views"
        items={tabs}
        value={filters.tab}
        onChange={(id) =>
          update(
            { tab: id === 'resolved' ? 'resolved' : 'open', focus: null, aging: null, mine: false },
            false,
          )
        }
        className="dec-tabs"
      />
      {filterBar}
      {filters.tab === 'open' ? (
        openView
      ) : closed.data === undefined ? (
        closed.error ? (
          <ErrorState title="Couldn't load closed decisions" error={closed.error} onRetry={closed.reload} />
        ) : (
          <p className="aoc-loading" role="status">
            Loading closed decisions…
          </p>
        )
      ) : (
        <ResolvedView
          cards={visibleClosed}
          directory={directory}
          selectedId={selected?.id ?? null}
          onSelect={select}
          busy={closed.loading}
        />
      )}
      {selected && (!wide || filters.tab === 'resolved') && (
        <Drawer open onClose={clearSelection} title={selected.title} width={560}>
          <DecisionDetail
            card={selected}
            directory={directory}
            actions={actions}
            passkeys={passkeys}
            headingLevel={3}
            hideTitle
          />
        </Drawer>
      )}
    </>
  );
}
