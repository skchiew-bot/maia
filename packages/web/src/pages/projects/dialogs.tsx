import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import type { EnhancementDTO, ProjectDetail, SessionSummary, ThreadSummary } from '@aoc/contracts';
import { ApiError, apiPost } from '../../api';
import { Button, Dialog, InlineAlert, Select, TextArea, TextField, describeError } from '../../components';
import { apiPatch } from './requests';

/*
 * Write actions of the Projects area. Each dialog is mounted only while open, so its form state starts fresh
 * from the latest data every time. Every action is an audited event under the signed-in person's name; the
 * daemon enforces permissions (both operator roles hold project.manage) and the dialog shows its refusal.
 */

type FieldErrors = Record<string, string>;

/** Field-level messages from a 422 `{ details: [{ path, message }] }`; everything else becomes one alert. */
export function errorsOf(err: unknown): { fields: FieldErrors; message: string | null } {
  if (err instanceof ApiError && err.status === 422 && Array.isArray(err.details)) {
    const fields: FieldErrors = {};
    for (const d of err.details as Array<{ path?: unknown; message?: unknown }>) {
      if (typeof d.path === 'string' && typeof d.message === 'string' && d.path) fields[d.path] = d.message;
    }
    if (Object.keys(fields).length) return { fields, message: null };
  }
  if (err instanceof ApiError && err.status === 403)
    return { fields: {}, message: 'Your role cannot make this change; the daemon refused it.' };
  return { fields: {}, message: describeError(err) ?? 'The request failed.' };
}

function useSubmit<T>(run: () => Promise<T>, onDone: (result: T) => void) {
  const [busy, setBusy] = useState(false);
  const [fields, setFields] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setFields({});
    setMessage(null);
    try {
      const result = await run();
      if (alive.current) onDone(result);
    } catch (err) {
      if (!alive.current) return;
      const parsed = errorsOf(err);
      setFields(parsed.fields);
      setMessage(parsed.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return { busy, fields, message, submit };
}

function FormDialog({
  onClose,
  title,
  description,
  submitLabel,
  busyLabel,
  busy,
  canSubmit,
  message,
  onSubmit,
  initialFocus,
  children,
}: {
  onClose: () => void;
  title: string;
  description: ReactNode;
  submitLabel: string;
  busyLabel: string;
  busy: boolean;
  canSubmit: boolean;
  message: string | null;
  onSubmit: (e: FormEvent) => void;
  initialFocus: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
  const formId = useId();
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      dismissOnBackdrop={false}
      initialFocus={initialFocus}
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
            loadingText={busyLabel}
            disabled={!canSubmit}
          >
            {submitLabel}
          </Button>
        </>
      }
    >
      <form id={formId} className="prj-form" onSubmit={onSubmit} noValidate>
        {message && (
          <InlineAlert tone="danger" title="Not saved" live>
            {message}
          </InlineAlert>
        )}
        {children}
      </form>
    </Dialog>
  );
}

interface ProjectFormValues {
  name: string;
  description: string;
  repoPath: string;
  defaultBranch: string;
}

const FIELDS: ReadonlyArray<keyof ProjectFormValues> = ['name', 'description', 'repoPath', 'defaultBranch'];

function ProjectFields({
  values,
  onChange,
  errors,
  nameRef,
}: {
  values: ProjectFormValues;
  onChange: (v: ProjectFormValues) => void;
  errors: FieldErrors;
  nameRef: RefObject<HTMLInputElement | null>;
}) {
  const set = (k: keyof ProjectFormValues) => (e: { target: { value: string } }) =>
    onChange({ ...values, [k]: e.target.value });
  return (
    <>
      <TextField
        ref={nameRef}
        label="Name"
        required
        maxLength={120}
        value={values.name}
        onChange={set('name')}
        error={errors.name}
      />
      <TextArea
        label="Description"
        maxLength={2000}
        rows={3}
        value={values.description}
        onChange={set('description')}
        error={errors.description}
      />
      <TextField
        label="Repository path"
        maxLength={1000}
        value={values.repoPath}
        onChange={set('repoPath')}
        error={errors.repoPath}
        hint="The working copy sessions launch in; phase completions pin their tags here."
        spellCheck={false}
        autoComplete="off"
      />
      <TextField
        label="Default branch"
        maxLength={200}
        value={values.defaultBranch}
        onChange={set('defaultBranch')}
        error={errors.defaultBranch}
        hint="The protected line that rollback and promotion target."
        spellCheck={false}
        autoComplete="off"
      />
    </>
  );
}

function trimmed(v: ProjectFormValues): ProjectFormValues {
  return {
    name: v.name.trim(),
    description: v.description.trim(),
    repoPath: v.repoPath.trim(),
    defaultBranch: v.defaultBranch.trim(),
  };
}

export function NewProjectDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (p: ProjectDetail) => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [values, setValues] = useState<ProjectFormValues>({
    name: '',
    description: '',
    repoPath: '',
    defaultBranch: 'main',
  });
  const v = trimmed(values);
  const form = useSubmit(
    () =>
      apiPost<ProjectDetail>('/api/projects', {
        name: v.name,
        ...(v.description ? { description: v.description } : {}),
        ...(v.repoPath ? { repoPath: v.repoPath } : {}),
        ...(v.defaultBranch ? { defaultBranch: v.defaultBranch } : {}),
      }),
    onCreated,
  );
  return (
    <FormDialog
      onClose={onClose}
      title="New project"
      description="A project is the durable unit of work: sessions come and go, its master timeline stays. Creating one is an audited event under your name."
      submitLabel="Create project"
      busyLabel="Creating…"
      busy={form.busy}
      canSubmit={v.name.length > 0}
      message={form.message}
      onSubmit={form.submit}
      initialFocus={nameRef}
    >
      <ProjectFields values={values} onChange={setValues} errors={form.fields} nameRef={nameRef} />
    </FormDialog>
  );
}

