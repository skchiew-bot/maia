import type { SessionDetail } from '@aoc/contracts';
import { useId, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, apiPost } from '../../api/client';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { InlineAlert, describeError } from '../../components/EmptyState';
import { TextArea } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { formatClock } from '../../lib/format';
import { Glyph, type GlyphName } from './glyphs';
import { shortId } from './sessionText';

type ActionId = keyof SessionDetail['actions'];

export const ACTION_ENDPOINT = {
  nudge: (id: string) => `/api/sessions/${encodeURIComponent(id)}/nudge`,
  prompt: (id: string) => `/api/sessions/${encodeURIComponent(id)}/prompt`,
  restart: (id: string) => `/api/sessions/${encodeURIComponent(id)}/restart`,
  stop: (id: string) => `/api/sessions/${encodeURIComponent(id)}/stop`,
  rollover: (threadId: string) => `/api/threads/${encodeURIComponent(threadId)}/rollover`,
};

const ACTION_META: Record<ActionId, { label: string; glyph: GlyphName; help: string }> = {
  nudge: { label: 'Nudge…', glyph: 'message', help: 'ends the current turn and resumes with your note.' },
  prompt: { label: 'Send prompt…', glyph: 'message', help: 'starts the next turn with your text (the session is idle).' },
  restart: { label: 'Restart', glyph: 'restart', help: 'relaunches from the transcript with --resume.' },
  stop: { label: 'Stop…', glyph: 'stop', help: 'ends the session at the next task boundary, or now.' },
  rollover: { label: 'Roll over', glyph: 'rollover', help: 'hands the thread to a fresh session at a clean boundary.' },
};

const MAX_TEXT = 20_000;

