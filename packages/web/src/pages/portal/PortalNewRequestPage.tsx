import type { Severity } from '@aoc/contracts';
import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../api/auth';
import { Button, Icon, PageHeader, TextArea, TextField } from '../../components';
import { AttachmentPicker } from './AttachmentPicker';
import { canUsePortal, useIntakeLimits } from './hooks';
import { SEVERITY_META, SEVERITY_ORDER } from './model';
import { BuilderNotice } from './notices';
import { sendIntake, type UploadHandle, type UploadProgress } from './sendIntake';
import { useAttachments } from './useAttachments';
import { describeSubmitError, formatBytes, type SubmitField } from './uploads';
import './portal.css';

const DRAFT_KEY = 'aoc.portal.draft';
const COMMENT_MAX = 20_000;

interface Draft {
  title: string;
  description: string;
  severity: Severity;
  comment: string;
}

const EMPTY: Draft = { title: '', description: '', severity: 'medium', comment: '' };

/** Text fields survive a sign-out or an accidental reload in this tab (files cannot be kept). */
function readDraft(): Draft {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return EMPTY;
    const d = JSON.parse(raw) as Partial<Draft>;
    return {
      title: typeof d.title === 'string' ? d.title : '',
      description: typeof d.description === 'string' ? d.description : '',
      severity: SEVERITY_ORDER.includes(d.severity as Severity) ? (d.severity as Severity) : 'medium',
      comment: typeof d.comment === 'string' ? d.comment : '',
    };
  } catch {
    return EMPTY;
  }
}

function writeDraft(d: Draft | null): void {
  try {
    if (d) window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // A convenience only.
  }
}

type Problems = Partial<Record<SubmitField | 'files', string>>;

