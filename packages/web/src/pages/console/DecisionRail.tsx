import type { DecisionCardView, DecisionKind, Role, SessionSummary } from '@aoc/contracts';
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiPost } from '../../api/client';
import { Button, ButtonLink } from '../../components/Button';
import { CountBadge } from '../../components/Badge';
import { EmptyState, InlineAlert, describeError } from '../../components/EmptyState';
import { Icon } from '../../components/Icon';
import { RelativeTime } from '../../components/RelativeTime';
import { useToast } from '../../components/Toast';
import { decisionHref } from '../../lib/links';
import { Glyph } from '../sessions/glyphs';
import './decisionCard.css';

/** Decision kinds in words (mirrors the contracts' DECISION_KIND_LABEL; contracts are imported as types only). */
export const DECISION_KIND_WORD: Record<DecisionKind, string> = {
  agent_decision: 'Agent decision',
  protected_operation: 'Protected operation',
  fix_plan: 'Fix-plan sign-off',
  go_live: 'Go-live',
  rollback: 'Rollback',
  change_request: 'Change request',
  break_glass: 'Break-glass promotion',
  playbook_approval: 'Playbook approval',
  lesson_binding: 'Lesson binding',
  credit_topup: 'Credit top-up',
  fx_discrepancy: 'FX discrepancy',
  triage_reconciliation: 'Triage reconciliation',
  low_confidence_diagnosis: 'Low-confidence diagnosis',
  uat_signoff: 'UAT sign-off',
};

const ROLE_WORD: Record<Role, string> = { approver: 'An Approver', builder: 'A Builder', requester: 'The requester' };

/** Why the viewer cannot act on a card, in words (server reason codes). */
export function blockedText(d: DecisionCardView): string {
  switch (d.viewer.reason) {
    case 'role':
      return `${ROLE_WORD[d.requiredRole]} decides`;
    case 'separation_of_duties':
      return 'You raised this, so someone else decides';
    case 'not_eligible':
      return 'Routed to named people only';
    case 'inactive':
      return 'Your account is inactive';
    case 'not_open':
      return 'No longer open';
    default:
      return 'Not yours to resolve';
  }
}

/** The approved mock's chip: which decision test tripped, or "policy" for approver-only gates with none. */
export function TestChip({ test }: { test: string | null }) {
  return test ? (
    <span className="console-testchip">
      <span className="console-testchip__k">test</span> {test}
    </span>
  ) : (
    <span className="console-testchip console-testchip--policy">policy</span>
  );
}

export interface DecisionRailProps {
  decisions: readonly DecisionCardView[];
  sessions: ReadonlyMap<string, SessionSummary>;
  /** Called after a successful resolve so the list refetches even if the stream is down. */
  onResolved: () => void;
  /** Cards shown before "more in the inbox". */
  limit?: number;
}

/** Open decisions, oldest first, with the recommendation and the one action the viewer may take (R15). */
export function DecisionRail({ decisions, sessions, onResolved, limit = 8 }: DecisionRailProps) {
  const headingId = useId();
  const shown = decisions.slice(0, limit);
  const more = decisions.length - shown.length;
  return (
    <aside className="console-rail" aria-labelledby={headingId}>
      <header className="console-panel__head">
        <h2 id={headingId} className="console-panel__title">
          Decisions waiting <CountBadge count={decisions.length} showZero label="open decisions" />
        </h2>
        <p className="console-panel__meta">Oldest first · all projects</p>
      </header>
      {decisions.length === 0 ? (
        <EmptyState
          size="sm"
          icon="decisions"
          title="No decisions waiting"
          body="Agent decisions, gates and top-ups that need a person appear here with their age."
        />
      ) : (
        <ol className="console-dlist">
          {shown.map((d) => (
            <DecisionCard key={d.id} decision={d} session={d.sessionId ? sessions.get(d.sessionId) : undefined} onResolved={onResolved} />
          ))}
        </ol>
      )}
      <footer className="console-rail__foot">
        <Link to="/decisions">
          {more > 0 ? `${more} more in the decisions inbox` : 'Open the decisions inbox'}
        </Link>
      </footer>
    </aside>
  );
}

