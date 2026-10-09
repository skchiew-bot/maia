import { useEffect, useId, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ChangeRequestDTO, ChangeScope, SessionSummary } from '@aoc/contracts';
import { apiPost } from '../../api/client';
import { useResource } from '../../api/useResource';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { InlineAlert, describeError } from '../../components/EmptyState';
import { Select, TextField } from '../../components/Field';
import { useToast } from '../../components/Toast';
import { cx } from '../../lib/dom';
import { SCOPE_META, SCOPE_ORDER } from './model';
import type { ProjectIndex } from './projects';

export interface NewChangeDialogProps {
  open: boolean;
  onClose: () => void;
  projects: ProjectIndex;
  viewerId: string;
  /** Pre-selected project (from the list filter). */
  defaultProjectId?: string;
}

/**
 * Step 1 of a change request: project, scope and title. The daemon drafts the four fields (AI when available);
 * step 2 happens on the record itself, where the developer must edit or affirm each field before it can submit.
 */
export function NewChangeDialog({
  open,
  onClose,
  projects,
  viewerId,
  defaultProjectId,
}: NewChangeDialogProps) {
  const navigate = useNavigate();
  const toast = useToast();
  const scopeName = useId();
  const [projectId, setProjectId] = useState(defaultProjectId ?? '');
  const [scope, setScope] = useState<ChangeScope | ''>('');
  const [title, setTitle] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProjectId(defaultProjectId ?? projects.projects[0]?.projectId ?? '');
    setScope('');
    setTitle('');
    setSessionId('');
    setError(undefined);
    setTouched(false);
  }, [open, defaultProjectId, projects.projects]);

  const sessions = useResource<SessionSummary[]>(open ? '/api/sessions' : null);
  const linkable = (sessions.data ?? []).filter(
    (s) => s.mode === 'managed' && s.projectId === projectId && s.ownerId === viewerId,
  );

  const titleError =
    touched && title.trim().length < 3 ? 'Give the change a title of at least 3 characters.' : undefined;
  const scopeError = touched && !scope ? 'Choose what the change touches.' : undefined;
  const projectError = touched && !projectId ? 'Choose the project.' : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!projectId || !scope || title.trim().length < 3) return;
    setBusy(true);
    setError(undefined);
    try {
      const created = await apiPost<ChangeRequestDTO>('/api/changes', {
        projectId,
        scope,
        title: title.trim(),
        sessionId: sessionId || null,
      });
      toast.notify({
        tone: 'ok',
        title: 'Draft change request created',
        body: 'Edit or affirm each of the four fields, then submit it.',
      });
      onClose();
      navigate(`/changes/${encodeURIComponent(created.changeId)}`);
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
      title="New change request"
      description="Step 1 of 2. Next you write or affirm the impact analysis, mitigation plan, rollback plan and acceptance test. It cannot be submitted until all four are affirmed."
      dismissOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="changes-new-form"
            loading={busy}
            loadingText="Drafting…"
          >
            Create draft
          </Button>
        </>
      }
    >
      <form id="changes-new-form" className="changes-form" onSubmit={submit} noValidate>
        {error !== undefined && (
          <InlineAlert tone="danger" title="The draft was not created" live>
            {describeError(error)}
          </InlineAlert>
        )}
        <Select
          label="Project"
          required
          value={projectId}
          onChange={(e) => {
            setProjectId(e.target.value);
            setSessionId('');
          }}
          placeholder="Choose a project"
          error={projectError}
          options={projects.projects.map((p) => ({ value: p.projectId, label: p.name }))}
        />
        <fieldset
          className={cx('changes-scope', scopeError && 'is-invalid')}
          aria-describedby={`${scopeName}-hint`}
        >
          <legend className="aoc-field__label">
            What does it touch? <span className="aoc-field__required">(required)</span>
          </legend>
          <p id={`${scopeName}-hint`} className="aoc-field__hint">
            Scope decides who approves. Only reversible off-main work is self-approved.
          </p>
          <div className="changes-scope__options">
            {SCOPE_ORDER.map((s) => (
              <label key={s} className={cx('changes-scope__option', scope === s && 'is-checked')}>
                <input
                  type="radio"
                  name={scopeName}
                  value={s}
                  checked={scope === s}
                  onChange={() => setScope(s)}
                />
                <span className="changes-scope__text">
                  <strong>{SCOPE_META[s].label}</strong>
                  <span>{SCOPE_META[s].description}</span>
                  <span className="changes-scope__gate">
                    {SCOPE_META[s].gate === 'self' ? 'Self-approved by a Builder' : 'Approver decision'}
                  </span>
                </span>
              </label>
            ))}
          </div>
          {scopeError && (
            <p className="aoc-field__error" role="alert">
              {scopeError}
            </p>
          )}
        </fieldset>
        <TextField
          label="Title"
          required
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Feature-flag the supervisor whisper suggestions"
          hint="Shown on the decision card and in the audit trail."
          error={titleError}
        />
        <Select
          label="Managed session (optional)"
          value={sessionId}
          onChange={(e) => setSessionId(e.target.value)}
          placeholder={linkable.length ? 'No session' : 'None of your managed sessions are in this project'}
          options={linkable.map((s) => ({ value: s.sessionId, label: s.title || s.sessionId }))}
          hint="Linking a session gives the AI draft the session's plan and handoff context."
        />
      </form>
    </Dialog>
  );
}
