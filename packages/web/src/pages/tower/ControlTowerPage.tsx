import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TowerSnapshot } from '@aoc/contracts';
import { ApiError, useAuth } from '../../api';
import {
  ButtonLink,
  EmptyState,
  ErrorState,
  Icon,
  InlineAlert,
  PageHeader,
  describeError,
  formatClock,
  formatDateTime,
} from '../../components';
import { useMediaQuery } from '../../lib/dom';
import { AnomalyRadar } from './AnomalyRadar';
import { AttentionQueue, type AttentionQueueProps } from './AttentionQueue';
import { FleetPanel } from './FleetPanel';
import { FlowPanels } from './FlowPanels';
import { IntegrityPanel } from './IntegrityPanel';
import { KpiBand } from './KpiBand';
import { SpendPanel } from './SpendPanel';
import { TowerSkeleton } from './TowerSkeleton';
import { useOpenDecisions, useSessionOwners, useTowerSnapshot } from './towerData';
import { rankAttention } from './towerModel';
import { useAttentionActions } from './useAttentionActions';
import { WorkInProgress } from './WorkInProgress';
import './tower.css';

/** Phones get the attention queue straight after the summary (it stays fully actionable). */
const NARROW = '(max-width: 760px)';

/** The server's summary, with its lead clause ("12 items need you") in bold. */
function Summary({ text }: { text: string }) {
  const cut = text.search(/[,;.] /);
  return (
    <p className="tower-summary">
      <Icon name="tower" size={16} className="tower-summary__icon" />
      <span>
        {cut > 0 ? (
          <>
            <b>{text.slice(0, cut)}</b>
            {text.slice(cut)}
          </>
        ) : (
          text
        )}
      </span>
    </p>
  );
}

/** Polite announcement when the number of items needing a human changes (not on first load). */
function useNeedsYouAnnouncement(count: number | undefined): string {
  const previous = useRef<number | undefined>(undefined);
  const [message, setMessage] = useState('');
  useEffect(() => {
    if (count === undefined) return;
    if (previous.current !== undefined && previous.current !== count) {
      setMessage(`${count} ${count === 1 ? 'item needs' : 'items need'} you`);
    }
    previous.current = count;
  }, [count]);
  return message;
}

/**
 * Control Tower — the Approver's landing view (§6, §8, §10, §11, §12, §13). It answers "where is the operation
 * at risk and what needs me, across every project": exception-first, the attention queue ranked by cost of
 * delay with inline actions, then flow, fleet health, spend and capacity, integrity and the anomaly radar.
 * Everything refreshes from the event stream; nothing polls.
 */
export default function ControlTowerPage() {
  const { user } = useAuth();
  const snapshot = useTowerSnapshot();
  const { cards, error: cardsError } = useOpenDecisions();
  const owners = useSessionOwners(user?.role === 'builder');
  const actions = useAttentionActions(snapshot.data, snapshot.reload);
  const narrow = useMediaQuery(NARROW);
  const data = snapshot.data;
  const ranked = useMemo(() => (data ? rankAttention(data.attention) : []), [data]);
  const announcement = useNeedsYouAnnouncement(data?.kpis.needsYou);

  const driveBlock = useCallback(
    (sessionId: string): string | null => {
      if (!user || user.role === 'approver') return null;
      if (user.role !== 'builder') return 'Needs the Builder or Approver role';
      const owner = owners?.get(sessionId);
      if (owner === undefined) return null; // not in the console list: the server decides
      return owner === user.id ? null : 'Only its owner or an Approver can drive this session';
    },
    [user, owners],
  );

  return (
    <div className="tower">
      <PageHeader
        title="Control Tower"
        subtitle="Where the operation is at risk and what needs a human, across every project."
        meta={
          data ? (
            <span className="tower-meta">
              Snapshot{' '}
              <time dateTime={data.generatedAt} title={formatDateTime(data.generatedAt)} className="aoc-num">
                {formatClock(data.generatedAt)}
              </time>{' '}
              · refreshes on every relevant event
            </span>
          ) : undefined
        }
      />
      <p className="aoc-sr-only" aria-live="polite">
        {announcement}
      </p>
      {data ? (
        <TowerBody
          data={data}
          ranked={ranked}
          narrow={narrow}
          cards={cards}
          cardsFailed={cardsError !== undefined}
          actions={actions}
          driveBlock={driveBlock}
          staleError={snapshot.error}
          onRetry={snapshot.reload}
        />
      ) : snapshot.error ? (
        <TowerError error={snapshot.error} onRetry={snapshot.reload} role={user?.role} />
      ) : (
        <TowerSkeleton />
      )}
    </div>
  );
}

function TowerBody({
  data,
  ranked,
  narrow,
  cards,
  cardsFailed,
  actions,
  driveBlock,
  staleError,
  onRetry,
}: {
  data: TowerSnapshot;
  ranked: AttentionQueueProps['items'];
  narrow: boolean;
  cards: AttentionQueueProps['cards'];
  cardsFailed: boolean;
  actions: AttentionQueueProps['actions'];
  driveBlock: AttentionQueueProps['driveBlock'];
  staleError: unknown;
  onRetry: () => void;
}) {
  const kpis = <KpiBand snapshot={data} />;
  return (
    <>
      {staleError !== undefined && (
        <InlineAlert
          tone="warn"
          title={`Showing the snapshot from ${formatClock(data.generatedAt)}`}
          action={
            <button type="button" className="aoc-link-button" onClick={onRetry}>
              Retry
            </button>
          }
        >
          {describeError(staleError) ?? 'The latest refresh failed.'}
        </InlineAlert>
      )}
      <Summary text={data.summary} />
      {!narrow && kpis}
      <div className="tower-main">
        <AttentionQueue
          items={ranked}
          cards={cards}
          cardsFailed={cardsFailed}
          actions={actions}
          driveBlock={driveBlock}
        />
        {narrow && kpis}
        <div className="tower-rail">
          <FleetPanel fleet={data.fleet} />
          <WorkInProgress rows={data.flow.wipByProject} />
        </div>
      </div>
      <FlowPanels flow={data.flow} kpis={data.kpis} />
      <SpendPanel spend={data.spend} />
      <IntegrityPanel integrity={data.integrity} attention={data.attention} />
      <AnomalyRadar anomalies={data.anomalies} />
    </>
  );
}

function TowerError({ error, onRetry, role }: { error: unknown; onRetry: () => void; role?: string }) {
  if (error instanceof ApiError && error.status === 403) {
    return (
      <EmptyState
        icon="compliance"
        title="The Control Tower is not available for your role"
        body={`It is the Approver's landing view${role === 'builder' ? '; as a Builder you can follow every session on the Console and resolve your decisions in the inbox' : ''}.`}
        action={
          <ButtonLink to="/console" variant="primary">
            Open the Console
          </ButtonLink>
        }
      />
    );
  }
  if (error instanceof ApiError && error.status === 404) {
    return (
      <ErrorState
        title="Control Tower data is not available"
        error={error}
        body="This daemon does not serve the Control Tower snapshot yet. Check that the tower module is enabled, then retry."
        onRetry={onRetry}
      />
    );
  }
  return (
    <ErrorState
      title="Couldn't load the Control Tower"
      error={error}
      body="Nothing on this page is shown from cache: retry once the daemon is reachable."
      onRetry={onRetry}
    />
  );
}
