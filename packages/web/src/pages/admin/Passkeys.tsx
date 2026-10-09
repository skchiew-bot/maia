import { useRef, useState } from 'react';
import {
  WebAuthnError,
  browserSupportsWebAuthn,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/browser';
import type { PasskeyDto, PasskeyOptionsResponse } from '@aoc/contracts';
import { ApiError, apiDelete, apiPost } from '../../api';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Icon,
  InlineAlert,
  RelativeTime,
  TextField,
  describeError,
  formatShortDate,
  useToast,
} from '../../components';

/** Plain-language reason a registration ceremony failed. */
export function registrationError(err: unknown): string {
  if (err instanceof WebAuthnError) {
    switch (err.code) {
      case 'ERROR_CEREMONY_ABORTED':
        return 'Registration was cancelled.';
      case 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED':
        return 'This authenticator already holds a passkey for you.';
      case 'ERROR_INVALID_DOMAIN':
      case 'ERROR_INVALID_RP_ID':
        return 'Passkeys do not work at this address. Open the console at its configured origin (https, or localhost).';
      case 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT':
        return 'This authenticator cannot verify you (PIN or biometric), which approvals require.';
      default:
        return err.message;
    }
  }
  if (err instanceof DOMException && err.name === 'NotAllowedError')
    return 'The passkey prompt was dismissed or timed out.';
  if (err instanceof ApiError) return describeError(err) ?? 'The server refused the passkey.';
  return err instanceof Error ? err.message : 'Registration failed.';
}

function webAuthnAvailable(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && browserSupportsWebAuthn();
}

export interface PasskeyListProps {
  passkeys: readonly PasskeyDto[];
  /** Whose passkeys these are, for labels ("your" or a name). */
  owner: string;
  onRemoved: () => void;
}

/** Registered passkeys with removal (an Approver may remove anyone's; the server checks). */
export function PasskeyList({ passkeys, owner, onRemoved }: PasskeyListProps) {
  const toast = useToast();
  const [target, setTarget] = useState<PasskeyDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const remove = async () => {
    if (!target) return;
    setBusy(true);
    setError(undefined);
    try {
      await apiDelete(`/api/passkeys/${encodeURIComponent(target.id)}`);
      toast.notify({ tone: 'ok', title: 'Passkey removed' });
      setTarget(null);
      onRemoved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (passkeys.length === 0)
    return (
      <EmptyState
        size="sm"
        icon="key"
        title={`No passkey for ${owner}`}
        body="Without one, go-live, rollback and break-glass decisions cannot be approved."
      />
    );

  return (
    <>
      <ul className="admin-keys">
        {passkeys.map((p) => (
          <li key={p.id} className="admin-keys__item">
            <Icon name="key" size={16} className="admin-keys__icon" />
            <div className="admin-keys__main">
              <span className="admin-keys__label">{p.label ?? 'Unnamed passkey'}</span>
              <span className="admin-muted aoc-num">
                added {formatShortDate(p.createdAt)} ·{' '}
                {p.lastUsedAt ? (
                  <RelativeTime value={p.lastUsedAt} prefix="last signed " suffix=" ago" />
                ) : (
                  'never used to sign'
                )}
              </span>
            </div>
            <Badge tone="neutral">{p.deviceType === 'multiDevice' ? 'Synced' : 'This device only'}</Badge>
            <Button size="sm" variant="ghost" onClick={() => setTarget(p)}>
              Remove…
            </Button>
          </li>
        ))}
      </ul>
      <Dialog
        open={target !== null}
        onClose={() => {
          setTarget(null);
          setError(undefined);
        }}
        role="alertdialog"
        size="sm"
        title="Remove this passkey?"
        description={`${target?.label ?? 'This passkey'} stops working for ${owner}. Go-live, rollback and break-glass approvals need another registered passkey.`}
        initialFocus={cancelRef}
        footer={
          <>
            <Button ref={cancelRef} onClick={() => setTarget(null)}>
              Keep it
            </Button>
            <Button variant="danger" onClick={() => void remove()} loading={busy} loadingText="Removing…">
              Remove passkey
            </Button>
          </>
        }
      >
        {error !== undefined && (
          <InlineAlert tone="danger" title="Not removed" live>
            {describeError(error)}
          </InlineAlert>
        )}
      </Dialog>
    </>
  );
}

export interface RegisterPasskeyProps {
  onRegistered: () => void;
}

/**
 * Registers a passkey for the signed-in person through WebAuthn: options from the daemon, the browser's
 * authenticator ceremony (user verification required), then server-side verification.
 */
export function RegisterPasskey({ onRegistered }: RegisterPasskeyProps) {
  const toast = useToast();
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = webAuthnAvailable();

  const register = async () => {
    setBusy(true);
    setError(null);
    try {
      const { options } = await apiPost<PasskeyOptionsResponse>('/api/passkeys/register/options');
      const response = await startRegistration({
        optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON,
      });
      await apiPost<{ passkey: PasskeyDto }>('/api/passkeys/register/verify', {
        response,
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      toast.notify({ tone: 'ok', title: 'Passkey registered', body: 'You can now sign gated approvals.' });
      setLabel('');
      onRegistered();
    } catch (err) {
      setError(registrationError(err));
    } finally {
      setBusy(false);
    }
  };

  if (!available)
    return (
      <InlineAlert tone="warn" title="Passkeys are not available here">
        This browser or address cannot create a passkey. WebAuthn needs a secure context: https, or localhost.
      </InlineAlert>
    );

  return (
    <div className="admin-register">
      <TextField
        label="Passkey name"
        value={label}
        maxLength={80}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="e.g. MacBook Touch ID"
        hint="Optional. Helps you recognise it later."
        fieldClassName="admin-register__field"
      />
      <Button
        icon="key"
        onClick={() => void register()}
        loading={busy}
        loadingText="Waiting for your authenticator…"
      >
        Register a passkey
      </Button>
      {error && (
        <InlineAlert tone="danger" title="Not registered" live>
          {error}
        </InlineAlert>
      )}
    </div>
  );
}
