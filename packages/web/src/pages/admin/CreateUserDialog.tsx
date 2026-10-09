import { useEffect, useId, useState, type FormEvent } from 'react';
import type { IdentityUserDto, Role } from '@aoc/contracts';
import { apiPost } from '../../api';
import { Button, Checkbox, Dialog, InlineAlert, Select, TextField, describeError } from '../../components';
import { ROLES_IN_ORDER, ROLE_META } from './model';

export interface CreateUserDialogProps {
  open: boolean;
  /** Preselected role (e.g. "Add a deputy Approver"). */
  initialRole?: Role;
  onClose: () => void;
  onCreated: (user: IdentityUserDto) => void;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Creates a person with a role (`user.created`). Names and emails go to the encrypted body store. */
export function CreateUserDialog({
  open,
  initialRole = 'builder',
  onClose,
  onCreated,
}: CreateUserDialogProps) {
  const formId = useId();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(initialRole);
  const [lead, setLead] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  useEffect(() => {
    if (!open) return;
    setName('');
    setEmail('');
    setRole(initialRole);
    setLead(false);
    setTouched(false);
    setBusy(false);
    setError(undefined);
  }, [open, initialRole]);

  const nameError = touched && !name.trim() ? 'Enter the person’s name.' : undefined;
  const emailError =
    touched && email.trim() && !EMAIL.test(email.trim())
      ? 'Enter a valid email or leave it empty.'
      : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!name.trim() || (email.trim() && !EMAIL.test(email.trim()))) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await apiPost<{ user: IdentityUserDto }>('/api/users', {
        name: name.trim(),
        ...(email.trim() ? { email: email.trim() } : {}),
        role,
        ...(lead && role !== 'requester' ? { flags: { complianceLead: true } } : {}),
      });
      onCreated(res.user);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initialRole === 'approver' ? 'Add a deputy Approver' : 'Create a user'}
      description="Every change to people and roles is an audited event under your name."
      dismissOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form={formId}
            loading={busy}
            loadingText="Creating…"
            icon="plus"
          >
            Create user
          </Button>
        </>
      }
    >
      <form id={formId} className="admin-form" onSubmit={submit} noValidate>
        <TextField
          label="Name"
          required
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          error={nameError}
          autoComplete="off"
        />
        <TextField
          label="Email"
          type="email"
          value={email}
          maxLength={254}
          onChange={(e) => setEmail(e.target.value)}
          error={emailError}
          hint="Optional. Shown in the passkey prompt; stored encrypted."
          autoComplete="off"
        />
        <Select
          label="Role"
          required
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          options={ROLES_IN_ORDER.map((r) => ({ value: r, label: ROLE_META[r].label }))}
          hint={ROLE_META[role].hint}
        />
        <Checkbox
          label="Compliance lead"
          checked={lead && role !== 'requester'}
          disabled={role === 'requester'}
          onChange={(e) => setLead(e.target.checked)}
          hint={
            role === 'requester'
              ? 'Requesters cannot stamp the compliance mapping.'
              : 'May stamp the ISO/IEC 42001 mapping as reviewed. No role grants this on its own.'
          }
        />
        {error !== undefined && (
          <InlineAlert tone="danger" title="Not created" live>
            {describeError(error)}
          </InlineAlert>
        )}
      </form>
    </Dialog>
  );
}
