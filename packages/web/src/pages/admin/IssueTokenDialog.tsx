import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { IdentityUserDto, IssuedTokenDto } from '@aoc/contracts';
import { apiPost } from '../../api';
import {
  Button,
  Dialog,
  Icon,
  InlineAlert,
  Select,
  TextField,
  describeError,
  formatDateTime,
  useToast,
} from '../../components';
import { EXPIRY_CHOICES } from './model';

export type TokenTarget = { kind: 'user'; user: IdentityUserDto } | { kind: 'observer' };

export interface IssueTokenDialogProps {
  /** Whom the token is for; `null` closes the dialog. */
  target: TokenTarget | null;
  onClose: () => void;
  onIssued: () => void;
}

/** §6: what a bearer token does and does not prove. Shown wherever a token is issued. */
export function AttributionNote() {
  return (
    <InlineAlert tone="info" title="Attribution, not signature">
      A bearer token proves which token was used, not who used it. Go-live, rollback and break-glass also need a
      per-decision passkey: that is the signed approval.
    </InlineAlert>
  );
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Issues a personal API token (`aoc_u_…`) or an observer token (`aoc_o_…`). The secret is shown exactly once,
 * with a copy button; only its hash is stored, so afterwards the console shows the prefix alone.
 */
export function IssueTokenDialog({ target, onClose, onIssued }: IssueTokenDialogProps) {
  const formId = useId();
  const secretId = useId();
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [expiry, setExpiry] = useState('90');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [issued, setIssued] = useState<IssuedTokenDto | null>(null);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const secretRef = useRef<HTMLInputElement>(null);

  const open = target !== null;
  useEffect(() => {
    // The plaintext never outlives the dialog.
    setLabel('');
    setExpiry('90');
    setBusy(false);
    setError(undefined);
    setIssued(null);
    setCopied('idle');
  }, [open]);

  const forWhom = target?.kind === 'user' ? target.user.name : 'observed sessions';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setError(undefined);
    const days = EXPIRY_CHOICES.find((c) => c.value === expiry)?.days ?? null;
    const body = { ...(label.trim() ? { label: label.trim() } : {}), ...(days ? { expiresInDays: days } : {}) };
    try {
      const result =
        target.kind === 'user'
          ? await apiPost<IssuedTokenDto>(`/api/users/${encodeURIComponent(target.user.id)}/tokens`, body)
          : await apiPost<IssuedTokenDto>('/api/tokens/observer', body);
      setIssued(result);
      onIssued();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const onCopy = async () => {
    if (!issued) return;
    const ok = await copy(issued.token);
    setCopied(ok ? 'copied' : 'failed');
    if (!ok) secretRef.current?.select();
  };

  const close = () => {
    if (issued) toast.notify({ tone: 'ok', title: `Token ${issued.prefix}… issued for ${forWhom}` });
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={target?.kind === 'observer' ? 'Issue an observer token' : `Issue a token for ${forWhom}`}
      description={
        target?.kind === 'observer' ? (
          <>
            For <code>aoc hooks install-observed</code> on a developer host: observed sessions are read-only and
            buffer locally while the daemon is down.
          </>
        ) : (
          'A personal token for the CLI and for signing in to the console.'
        )
      }
      dismissOnBackdrop={false}
      footer={
        issued ? (
          <Button variant="primary" onClick={close}>
            Done: I stored it
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" form={formId} loading={busy} loadingText="Issuing…" icon="key">
              Issue token
            </Button>
          </>
        )
      }
    >
      {issued ? (
        <div className="admin-secret">
          <InlineAlert tone="warn" title="Shown once" live>
            {issued.note}
          </InlineAlert>
          <label htmlFor={secretId} className="admin-secret__label">
            Token
          </label>
          <div className="admin-secret__row">
            <input
              id={secretId}
              ref={secretRef}
              className="aoc-input admin-secret__value"
              value={issued.token}
              readOnly
              spellCheck={false}
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button onClick={() => void onCopy()} icon={copied === 'copied' ? 'check' : 'copy'}>
              {copied === 'copied' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="admin-muted" aria-live="polite">
            {copied === 'failed'
              ? 'Copy is blocked here: the token is selected, copy it with your keyboard.'
              : `Afterwards the console shows only its prefix, ${issued.prefix}. ${
                  issued.expiresAt ? `Expires ${formatDateTime(issued.expiresAt)}.` : 'No expiry: revoke it when unused.'
                }`}
          </p>
          <AttributionNote />
        </div>
      ) : (
        <form id={formId} className="admin-form" onSubmit={submit} noValidate>
          <TextField
            label="Label"
            value={label}
            maxLength={80}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={target?.kind === 'observer' ? 'e.g. build host 2' : 'e.g. laptop CLI'}
            hint="Where it will live, so it can be recognised and revoked later."
          />
          <Select
            label="Expires"
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
            options={EXPIRY_CHOICES.map((c) => ({ value: c.value, label: c.label }))}
            hint="Shorter is safer. A token without expiry lives until it is revoked."
          />
          <AttributionNote />
          <p className="admin-muted">
            <Icon name="info" size={12} /> Only a hash of the token is kept. The plaintext is shown once, right
            after issuing.
          </p>
          {error !== undefined && (
            <InlineAlert tone="danger" title="Not issued" live>
              {describeError(error)}
            </InlineAlert>
          )}
        </form>
      )}
    </Dialog>
  );
}