/** New request: what went wrong, how much it hurts, and screenshots or a recording (§7). */
export default function PortalNewRequestPage() {
  const { user } = useAuth();
  const allowed = canUsePortal(user);
  const limits = useIntakeLimits(allowed);
  const navigate = useNavigate();
  const attachments = useAttachments(limits);
  const [draft, setDraft] = useState<Draft>(readDraft);
  const [problems, setProblems] = useState<Problems>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const upload = useRef<UploadHandle | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const severityRef = useRef<HTMLInputElement>(null);
  const filesRef = useRef<HTMLDivElement>(null);
  const sending = progress !== null;

  useEffect(() => {
    writeDraft(draft.title || draft.description || draft.comment ? draft : null);
  }, [draft]);
  useEffect(() => () => upload.current?.abort(), []);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    if (key !== 'comment') setProblems((p) => ({ ...p, [key]: undefined }));
  };

  if (!allowed && user) {
    return (
      <div className="portal-page">
        <PageHeader title="New request" breadcrumbs={[{ label: 'My requests', to: '/portal' }, { label: 'New request' }]} />
        <BuilderNotice user={user} />
      </div>
    );
  }

  const validate = (): Problems => {
    const p: Problems = {};
    const title = draft.title.trim();
    const description = draft.description.trim();
    if (title.length < limits.titleLength.min)
      p.title = `Add a short summary of what went wrong (at least ${limits.titleLength.min} characters).`;
    else if (title.length > limits.titleLength.max)
      p.title = `Keep the summary under ${limits.titleLength.max} characters; put the details below.`;
    if (description.length < limits.descriptionLength.min)
      p.description = `Describe what happened in at least ${limits.descriptionLength.min} characters.`;
    else if (description.length > limits.descriptionLength.max)
      p.description = `Keep the description under ${limits.descriptionLength.max.toLocaleString('en-US')} characters.`;
    if (attachments.pending) p.files = 'Wait a moment: we are still checking your files.';
    else if (attachments.items.some((a) => a.refused || (a.check && !a.check.ok)))
      p.files = 'Remove or replace the files marked below.';
    else if (attachments.selectionProblem) p.files = attachments.selectionProblem;
    return p;
  };

  const focusSummary = () => requestAnimationFrame(() => summaryRef.current?.focus());

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (sending) return;
    const found = validate();
    setProblems(found);
    setFailure(null);
    if (Object.values(found).some(Boolean)) {
      focusSummary();
      return;
    }
    const body = new FormData();
    body.set('title', draft.title.trim());
    body.set('description', draft.description.trim());
    body.set('severity', draft.severity);
    if (draft.comment.trim()) body.set('comment', draft.comment.trim());
    const files = attachments.items.map((a) => a.file);
    for (const f of files) body.append('files', f, f.name);

    setProgress({ loaded: 0, total: attachments.totalBytes });
    const handle = sendIntake(body, setProgress);
    upload.current = handle;
    try {
      const ticket = await handle.promise;
      writeDraft(null);
      navigate(`/portal/tickets/${encodeURIComponent(ticket.ticketId)}`, { state: { sent: true } });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setFailure('Sending was cancelled. Nothing was sent, and your request is still here.');
      } else {
        const problem = describeSubmitError(err, files, limits);
        if (problem.fileIndex !== undefined) attachments.markRefused(problem.fileIndex, problem.message);
        if (problem.field) setProblems({ [problem.field]: problem.message });
        setFailure(
          problem.signedOut
            ? `${problem.message} Your text is kept in this tab; attach your files again after signing in.`
            : problem.message,
        );
      }
      focusSummary();
    } finally {
      upload.current = null;
      setProgress(null);
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLFormElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (!files.length || sending) return;
    e.preventDefault();
    attachments.add(files);
  };

  const listed: { key: keyof Problems; message: string; target: RefObject<HTMLElement | null> }[] = (
    [
      ['title', titleRef],
      ['description', descriptionRef],
      ['severity', severityRef],
      ['files', filesRef],
    ] as const
  )
    .filter(([key]) => problems[key])
    .map(([key, target]) => ({ key, message: problems[key]!, target }));

  return (
    <div className="portal-page">
      <PageHeader
        title="New request"
        subtitle="Tell us what went wrong. A screenshot or a short screen recording helps us most."
        breadcrumbs={[{ label: 'My requests', to: '/portal' }, { label: 'New request' }]}
      />
      <div className="portal-new">
        <form className="portal-card portal-form" onSubmit={onSubmit} onPaste={onPaste} noValidate aria-label="New request">
          {(listed.length > 0 || failure) && (
            <div ref={summaryRef} className="portal-summary" role="alert" tabIndex={-1}>
              <p className="portal-summary__title">
                <Icon name="danger" size={16} />
                {failure ? 'Your request wasn’t sent' : 'Check your request before sending'}
              </p>
              {failure && <p className="portal-summary__text">{failure}</p>}
              {listed.length > 0 && (
                <ul className="portal-summary__list">
                  {listed.map((p) => (
                    <li key={p.key}>
                      <button type="button" className="aoc-link-button" onClick={() => p.target.current?.focus()}>
                        {p.message}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <fieldset className="portal-form__fields" disabled={sending}>
            <TextField
              ref={titleRef}
              label="What went wrong?"
              hint="A short summary, e.g. “Claim form goes blank after I attach a PDF”."
              required
              name="title"
              autoComplete="off"
              maxLength={limits.titleLength.max}
              value={draft.title}
              error={problems.title}
              onChange={(e) => set('title', e.target.value)}
            />
            <TextArea
              ref={descriptionRef}
              label="What happened?"
              hint="What were you doing, what did you expect, and what happened instead?"
              required
              name="description"
              rows={6}
              maxLength={limits.descriptionLength.max}
              value={draft.description}
              error={problems.description}
              onChange={(e) => set('description', e.target.value)}
            />
            <fieldset className="portal-field portal-severity" aria-describedby={problems.severity ? 'severity-error' : undefined}>
              <legend className="aoc-field__label">How much is this affecting you?</legend>
              <div className="portal-severity__options">
                {SEVERITY_ORDER.map((s, i) => (
                  <label key={s} className="portal-option">
                    <input
                      ref={i === 0 ? severityRef : undefined}
                      type="radio"
                      name="severity"
                      value={s}
                      checked={draft.severity === s}
                      onChange={() => set('severity', s)}
                    />
                    <span className="portal-option__body">
                      <span className="portal-option__word">{SEVERITY_META[s].word}</span>
                      <span className="portal-option__hint">{SEVERITY_META[s].hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              {problems.severity && (
                <p id="severity-error" className="aoc-field__error">
                  <Icon name="danger" size={12} />
                  {problems.severity}
                </p>
              )}
            </fieldset>
            <div ref={filesRef} tabIndex={-1} className="portal-form__files">
              <AttachmentPicker attachments={attachments} limits={limits} disabled={sending} />
            </div>
            <TextArea
              label="Anything else we should know?"
              hint="Optional: when it started, how often it happens, who else is affected."
              name="comment"
              rows={3}
              maxLength={COMMENT_MAX}
              value={draft.comment}
              onChange={(e) => set('comment', e.target.value)}
            />
          </fieldset>
          {progress ? (
            <SendingPanel progress={progress} onCancel={() => upload.current?.abort()} />
          ) : (
            <div className="portal-form__actions">
              <Button type="submit" variant="primary" icon="upload" className="portal-form__send">
                Send request
              </Button>
              <p className="portal-form__privacy">
                Your files are stored encrypted and opened only by the people working on your request.
              </p>
            </div>
          )}
        </form>
        <NextSteps />
      </div>
    </div>
  );
}

/** Upload progress with a coarse spoken update (every quarter) so screen readers are not flooded. */
function SendingPanel({ progress, onCancel }: { progress: UploadProgress; onCancel: () => void }) {
  const ratio = progress.total > 0 ? Math.min(1, progress.loaded / progress.total) : 0;
  const pct = Math.round(ratio * 100);
  const done = progress.total > 0 && progress.loaded >= progress.total;
  return (
    <div className="portal-sending">
      <p className="portal-sending__text">
        <span>{done ? 'Checking your files…' : 'Sending your request…'}</span>
        <span className="aoc-num">
          {pct}%
          {progress.total > 0 && (
            <span className="portal-sending__bytes">
              {' '}
              · {formatBytes(progress.loaded)} of {formatBytes(progress.total)}
            </span>
          )}
        </span>
      </p>
      <div
        className="portal-sending__track"
        role="progressbar"
        aria-label="Sending your request"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${pct}%`}
      >
        <div className="portal-sending__fill" style={{ width: `${pct}%` }} />
      </div>
      <p className="aoc-sr-only" aria-live="polite">
        {done ? 'Upload finished, checking your files.' : `${Math.floor(pct / 25) * 25}% sent`}
      </p>
      <Button onClick={onCancel} disabled={done}>
        Cancel
      </Button>
    </div>
  );
}

function NextSteps() {
  return (
    <aside className="portal-card portal-next" aria-labelledby="next-steps-title">
      <h2 id="next-steps-title" className="portal-next__title">
        What happens next
      </h2>
      <ol className="portal-next__list">
        <li>
          <strong>We look into it.</strong> Your request goes to the people who can fix it. You can follow it under My
          requests.
        </li>
        <li>
          <strong>You test the fix.</strong> When a fix is ready, we ask you to try it and tell us whether it works.
        </li>
        <li>
          <strong>We finish up.</strong> Once you confirm, the fix goes live and your request is marked completed.
        </li>
      </ol>
    </aside>
  );
}