export interface DecisionCardProps {
  decision: DecisionCardView;
  /** The session it came from, for the source line (omitted on that session's own page). */
  session: SessionSummary | undefined;
  onResolved: () => void;
}

/** One open decision: age, kind, test, the recommendation, and the one action the viewer may take. */
export function DecisionCard({ decision: d, session, onResolved }: DecisionCardProps) {
  const toast = useToast();
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const rec = d.recommendation;
  const recOption = rec ? d.options.find((o) => o.id === rec.optionId) : undefined;
  const byAgent = d.requesterId.startsWith('session:');

  const approve = async () => {
    if (!rec) return;
    setBusy(true);
    setError(null);
    try {
      await apiPost(`/api/decisions/${encodeURIComponent(d.id)}/resolve`, { optionId: rec.optionId });
      toast.notify({ tone: 'ok', title: `Approved: ${recOption?.label ?? rec.optionId}`, body: d.title });
      onResolved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="console-dcard" id={d.id} aria-labelledby={titleId}>
      <div className="console-dcard__top">
        <span className={d.overdue ? 'console-dcard__age is-overdue' : 'console-dcard__age'}>
          <Icon name="clock" size={12} />
          <RelativeTime value={d.createdAt} />
          {d.overdue && <span className="console-dcard__overdue">overdue</span>}
        </span>
        <span className="console-dcard__kind">{DECISION_KIND_WORD[d.kind] ?? d.kind}</span>
        <TestChip test={d.test} />
        {d.requiresPasskey && (
          <span className="console-dcard__pk">
            <Icon name="key" size={12} /> Passkey
          </span>
        )}
      </div>
      <h3 id={titleId} className="console-dcard__q">
        {d.title}
      </h3>
      {d.question && d.question !== d.title && <p className="console-dcard__ask">{d.question}</p>}
      {session && (
        <p className="console-dcard__src">
          {session.projectName ?? 'No project'} ·{' '}
          <Link to={`/sessions/${encodeURIComponent(session.sessionId)}`}>{session.title}</Link>
          {session.ownerName && <> · {session.ownerName}</>}
        </p>
      )}
      {rec && (
        <div className="console-rec">
          <p className="console-rec__by">
            <Glyph name="star" size={12} /> {byAgent ? 'Agent recommends' : 'Recommended'}
          </p>
          <p className="console-rec__what">{recOption?.label ?? rec.optionId}</p>
          {rec.rationale && <p className="console-rec__why">{rec.rationale}</p>}
        </div>
      )}
      {error !== null && (
        <InlineAlert tone="danger" title="Not approved" live>
          {describeError(error)}
        </InlineAlert>
      )}
      <div className="console-dcard__actions">
        {d.viewer.canResolve && rec && !d.requiresPasskey ? (
          <Button
            size="sm"
            variant="primary"
            loading={busy}
            loadingText="Approving…"
            aria-label={`Approve: ${recOption?.label ?? rec.optionId}`}
            onClick={() => void approve()}
          >
            Approve
          </Button>
        ) : d.viewer.canResolve ? (
          <ButtonLink size="sm" variant="primary" to={decisionHref(d.id)} icon={d.requiresPasskey ? 'key' : undefined}>
            {d.requiresPasskey ? 'Approve with passkey' : 'Choose an option'}
          </ButtonLink>
        ) : (
          <span className="console-dcard__blocked">
            <Glyph name="lock" size={12} /> {blockedText(d)}
          </span>
        )}
        <Link className="console-dcard__review" to={decisionHref(d.id)}>
          Review<span className="aoc-sr-only"> {d.title}</span>
        </Link>
      </div>
    </li>
  );
}
