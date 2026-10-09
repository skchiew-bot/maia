import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ChangeRequestDTO, DecisionCardView, SessionSummary } from '@aoc/contracts';
import type { AuthUser } from '../../api/auth';
import { apiPost } from '../../api/client';
import type { StreamMessage } from '../../api/stream';
import { useResource } from '../../api/useResource';
import {
  Badge,
  Button,
  Dialog,
  Icon,
  InlineAlert,
  RelativeTime,
  Select,
  TextField,
  describeError,
  useToast,
} from '../../components';
import { cx } from '../../lib/dom';
import { formatDuration } from '../../lib/format';
import { decisionHref } from '../../lib/links';
import { PersonName, usePeople } from '../audit/people';
import { FIELD_META, FIELD_ORDER, SCOPE_META, blockedBySoleApprover, submitGate } from './model';

interface ActionProps {
  change: ChangeRequestDTO;
  viewer: AuthUser;
  canAct: boolean;
  onSaved: (change: ChangeRequestDTO) => void;
}

/** The submit gate (§8): it will not submit until all four fields are affirmed and a rollback target is named. */
export function SubmitBar({ change, viewer, canAct, onSaved }: ActionProps) {
  const toast = useToast();
  const { approvers } = usePeople();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const gate = submitGate(change);
  const selfApprove = change.scope === 'reversible_off_main' && viewer.role === 'builder';
  const needsApprover = SCOPE_META[change.scope].gate === 'approver';
  const soleApprover = needsApprover && blockedBySoleApprover(viewer.id, approvers);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await apiPost<ChangeRequestDTO>(
        `/api/changes/${encodeURIComponent(change.changeId)}/submit`,
      );
      onSaved(res);
      toast.notify(
        res.status === 'approved'
          ? {
              tone: 'ok',
              title: 'Submitted and self-approved',
              body: 'The full record is kept under your name.',
            }
          : { tone: 'ok', title: 'Submitted for approval', body: 'The Approver has a decision card for it.' },
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="changes-submit" aria-label="Submit this change request">
      <ul className="changes-submit__checks">
        {FIELD_ORDER.map((f) => {
          const ok = !gate.missing.includes(f);
          return (
            <li key={f} className={cx(ok ? 'is-ok' : 'is-missing')}>
              <Icon name={ok ? 'check' : 'minus'} size={14} />
              {FIELD_META[f].label}
              <span className="aoc-sr-only">{ok ? ' affirmed' : ' not affirmed yet'}</span>
            </li>
          );
        })}
        <li className={cx(gate.needsRollbackRef ? 'is-missing' : 'is-ok')}>
          <Icon name={gate.needsRollbackRef ? 'minus' : 'check'} size={14} />
          Rollback target named
        </li>
      </ul>
      {soleApprover && (
        <InlineAlert tone="warn" title="If you submit it, nobody can approve it">
          The submitter is the request's requester, and an Approver never approves their own request
          (separation of duties; the sole-Approver fallback is off). As the only Approver you would block it
          until a second Approver exists. Let the developer who owns it submit it instead.
        </InlineAlert>
      )}
      {error !== undefined && (
        <InlineAlert tone="danger" title="Not submitted" live>
          {describeError(error)}
        </InlineAlert>
      )}
      <div className="changes-submit__row">
        <Button
          variant="primary"
          icon="decisions"
          disabled={!gate.ready || !canAct}
          loading={busy}
          loadingText="Submitting…"
          onClick={() => void submit()}
        >
          {selfApprove ? 'Submit and self-approve' : 'Submit for approval'}
        </Button>
        <span className="changes-submit__why">
          {!canAct
            ? 'Only the record’s developer or an Approver can submit it.'
            : gate.ready
              ? selfApprove
                ? 'Reversible off-main work: you approve it yourself, and the record stays complete.'
                : `${SCOPE_META[change.scope].label}: the Approver decides.`
              : `Affirm ${gate.missing.map((f) => FIELD_META[f].label.toLowerCase()).join(', ') || 'the fields'}${
                  gate.needsRollbackRef ? ' and name the rollback target' : ''
                } to submit.`}
        </span>
      </div>
    </section>
  );
}

const isSessionEvent = (m: StreamMessage) =>
  m.kind === 'aoc' && (m.event.type === 'session.launch_requested' || m.event.type === 'session.ended');

