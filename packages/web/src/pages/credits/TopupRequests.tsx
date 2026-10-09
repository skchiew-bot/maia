import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CreditTopupRequest, DecisionCardView } from '@aoc/contracts';
import { Badge, Button, EmptyState, Icon, InlineAlert, RelativeTime, describeError } from '../../components';
import { cx } from '../../lib/dom';
import { formatAge, formatShortDate, formatUsd } from '../../lib/format';
import { TOPUP_SLA_MS, topupAging } from './creditsModel';

export interface TopupRequestsProps {
  requests: readonly CreditTopupRequest[];
  /** Open credit_topup decisions by id: the viewer's right to decide each request. */
  decisions: ReadonlyMap<string, DecisionCardView>;
  meId: string | null;
  nameOf: (userId: string | null) => string | null;
  onResolve: (decisionId: string, optionId: 'approve' | 'deny') => Promise<void>;
}

const BLOCKED: Record<string, string> = {
  separation_of_duties: 'You raised this request: another Approver decides (separation of duties).',
  role: 'Only an Approver can grant a top-up.',
  not_eligible: 'You are not an eligible approver for this request.',
  not_open: 'This decision is no longer open.',
  inactive: 'Your account is inactive.',
};

function StatusBadge({ r }: { r: CreditTopupRequest }) {
  if (r.status === 'granted') return <Badge tone="ok" icon="ok">Granted</Badge>;
  if (r.status === 'denied') return <Badge icon="close">Denied</Badge>;
  if (r.status === 'withdrawn') return <Badge icon="minus">Withdrawn</Badge>;
  return null;
}

/**
 * Top-up requests (§10): a waiting request ages as its own state against the 1-hour SLA — it is not a stall.
 * Approving is the Approver's decision; the requester can never resolve their own request.
 */
export function TopupRequests({ requests, decisions, meId, nameOf, onResolve }: TopupRequestsProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = requests.filter((r) => r.status === 'pending').sort((a, b) => b.ageMs - a.ageMs);
  const closed = requests.filter((r) => r.status !== 'pending');

  const act = async (r: CreditTopupRequest, optionId: 'approve' | 'deny') => {
    setBusy(`${r.requestId}:${optionId}`);
    setError(null);
    try {
      await onResolve(r.decisionId, optionId);
    } catch (err) {
      setError(describeError(err) ?? 'The decision was not recorded.');
    } finally {
      setBusy(null);
    }
  };

  if (requests.length === 0)
    return (
      <EmptyState
        size="sm"
        icon="credits"
        title="No top-up requests this period"
        body="A request appears here when someone at their cap asks for more; the Approver decides it."
      />
    );

  const row = (r: CreditTopupRequest) => {
    const d = decisions.get(r.decisionId);
    const aging = topupAging(r, d);
    const mine = r.userId === meId;
    return (
      <li key={r.requestId} className={cx('crd-req', r.status === 'pending' && 'is-pending', aging.overdue && 'is-overdue')}>
        <div className="crd-req__main">
          <p className="crd-req__head">
            <b>{r.userName ?? nameOf(r.userId) ?? r.userId}</b>
            {mine && <span className="crd-you">you</span>}
            <span className="crd-req__amount aoc-num">{formatUsd(r.amountUsd)}</span>
            {r.status === 'pending' ? (
              <span className={cx('crd-aging', aging.overdue && 'is-overdue')}>
                <Icon name="clock" size={12} />
                Waiting {formatAge(r.ageMs)}
                <span className="crd-sub-inline">
                  {aging.overdue ? ` · past the ${formatAge(TOPUP_SLA_MS)} SLA` : ` · SLA ${formatAge(TOPUP_SLA_MS)}`}
                </span>
              </span>
            ) : (
              <StatusBadge r={r} />
            )}
          </p>
          <p className="crd-req__reason">{r.reason ?? '[erased]'}</p>
          <p className="crd-sub">
            Raised {formatShortDate(r.createdAt)} for {r.period}
            {r.sessionId ? (
              <>
                {' '}
                · against <Link to={`/sessions/${encodeURIComponent(r.sessionId)}`}>{r.sessionId}</Link>
                {r.taskId ? `, task ${r.taskId}` : ''}
              </>
            ) : (
              ' · not tied to a session'
            )}
          </p>
          {r.status !== 'pending' && (
            <p className="crd-sub aoc-num">
              {r.status === 'withdrawn' ? 'Closed' : r.status === 'granted' ? 'Granted' : 'Denied'}
              {r.resolvedBy ? ` by ${nameOf(r.resolvedBy) ?? 'the Approver'}` : ''}
              {r.resolvedAt ? (
                <>
                  {' '}
                  <RelativeTime value={r.resolvedAt} suffix=" ago" /> after {formatAge(r.ageMs)}
                </>
              ) : null}
              {r.status === 'granted' && r.balanceBefore !== null && r.balanceAfter !== null
                ? ` · balance ${formatUsd(r.balanceBefore)} → ${formatUsd(r.balanceAfter)}`
                : ''}
            </p>
          )}
        </div>
        {r.status === 'pending' && (
          <div className="crd-req__act">
            {d?.viewer.canResolve ? (
              <>
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy === `${r.requestId}:approve`}
                  loadingText="Approving…"
                  disabled={busy !== null}
                  onClick={() => void act(r, 'approve')}
                >
                  Approve {formatUsd(r.amountUsd, { decimals: 0 })}
                </Button>
                <Button
                  size="sm"
                  loading={busy === `${r.requestId}:deny`}
                  loadingText="Denying…"
                  disabled={busy !== null}
                  onClick={() => void act(r, 'deny')}
                >
                  Deny
                </Button>
              </>
            ) : (
              <span className="crd-sub">
                {d ? (BLOCKED[d.viewer.reason ?? ''] ?? 'You cannot decide this request.') : mine ? BLOCKED.separation_of_duties : BLOCKED.role}
              </span>
            )}
          </div>
        )}
      </li>
    );
  };

  return (
    <>
      {error && (
        <InlineAlert tone="danger" title="Decision not recorded" live onDismiss={() => setError(null)}>
          {error}
        </InlineAlert>
      )}
      {pending.length > 0 && (
        <ul className="crd-reqs" aria-label="Waiting top-up requests, oldest first">
          {pending.map(row)}
        </ul>
      )}
      {closed.length > 0 && (
        <>
          <h3 className="crd-h3">Decided</h3>
          <ul className="crd-reqs" aria-label="Decided top-up requests">
            {closed.map(row)}
          </ul>
        </>
      )}
    </>
  );
}
