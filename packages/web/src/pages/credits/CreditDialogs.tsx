import { useEffect, useState } from 'react';
import type { CreditAccount, SessionSummary } from '@aoc/contracts';
import { Button, Dialog, InlineAlert, Select, TextArea, TextField, describeError } from '../../components';
import { formatUsd } from '../../lib/format';
import { periodLabel } from './creditsModel';

export interface TopupDraft {
  amountUsd: number;
  reason: string;
  sessionId?: string;
}

/** Client-side checks mirroring the daemon's (amount 0.01–100,000; a reason of 3–2,000 characters). */
export function validateTopup(amount: string, reason: string): string | null {
  const v = Number(amount);
  if (amount.trim() === '' || !Number.isFinite(v) || v < 0.01) return 'Enter an amount of at least US$0.01.';
  if (v > 100_000) return 'The amount is above the US$100,000 limit.';
  if (reason.trim().length < 3) return 'Say what the extra credit is for (at least 3 characters).';
  return null;
}

export interface RequestTopupDialogProps {
  open: boolean;
  onClose: () => void;
  account: CreditAccount | undefined;
  /** The viewer's own managed sessions (a request may name one). */
  sessions: readonly SessionSummary[];
  onSubmit: (draft: TopupDraft) => Promise<void>;
}

/** Button-raised top-up request (§10): it becomes a decision for an Approver other than the requester. */
export function RequestTopupDialog({ open, onClose, account, sessions, onSubmit }: RequestTopupDialogProps) {
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAmount(account ? String(Math.max(10, Math.round(account.allocationUsd * 0.25))) : '');
    setReason('');
    setSessionId('');
    setError(null);
  }, [open, account]);

  const submit = async () => {
    const problem = validateTopup(amount, reason);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ amountUsd: Number(amount), reason: reason.trim(), sessionId: sessionId || undefined });
      onClose();
    } catch (err) {
      setError(describeError(err) ?? 'The request was not sent.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissOnBackdrop={false}
      title="Request a credit top-up"
      description="An Approver decides it — never you. Credits meter cost; they never change which model a session runs on."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} loadingText="Sending…" onClick={() => void submit()}>
            Send request
          </Button>
        </>
      }
    >
      <div className="crd-form">
        {account && (
          <p className="crd-sub aoc-num">
            {periodLabel(account.period)}: balance {formatUsd(account.balanceUsd)} (allocation {formatUsd(account.allocationUsd)} + granted{' '}
            {formatUsd(account.grantedUsd)} − used {formatUsd(account.usedUsd)})
            {account.autoGrantUsed ? ' · auto-grant already used' : ` · ${formatUsd(account.autoGrantAvailableUsd)} auto-grant still available at your first cap`}
          </p>
        )}
        <TextField
          label="Amount (US$, notional)"
          required
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <TextArea
          label="What it is for"
          required
          rows={3}
          maxLength={2000}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          hint="Shown to the Approver; stored encrypted, never in the chained metadata."
        />
        <Select
          label="Against a session (optional)"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          options={[
            { value: '', label: 'Not tied to a session' },
            ...sessions.map((s) => ({ value: s.sessionId, label: `${s.processType ?? 'session'} · ${s.projectName ?? s.projectId ?? 'no project'} · ${s.sessionId}` })),
          ]}
        />
        {error && (
          <InlineAlert tone="danger" title="Not sent" live>
            {error}
          </InlineAlert>
        )}
      </div>
    </Dialog>
  );
}

export interface AllocationDialogProps {
  account: CreditAccount | null;
  onClose: () => void;
  /** Current period first, then the next one (closed periods cannot be changed). */
  periods: readonly string[];
  onSubmit: (input: { userId: string; period: string; amountUsd: number }) => Promise<void>;
}

/** Set a person's allocation for the current or next period (Approver; never their own). */
export function AllocationDialog({ account, onClose, periods, onSubmit }: AllocationDialogProps) {
  const [amount, setAmount] = useState('');
  const [period, setPeriod] = useState(periods[0] ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!account) return;
    setAmount(String(account.allocationUsd));
    setPeriod(periods[0] ?? '');
    setError(null);
  }, [account, periods]);

  const submit = async () => {
    if (!account) return;
    const v = Number(amount);
    if (amount.trim() === '' || !Number.isFinite(v) || v < 0 || v > 1_000_000) {
      setError('Enter an allocation between US$0 and US$1,000,000.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({ userId: account.userId, period, amountUsd: Math.round(v * 100) / 100 });
      onClose();
    } catch (err) {
      setError(describeError(err) ?? 'The allocation was not saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={account !== null}
      onClose={onClose}
      size="sm"
      dismissOnBackdrop={false}
      title={account ? `Allocation for ${account.userName ?? account.userId}` : 'Allocation'}
      description="The 25% auto-grant is always a share of this original allocation; grants and top-ups never raise it."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} loadingText="Saving…" onClick={() => void submit()}>
            Save allocation
          </Button>
        </>
      }
    >
      <div className="crd-form">
        <Select
          label="Period"
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          options={periods.map((p) => ({ value: p, label: periodLabel(p) }))}
        />
        <TextField label="Allocation (US$, notional)" required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        {error && (
          <InlineAlert tone="danger" title="Not saved" live>
            {error}
          </InlineAlert>
        )}
      </div>
    </Dialog>
  );
}