/** Approved work: link the managed session doing it, then complete it, which pins an immutable tag. */
export function WorkActions({ change, canAct, onSaved }: ActionProps) {
  const toast = useToast();
  const sessions = useResource<SessionSummary[]>(canAct ? '/api/sessions' : null, {
    refreshOn: isSessionEvent,
  });
  const [sessionId, setSessionId] = useState('');
  const [completing, setCompleting] = useState(false);
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState<'start' | 'complete' | null>(null);
  const [error, setError] = useState<unknown>(undefined);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const linked = new Set(change.sessions.map((s) => s.sessionId));
  const options = (sessions.data ?? []).filter(
    (s) => s.mode === 'managed' && s.projectId === change.projectId && !linked.has(s.sessionId),
  );

  if (!canAct) {
    return (
      <p className="changes-muted changes-work__note">
        Only the record’s developer or an Approver can link sessions or complete it.
      </p>
    );
  }

  const run = async (kind: 'start' | 'complete') => {
    setBusy(kind);
    setError(undefined);
    try {
      const path = `/api/changes/${encodeURIComponent(change.changeId)}/${kind}`;
      const res = await apiPost<ChangeRequestDTO>(
        path,
        kind === 'start' ? { sessionId } : ref.trim() ? { ref: ref.trim() } : {},
      );
      onSaved(res);
      if (kind === 'complete') {
        setCompleting(false);
        toast.notify({ tone: 'ok', title: `Completed and pinned as ${res.pinnedTag ?? 'a tag'}` });
      } else {
        setSessionId('');
        toast.notify({ tone: 'ok', title: 'Session linked; its commits now trace to this change' });
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="changes-work">
      {error !== undefined && !completing && (
        <InlineAlert tone="danger" title="That did not go through" live>
          {describeError(error)}
        </InlineAlert>
      )}
      <div className="changes-work__row">
        <Select
          label="Link a managed session"
          fieldClassName="changes-work__select"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          placeholder={options.length ? 'Choose a session' : 'No other managed session in this project'}
          options={options.map((s) => ({
            value: s.sessionId,
            label: `${s.title || s.sessionId}${s.ownerName ? ` · ${s.ownerName}` : ''} · ${s.lifecycle}`,
          }))}
        />
        <Button
          disabled={!sessionId}
          loading={busy === 'start'}
          loadingText="Linking…"
          onClick={() => void run('start')}
        >
          Link session
        </Button>
      </div>
      <p className="changes-muted changes-work__note">
        Commits from a linked session trace to this change, so promotion's provenance check accepts them.
      </p>
      <div className="changes-work__row">
        <Button variant="primary" icon="check" onClick={() => setCompleting(true)}>
          Complete and pin
        </Button>
        <span className="changes-muted">
          Pins the repository state as the immutable tag aoc/change/&lt;id&gt;, a rollback target from then
          on.
        </span>
      </div>
      <Dialog
        open={completing}
        onClose={() => setCompleting(false)}
        role="alertdialog"
        size="sm"
        title="Complete and pin this change?"
        description="AOC creates the immutable tag aoc/change/<id> at the commit below and records it in the chain. It becomes a rollback target."
        initialFocus={cancelRef}
        footer={
          <>
            <Button ref={cancelRef} variant="ghost" onClick={() => setCompleting(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={busy === 'complete'}
              loadingText="Pinning…"
              onClick={() => void run('complete')}
            >
              Complete and pin
            </Button>
          </>
        }
      >
        <TextField
          label="Commit to pin (optional)"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          placeholder="repository HEAD"
          hint="Leave empty to pin the repository's current HEAD."
        />
        {error !== undefined && completing && (
          <InlineAlert tone="danger" title="Not completed" live>
            {describeError(error)}
          </InlineAlert>
        )}
      </Dialog>
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  change_request: 'Change request',
  rollback: 'Rollback',
  break_glass: 'Break-glass promotion',
  go_live: 'Go-live',
};

const STATUS_WORD: Record<string, { label: string; tone: 'accent' | 'ok' | 'neutral' }> = {
  open: { label: 'Open', tone: 'accent' },
  resolved: { label: 'Resolved', tone: 'ok' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
};

/** The decision card behind a gated record, with what the viewer can do about it. */
export function DecisionSummary({ decisionId }: { decisionId: string }) {
  const d = useResource<DecisionCardView>(`/api/decisions/${encodeURIComponent(decisionId)}`, {
    refreshOn: (m) =>
      m.kind === 'aoc' && m.event.type.startsWith('decision.') && m.event.meta.decisionId === decisionId,
  });
  const link = decisionHref(decisionId);
  if (!d.data) {
    return (
      <p className="changes-decision">
        {d.error ? 'The decision could not be loaded. ' : 'Loading the decision… '}
        <Link to={link}>Open it in Decisions</Link>
      </p>
    );
  }
  const card = d.data;
  const status = STATUS_WORD[card.status] ?? { label: card.status, tone: 'neutral' as const };
  return (
    <div className="changes-decision">
      <p className="changes-decision__head">
        <Badge tone={status.tone} icon={card.status === 'open' ? 'decisions' : 'check'}>
          {status.label}
        </Badge>
        <span>{KIND_LABEL[card.kind] ?? card.kind.replace(/_/g, ' ')}</span>
        <span className="changes-muted">
          {card.requiredRole === 'approver' ? 'Approver' : 'Builder'} decision
          {card.requiresPasskey ? ' · passkey' : ''} · {card.status === 'open' ? 'waiting' : 'waited'}{' '}
          {formatDuration(card.ageMs)}
        </span>
      </p>
      {card.resolution && (
        <p>
          {card.resolution.optionId === 'approve' ? 'Approved' : `Chose “${card.resolution.optionId}”`} by{' '}
          <PersonName id={card.resolution.resolvedBy} />{' '}
          <RelativeTime value={card.resolution.resolvedAt} suffix=" ago" />
          {card.resolution.passkeyVerified ? ' · passkey verified' : ''}
          {card.resolution.comment ? <> · “{card.resolution.comment}”</> : null}
        </p>
      )}
      {card.status === 'open' && card.viewer.reason === 'separation_of_duties' && (
        <p className="changes-decision__sod">
          <Icon name="warn" size={12} /> You raised this request, so you cannot approve it (separation of
          duties).
        </p>
      )}
      <Link to={link} className="changes-decision__link">
        {card.status === 'open' && card.viewer.canResolve ? 'Decide in Decisions' : 'Open in Decisions'}
      </Link>
    </div>
  );
}