/** A server reason as a sentence: capitalised, with exactly one closing period. */
function sentence(reason: string): string {
  const t = reason.trim().replace(/[.\s]+$/, '');
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}.` : '';
}

/** The single reason when every action is off for the same cause (observed, not yours, ended). */
export function sharedBlock(actions: SessionDetail['actions']): string | null {
  const reasons = Object.values(actions).map((a) => (a.enabled ? null : a.reason));
  return reasons.every((r) => r !== null && r === reasons[0]) ? reasons[0]! : null;
}

function rolloverProblems(err: unknown): string[] | null {
  if (!(err instanceof ApiError) || err.code !== 'rollover_refused') return null;
  const problems = (err.details as { problems?: unknown } | undefined)?.problems;
  return Array.isArray(problems) ? problems.map(String) : [];
}

export interface OperatorActionsProps {
  session: SessionDetail;
  /** A stop already requested and not yet honoured (from the session's events). */
  pendingStop?: { at: string; immediate: boolean } | null;
  /**
   * The thread's current writer session, when the ledger knows it. Rollover acts on the thread's writer, so it
   * is offered only on that session's page.
   */
  threadWriter?: string | null;
  /** Refetch the session after an action (the stream also brings the resulting events). */
  onDone: () => void;
}

/** The daemon's actions, with rollover narrowed to the thread's writer session. */
export function effectiveActions(session: SessionDetail, threadWriter: string | null | undefined): SessionDetail['actions'] {
  if (!threadWriter || threadWriter === session.sessionId || !session.actions.rollover.enabled) return session.actions;
  return {
    ...session.actions,
    rollover: { enabled: false, reason: 'Another session is this thread\'s writer; roll over from that session' },
  };
}

/**
 * Operator actions for a managed session (§2.3): nudge, prompt, restart, stop, roll over. What is allowed comes
 * from the daemon's `actions` for this viewer; the server enforces it again on every request.
 */
export function OperatorActions({ session, pendingStop, threadWriter, onDone }: OperatorActionsProps) {
  const headingId = useId();
  const [open, setOpen] = useState<ActionId | null>(null);
  const actions = effectiveActions(session, threadWriter);
  const blocked = sharedBlock(actions);
  const visible: ActionId[] = ['nudge', 'restart', 'stop', 'rollover'];
  if (actions.prompt.enabled) visible.splice(1, 0, 'prompt');

  return (
    <section className="session-ops" aria-labelledby={headingId}>
      <h2 id={headingId} className="session-ops__title">
        Operator actions
      </h2>
      {pendingStop && !blocked && (
        <p className="session-ops__pending" role="status">
          <Glyph name="stop" size={14} />
          <span>
            Stop requested {formatClock(pendingStop.at)}:{' '}
            {pendingStop.immediate ? 'interrupting the current turn.' : 'the session ends at its next task boundary.'}
          </span>
        </p>
      )}
      {blocked ? (
        <p className="session-ops__blocked">
          {session.mode === 'observed' ? <Icon name="eye" size={14} /> : <Glyph name="lock" size={14} />}
          <span>{blocked}.</span>
        </p>
      ) : (
        <>
          <div className="session-ops__btns">
            {visible.map((id) => (
              <Button
                key={id}
                size="sm"
                disabled={!actions[id].enabled}
                onClick={() => setOpen(id)}
                aria-describedby={`${headingId}-${id}`}
              >
                <Glyph name={ACTION_META[id].glyph} size={14} />
                {ACTION_META[id].label}
              </Button>
            ))}
          </div>
          <ul className="session-ops__help">
            {visible.map((id) => {
              const a = actions[id];
              const word = ACTION_META[id].label.replace('…', '');
              return (
                <li key={id} id={`${headingId}-${id}`} className={a.enabled ? undefined : 'is-blocked'}>
                  {a.enabled ? (
                    <>
                      <strong>{word}</strong> {ACTION_META[id].help}
                    </>
                  ) : (
                    <>
                      <Glyph name="lock" size={12} />
                      <span>
                        <strong>{word}</strong> is unavailable. {sentence(a.reason ?? 'Not allowed right now')}
                      </span>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
      {(open === 'nudge' || open === 'prompt') && (
        <TextActionDialog kind={open} session={session} onClose={() => setOpen(null)} onDone={onDone} />
      )}
      {open === 'restart' && <RestartDialog session={session} onClose={() => setOpen(null)} onDone={onDone} />}
      {open === 'stop' && <StopDialog session={session} onClose={() => setOpen(null)} onDone={onDone} />}
      {open === 'rollover' && <RolloverDialog session={session} onClose={() => setOpen(null)} onDone={onDone} />}
    </section>
  );
}

interface DialogProps {
  session: SessionDetail;
  onClose: () => void;
  onDone: () => void;
}

/** Runs one request with a busy flag and an error; returns true on success. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function ErrorLine({ error, title }: { error: unknown; title: string }) {
  if (error === null) return null;
  const holder =
    error instanceof ApiError && error.code === 'writer_locked'
      ? (error.details as { holderSessionId?: unknown } | undefined)?.holderSessionId
      : undefined;
  if (typeof holder === 'string') {
    return (
      <InlineAlert tone="warn" title={title} live>
        Another session is this thread’s writer:{' '}
        <Link to={`/sessions/${encodeURIComponent(holder)}`}>{shortId(holder)}</Link>. One writer per thread (§5): stop or
        finish that session first.
      </InlineAlert>
    );
  }
  return (
    <InlineAlert tone="danger" title={title} live>
      {describeError(error)}
    </InlineAlert>
  );
}

function TextActionDialog({ kind, session, onClose, onDone }: DialogProps & { kind: 'nudge' | 'prompt' }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [touched, setTouched] = useState(false);
  const { busy, error, run } = useAction();
  const trimmed = text.trim();
  const invalid = trimmed.length === 0 ? 'Write the note the agent should act on.' : text.length > MAX_TEXT ? `Keep it under ${MAX_TEXT.toLocaleString('en-US')} characters.` : null;
  const nudge = kind === 'nudge';

  const submit = async () => {
    setTouched(true);
    if (invalid) return;
    const ok = await run(() => apiPost(ACTION_ENDPOINT[kind](session.sessionId), { text: trimmed }));
    if (!ok) return;
    toast.notify({
      tone: 'ok',
      title: nudge ? 'Nudge sent' : 'Prompt sent',
      body: nudge ? 'The current turn ends and the session resumes with your note.' : 'The next turn starts with your text.',
    });
    onDone();
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={nudge ? 'Nudge this session' : 'Send a prompt'}
      description={
        nudge
          ? 'The supervisor ends the current turn and resumes the session with your note. The note goes to the encrypted body store; the audit chain keeps only its hash.'
          : 'The session is idle: your text starts its next turn. It goes to the encrypted body store; the audit chain keeps only its hash.'
      }
      dismissOnBackdrop={false}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} loadingText="Sending…" onClick={() => void submit()}>
            {nudge ? 'Send nudge' : 'Send prompt'}
          </Button>
        </>
      }
    >
      <form
        className="session-dialog__form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <TextArea
          label={nudge ? 'Note to the agent' : 'Prompt'}
          required
          rows={5}
          value={text}
          maxLength={MAX_TEXT}
          onChange={(e) => setText(e.target.value)}
          error={touched && invalid ? invalid : undefined}
          hint={`${text.length.toLocaleString('en-US')} / ${MAX_TEXT.toLocaleString('en-US')} characters`}
        />
        <ErrorLine error={error} title={nudge ? 'Nudge not sent' : 'Prompt not sent'} />
      </form>
    </Dialog>
  );
}

function RestartDialog({ session, onClose, onDone }: DialogProps) {
  const toast = useToast();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { busy, error, run } = useAction();
  const submit = async () => {
    const ok = await run(() => apiPost(ACTION_ENDPOINT.restart(session.sessionId)));
    if (!ok) return;
    toast.notify({ tone: 'ok', title: 'Restart requested', body: 'The supervisor relaunches the session from its transcript.' });
    onDone();
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      size="sm"
      title="Restart this session?"
      description="The supervisor relaunches it with --resume from its transcript. Work already closed with evidence stays closed."
      initialFocus={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} loadingText="Restarting…" onClick={() => void submit()}>
            Restart
          </Button>
        </>
      }
    >
      <ErrorLine error={error} title="Not restarted" />
    </Dialog>
  );
}

function StopDialog({ session, onClose, onDone }: DialogProps) {
  const toast = useToast();
  const name = useId();
  const [immediate, setImmediate] = useState(false);
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  const submit = async () => {
    const body: { immediate: boolean; reason?: string } = { immediate };
    if (reason.trim()) body.reason = reason.trim();
    const ok = await run(() => apiPost(ACTION_ENDPOINT.stop(session.sessionId), body));
    if (!ok) return;
    toast.notify({
      tone: 'ok',
      title: immediate ? 'Stop requested now' : 'Stop requested at the next task boundary',
      body: immediate ? 'The current turn is interrupted.' : 'The session finishes its current task, then stops.',
    });
    onDone();
    onClose();
  };
  const option = (value: boolean, title: string, body: ReactNode) => (
    <label className="session-choice">
      <input type="radio" name={name} checked={immediate === value} onChange={() => setImmediate(value)} />
      <span>
        <strong>{title}</strong>
        <span className="session-choice__body">{body}</span>
      </span>
    </label>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title="Stop this session"
      description="By default the session stops at its next task boundary, so no task is left half-done."
      dismissOnBackdrop={false}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={busy} loadingText="Stopping…" onClick={() => void submit()}>
            {immediate ? 'Stop now' : 'Stop at boundary'}
          </Button>
        </>
      }
    >
      <fieldset className="session-choices">
        <legend className="aoc-sr-only">When to stop</legend>
        {option(false, 'At the next task boundary', 'Recommended. The agent closes its current task with evidence, then the session ends.')}
        {option(true, 'Now', 'Interrupts the current turn. The task in progress stays open for a later session.')}
      </fieldset>
      <TextArea
        label="Reason (optional)"
        rows={2}
        value={reason}
        maxLength={2000}
        onChange={(e) => setReason(e.target.value)}
        hint="Kept in the encrypted body store with the stop request."
      />
      <ErrorLine error={error} title="Not stopped" />
    </Dialog>
  );
}

function RolloverDialog({ session, onClose, onDone }: DialogProps) {
  const toast = useToast();
  const navigate = useNavigate();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { busy, error, run } = useAction();
  const problems = rolloverProblems(error);
  const submit = async () => {
    if (!session.threadId) return;
    let r: { newSessionId?: string } | undefined;
    const ok = await run(async () => {
      r = await apiPost<{ newSessionId?: string }>(ACTION_ENDPOINT.rollover(session.threadId!));
    });
    if (!ok) return;
    onDone();
    if (r?.newSessionId) {
      toast.notify({
        tone: 'ok',
        title: 'Rolled over to a fresh session',
        action: { label: 'Open it', onClick: () => navigate(`/sessions/${encodeURIComponent(r!.newSessionId!)}`) },
      });
    }
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      size="sm"
      title="Roll this thread over?"
      description="The supervisor distils a handoff brief (manifest status, key decisions, file pointers), validates it against the manifest and open decisions, then launches a fresh session. This one retires. One writer per thread, never mid-task (§5)."
      initialFocus={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} loadingText="Rolling over…" disabled={!session.threadId} onClick={() => void submit()}>
            Roll over
          </Button>
        </>
      }
    >
      {problems ? (
        <InlineAlert tone="warn" title="Rollover refused" live>
          {problems.length ? (
            <ul className="session-dialog__problems">
              {problems.map((p) => (
                <li key={p}>{p.replace(/_/g, ' ')}</li>
              ))}
            </ul>
          ) : (
            'The brief did not validate against the manifest.'
          )}
        </InlineAlert>
      ) : (
        <ErrorLine error={error} title="Not rolled over" />
      )}
    </Dialog>
  );
}