/** Only changed fields are sent; a blank optional field keeps its value (the API sets values, it never clears them). */
export function projectChanges(
  initial: ProjectFormValues,
  next: ProjectFormValues,
): Partial<ProjectFormValues> {
  const a = trimmed(initial);
  const b = trimmed(next);
  const out: Partial<ProjectFormValues> = {};
  for (const k of FIELDS) if (b[k] !== a[k] && b[k] !== '') out[k] = b[k];
  return out;
}

export function EditProjectDialog({
  project,
  onClose,
  onSaved,
}: {
  project: ProjectDetail;
  onClose: () => void;
  onSaved: (p: ProjectDetail) => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [initial] = useState<ProjectFormValues>(() => ({
    name: project.name,
    description: project.description ?? '',
    repoPath: project.repoPath ?? '',
    defaultBranch: project.defaultBranch ?? '',
  }));
  const [values, setValues] = useState(initial);
  const changes = projectChanges(initial, values);
  const form = useSubmit(
    () => apiPatch<ProjectDetail>(`/api/projects/${encodeURIComponent(project.projectId)}`, changes),
    onSaved,
  );
  return (
    <FormDialog
      onClose={onClose}
      title="Edit project details"
      description="Saved as an audited project.updated event. A blank optional field keeps its current value."
      submitLabel="Save changes"
      busyLabel="Saving…"
      busy={form.busy}
      canSubmit={Object.keys(changes).length > 0 && values.name.trim().length > 0}
      message={form.message}
      onSubmit={form.submit}
      initialFocus={nameRef}
    >
      <ProjectFields values={values} onChange={setValues} errors={form.fields} nameRef={nameRef} />
    </FormDialog>
  );
}

export function EnhancementDialog({
  projectId,
  sessions,
  onClose,
  onRecorded,
}: {
  projectId: string;
  sessions: readonly SessionSummary[];
  onClose: () => void;
  onRecorded: (e: EnhancementDTO) => void;
}) {
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [sessionId, setSessionId] = useState('');
  const form = useSubmit(
    () =>
      apiPost<EnhancementDTO>(`/api/projects/${encodeURIComponent(projectId)}/enhancements`, {
        title: title.trim(),
        ...(detail.trim() ? { detail: detail.trim() } : {}),
        ...(sessionId ? { sessionId } : {}),
      }),
    onRecorded,
  );
  return (
    <FormDialog
      onClose={onClose}
      title="Record an enhancement"
      description="Build work beyond the original plan, recorded under your name. It shows as a teal mark on the master timeline and does not change the denominator — new tasks belong in an amendment."
      submitLabel="Record enhancement"
      busyLabel="Recording…"
      busy={form.busy}
      canSubmit={title.trim().length > 0}
      message={form.message}
      onSubmit={form.submit}
      initialFocus={titleRef}
    >
      <TextField
        ref={titleRef}
        label="Title"
        required
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        error={form.fields.title}
      />
      <TextArea
        label="Detail"
        maxLength={4000}
        rows={3}
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        error={form.fields.detail}
      />
      <Select
        label="Session"
        value={sessionId}
        onChange={(e) => setSessionId(e.target.value)}
        error={form.fields.sessionId}
        hint="Optional: the session that did the work."
        options={[
          { value: '', label: 'Not tied to a session' },
          ...sessions.map((s) => ({
            value: s.sessionId,
            label: `${s.title} · ${s.ownerName ?? 'unknown owner'}`,
          })),
        ]}
      />
    </FormDialog>
  );
}

export function NewThreadDialog({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated: (t: ThreadSummary) => void;
}) {
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState('');
  const form = useSubmit(
    () =>
      apiPost<ThreadSummary>(`/api/projects/${encodeURIComponent(projectId)}/threads`, {
        title: title.trim(),
      }),
    onCreated,
  );
  return (
    <FormDialog
      onClose={onClose}
      title="New thread"
      description="A thread is a durable line of work: one writer session at a time, rolled over to a fresh session at clean task boundaries."
      submitLabel="Create thread"
      busyLabel="Creating…"
      busy={form.busy}
      canSubmit={title.trim().length > 0}
      message={form.message}
      onSubmit={form.submit}
      initialFocus={titleRef}
    >
      <TextField
        ref={titleRef}
        label="Title"
        required
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        error={form.fields.title}
      />
    </FormDialog>
  );
}
