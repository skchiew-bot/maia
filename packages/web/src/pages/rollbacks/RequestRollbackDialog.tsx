import { useEffect, useState, type FormEvent } from 'react';
import type { ChangeRequestDTO, PinListDTO, RollbackDTO } from '@aoc/contracts';
import type { AuthUser } from '../../api/auth';
import { apiPost } from '../../api/client';
import { useResource } from '../../api/useResource';
import { Button, Dialog, InlineAlert, Select, TextArea, describeError, useToast } from '../../components';
import { usePeople } from '../audit/people';
import { blockedBySoleApprover, shortId } from '../changes/model';
import type { ProjectIndex } from '../changes/projects';
import { RollbackTargetPicker } from '../changes/RollbackTargetPicker';
import { isPinEvent } from './PinsPanel';

export interface RollbackPrefill {
  projectId?: string;
  target?: string;
  changeId?: string | null;
}

export interface RequestRollbackDialogProps {
  open: boolean;
  onClose: () => void;
  projects: ProjectIndex;
  viewer: AuthUser;
  prefill: RollbackPrefill;
  onRequested: (r: RollbackDTO) => void;
}

/**
 * Issue a rollback (§8). It is a request, not an action on main: the supervisor first checks the pinned state out
 * on its own branch and runs that state's acceptance tests; only a clean result reaches the Approver's passkey.
 */
export function RequestRollbackDialog({
  open,
  onClose,
  projects,
  viewer,
  prefill,
  onRequested,
}: RequestRollbackDialogProps) {
  const toast = useToast();
  const { approvers } = usePeople();
  const [projectId, setProjectId] = useState('');
  const [target, setTarget] = useState('');
  const [changeId, setChangeId] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  useEffect(() => {
    if (!open) return;
    setProjectId(prefill.projectId ?? projects.projects[0]?.projectId ?? '');
    setTarget(prefill.target ?? '');
    setChangeId(prefill.changeId ?? '');
    setReason('');
    setTouched(false);
    setError(undefined);
  }, [open, prefill, projects.projects]);

  const pins = useResource<PinListDTO>(open && projectId ? '/api/pins' : null, {
    query: { projectId, limit: 300 },
    refreshOn: isPinEvent,
  });
  const changes = useResource<{ items: ChangeRequestDTO[] }>(open && projectId ? '/api/changes' : null, {
    query: { projectId, limit: 200 },
  });
  const linkable = (changes.data?.items ?? []).filter((c) =>
    ['approved', 'in_progress', 'completed'].includes(c.status),
  );
  const soleApprover = blockedBySoleApprover(viewer.id, approvers);

  const pickTarget = (ref: string) => {
    setTarget(ref);
    const pin = pins.data?.pins.find((p) => (p.tag || p.resolvedSha || p.sha) === ref);
    const fromChange = pin?.pinnedBy.find((b) => b.source.startsWith('change.'))?.sourceId;
    if (fromChange && !changeId) setChangeId(fromChange);
  };

  const reasonError = touched && reason.trim().length < 3 ? 'Say why: at least a short sentence.' : undefined;
  const targetError = touched && !target ? 'Pick the pinned state to return to.' : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!projectId || !target || reason.trim().length < 3) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await apiPost<RollbackDTO>('/api/rollbacks', {
        projectId,
        targetRef: target,
        changeId: changeId || null,
        reason: reason.trim(),
      });
      toast.notify({
        tone: 'ok',
        title: 'Rollback requested',
        body: `The supervisor is checking ${r.targetRef} out on its own branch to run its acceptance tests.`,
      });
      onRequested(r);
      onClose();
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
      size="lg"
      title="Request a rollback"
      description="Nothing touches main until the Approver approves a clean verification with a passkey."
      dismissOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            icon="rollbacks"
            type="submit"
            form="rollbacks-request"
            loading={busy}
            loadingText="Requesting…"
          >
            Request rollback
          </Button>
        </>
      }
    >
      <form id="rollbacks-request" className="rollbacks-form" onSubmit={submit} noValidate>
        <ol className="rollbacks-flow" aria-label="What happens next">
          <li>
            <strong>Verify.</strong> The supervisor checks the pinned state out on a new branch,{' '}
            <code>aoc/rollback/&lt;id&gt;</code>, and runs that state's acceptance tests.
          </li>
          <li>
            <strong>Report.</strong> A clean result raises a rollback decision for the Approver; a failing one
            stops here.
          </li>
          <li>
            <strong>Approve.</strong> The Approver approves with a passkey. Then main gets a new commit that
            restores the state, so history is kept.
          </li>
        </ol>
        {soleApprover && (
          <InlineAlert tone="warn" title="You could not approve this rollback">
            You are the only Approver, and the requester of a rollback can never approve it (separation of
            duties). Ask a Builder to request it; you then approve it with your passkey.
          </InlineAlert>
        )}
        {error !== undefined && (
          <InlineAlert tone="danger" title="The rollback was not requested" live>
            {describeError(error)}
          </InlineAlert>
        )}
        <Select
          label="Project"
          required
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setTarget('');
            setChangeId('');
          }}
          options={projects.projects.map((p) => ({ value: p.projectId, label: p.name }))}
        />
        <RollbackTargetPicker
          label="Return to (pinned state)"
          pins={pins.data}
          value={target}
          onChange={pickTarget}
          error={targetError}
        />
        <Select
          label="Change record (optional)"
          value={changeId}
          onChange={(e) => setChangeId(e.target.value)}
          placeholder="None"
          options={linkable.map((c) => ({
            value: c.changeId,
            label: `${c.title ?? c.changeId} · ${shortId(c.changeId)}`,
          }))}
          hint="When its acceptance test is a command, the verification runs that command; otherwise the project's test command."
        />
        <TextArea
          label="Why roll back?"
          required
          value={reason}
          rows={3}
          maxLength={4000}
          onChange={(e) => setReason(e.target.value)}
          error={reasonError}
          hint="Recorded in the encrypted body store; the Approver reads it on the decision."
        />
      </form>
    </Dialog>
  );
}
