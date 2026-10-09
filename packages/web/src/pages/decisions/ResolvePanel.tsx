import { useState } from 'react';
import type { DecisionCardView, DecisionOption } from '@aoc/contracts';
import { useAuth } from '../../api/auth';
import { Button } from '../../components/Button';
import { CopyableHash } from '../../components/CopyableHash';
import { InlineAlert } from '../../components/EmptyState';
import { Select, TextArea } from '../../components/Field';
import { Icon } from '../../components/Icon';
import type { DecisionActions, PasskeyState } from './actions';
import type { Directory } from './directory';
import { explainBlock, recommendedOption } from './model';
import { passkeysAvailable } from './passkey';

const WITHDRAW_REASONS = [
  { value: 'no_longer_needed', label: 'No longer needed' },
  { value: 'duplicate', label: 'Duplicate of another decision' },
  { value: 'superseded', label: 'Superseded by a newer request' },
  { value: 'raised_in_error', label: 'Raised in error' },
] as const;

/** Button text. "Approve" applies the recommended option (CEO decision on the mock, 2026-10-09). */
export function optionButtonLabel(
  card: DecisionCardView,
  option: DecisionOption,
  recommended: boolean,
): string {
  if (card.requiresPasskey) return `${option.label} with passkey`;
  if (!recommended || /^approve\b/i.test(option.label)) return option.label;
  return `Approve: ${option.label}`;
}

export interface ResolvePanelProps {
  card: DecisionCardView;
  directory: Directory;
  actions: DecisionActions;
  passkeys: PasskeyState;
}

/**
 * How the viewer acts on an open card: every option as a button (recommended first), an optional comment, the
 * passkey ceremony for go-live / rollback / break-glass (registering a passkey inline first when needed), and
 * withdraw / escalate where the API allows them. Read-only viewers get the reason instead.
 */
export function ResolvePanel({ card, directory, actions, passkeys }: ResolvePanelProps) {
  const { user } = useAuth();
  const [comment, setComment] = useState('');
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [reason, setReason] = useState<string>(WITHDRAW_REASONS[0].value);
  const [note, setNote] = useState('');
  if (!user || card.status !== 'open') return null;

  const busy = actions.busy;
  const secondary = (card.viewer.canWithdraw || card.viewer.canEscalate) && (
    <div className="dec-resolve__more">
      {card.viewer.canEscalate && (
        <Button
          size="sm"
          variant="ghost"
          icon="arrow-up"
          loading={busy?.kind === 'escalate'}
          loadingText="Escalating…"
          disabled={busy !== null && busy.kind !== 'escalate'}
          onClick={() => void actions.escalate(card)}
        >
          Escalate to the Approver
        </Button>
      )}
      {card.viewer.canWithdraw && !withdrawOpen && (
        <Button
          size="sm"
          variant="ghost"
          icon="close"
          disabled={busy !== null}
          onClick={() => setWithdrawOpen(true)}
        >
          Withdraw…
        </Button>
      )}
      {withdrawOpen && (
        <form
          className="dec-withdraw"
          onSubmit={(e) => {
            e.preventDefault();
            void actions.withdraw(card, reason, note.trim() || null).then((r) => r && setWithdrawOpen(false));
          }}
        >
          <Select
            label="Why withdraw it?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            options={WITHDRAW_REASONS.map((r) => ({ value: r.value, label: r.label }))}
          />
          <TextArea
            label="Note (optional)"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
          />
          <div className="dec-withdraw__actions">
            <Button
              type="submit"
              size="sm"
              variant="danger"
              loading={busy?.kind === 'withdraw'}
              loadingText="Withdrawing…"
            >
              Withdraw decision
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setWithdrawOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );

  if (!card.viewer.canResolve) {
    const why = explainBlock(card, card.viewer.reason, user, directory);
    return (
      <div className="dec-resolve dec-resolve--blocked">
        {why && (
          <InlineAlert tone="info" title={`Read-only: ${why.title}`}>
            {why.body}
          </InlineAlert>
        )}
        {secondary}
      </div>
    );
  }

  const rec = recommendedOption(card);
  const ordered = rec ? [rec, ...card.options.filter((o) => o.id !== rec.id)] : card.options;
  const needsPasskey = card.requiresPasskey && passkeys.hasPasskey === false;
  const unsupported = card.requiresPasskey && !passkeysAvailable();
  const problem = actions.problem;

  return (
    <div className="dec-resolve">
      {card.requiresPasskey && (
        <div className="dec-signnote">
          <Icon name="key" size={16} />
          <p>
            <strong>Signed approval.</strong> Your passkey signs a single-use challenge bound to you, this
            decision and the option you pick, plus a hash of the title, question and options shown here. A
            changed card voids the signature.
          </p>
        </div>
      )}
      {unsupported && (
        <InlineAlert tone="warn" title="Passkeys are not available in this browser">
          Open the console in a browser with WebAuthn support, at its configured address, to sign this
          decision.
        </InlineAlert>
      )}
      {(needsPasskey || problem?.needsRegistration) && !unsupported && (
        <InlineAlert
          tone="warn"
          title="Register a passkey to sign this decision"
          action={
            <Button
              size="sm"
              variant="primary"
              icon="key"
              loading={busy?.kind === 'register'}
              loadingText="Waiting for passkey…"
              onClick={() => void actions.register()}
            >
              Register a passkey
            </Button>
          }
        >
          Go-live, rollback and break-glass need a per-decision passkey signature. Register one on this device
          (Touch ID, Windows Hello or a security key), then sign.
        </InlineAlert>
      )}
      <TextArea
        label="Comment (optional)"
        hint="Stored with the decision in the encrypted body store."
        rows={2}
        maxLength={4000}
        value={comment}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="dec-resolve__options" role="group" aria-label={`Decide: ${card.title}`}>
        {ordered.map((o) => {
          const isRec = rec?.id === o.id;
          const mine = busy?.kind === 'resolve' && busy.optionId === o.id;
          return (
            <Button
              key={o.id}
              variant={isRec ? 'primary' : 'secondary'}
              icon={card.requiresPasskey ? 'key' : isRec ? 'check' : undefined}
              loading={mine}
              loadingText={card.requiresPasskey ? 'Waiting for passkey…' : 'Recording…'}
              disabled={(busy !== null && !mine) || needsPasskey || unsupported}
              onClick={() => void actions.resolve(card, o.id, comment.trim() || null)}
            >
              {optionButtonLabel(card, o, isRec)}
            </Button>
          );
        })}
      </div>
      {problem && !problem.needsRegistration && (
        <InlineAlert tone="danger" live title={problem.title} onDismiss={actions.clearProblem}>
          {problem.body}
        </InlineAlert>
      )}
      {actions.signedHash && (
        <p className="dec-resolve__signed">
          Last signature committed to card hash <CopyableHash value={actions.signedHash} label="card hash" />
        </p>
      )}
      <p className="dec-resolve__attribution">
        {card.requiresPasskey
          ? 'Recorded as signed (passkey).'
          : 'Recorded as attribution (bearer token): it shows which token was used, not a signature (§6).'}
      </p>
      {secondary}
    </div>
  );
}
