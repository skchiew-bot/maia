import type { PublicTicket } from '@aoc/contracts';
import { useRef, useState, type FormEvent } from 'react';
import { ApiError, apiPost } from '../../api/client';
import { Button, Icon, InlineAlert, TextArea } from '../../components';
import { cx } from '../../lib/dom';
import { portalErrorMessage } from './model';

export type Verdict = 'pass' | 'fail';

/** The server's limit on a test comment. */
export const VERDICT_COMMENT_MAX = 4000;
const FAIL_COMMENT_MIN = 5;

/** Confirmation after an answer is recorded. */
export const THANKS: Record<Verdict, string> = {
  pass: 'Thanks for confirming the fix works. We will finish up and mark this request completed here.',
  fail: 'Thanks for telling us. We will look at it again and ask you to test here once there is a new fix.',
};

export interface UatSignoffProps {
  ticket: PublicTicket;
  /** Only the person who reported the problem can answer (the server enforces this too). */
  canAnswer: boolean;
  /** The answer was recorded: the server's updated view and what the requester said. */
  onAnswered: (ticket: PublicTicket, verdict: Verdict) => void;
  /** The request is no longer waiting for an answer (answered elsewhere, or it moved on): reload it. */
  onStale: () => void;
}

/** "Does the fix work for you?" — accept, or reject with what is still wrong (POST /portal/api/tickets/:id/uat). */
export function UatSignoff({ ticket, canAnswer, onAnswered, onStale }: UatSignoffProps) {
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!verdict || busy) {
      if (!verdict) setError('Choose whether the fix works for you.');
      return;
    }
    const text = comment.trim();
    if (verdict === 'fail' && text.length < FAIL_COMMENT_MIN) {
      setCommentError('Tell us what is still wrong, so we know what to look at.');
      commentRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await apiPost<PublicTicket>(`/portal/api/tickets/${encodeURIComponent(ticket.ticketId)}/uat`, {
        verdict,
        ...(text ? { comment: text } : {}),
      });
      onAnswered(updated, verdict);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_ready') {
        setError('This request is no longer waiting for your testing. We have refreshed the page.');
        onStale();
      } else {
        setError(portalErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="portal-signoff" onSubmit={onSubmit} noValidate aria-labelledby="signoff-title">
      <h2 id="signoff-title" className="portal-signoff__title">
        Does the fix work for you?
      </h2>
      {!canAnswer ? (
        <p className="portal-signoff__note">Only the person who reported this problem can confirm the fix.</p>
      ) : (
        <>
          <fieldset className="portal-signoff__choices" disabled={busy}>
            <legend className="aoc-sr-only">Your answer</legend>
            <ChoiceCard
              value="pass"
              selected={verdict === 'pass'}
              onSelect={() => {
                setVerdict('pass');
                setError(null);
                setCommentError(undefined);
              }}
              title="Yes, it works"
              hint="We will finish up and mark your request completed."
              icon="ok"
            />
            <ChoiceCard
              value="fail"
              selected={verdict === 'fail'}
              onSelect={() => {
                setVerdict('fail');
                setError(null);
              }}
              title="No, there is still a problem"
              hint="Tell us what is still wrong and we will look again."
              icon="danger"
            />
          </fieldset>
          {verdict && (
            <TextArea
              ref={commentRef}
              label={verdict === 'fail' ? 'What is still wrong?' : 'Anything you would like to add?'}
              hint={verdict === 'fail' ? 'What did you try, and what happened?' : 'Optional.'}
              required={verdict === 'fail'}
              rows={3}
              maxLength={VERDICT_COMMENT_MAX}
              value={comment}
              error={commentError}
              disabled={busy}
              onChange={(e) => {
                setComment(e.target.value);
                setCommentError(undefined);
              }}
            />
          )}
          {error && (
            <InlineAlert tone="danger" live>
              {error}
            </InlineAlert>
          )}
          <div className="portal-signoff__actions">
            <Button type="submit" variant="primary" loading={busy} loadingText="Sending…">
              Send my answer
            </Button>
          </div>
        </>
      )}
    </form>
  );
}

function ChoiceCard({
  value,
  selected,
  onSelect,
  title,
  hint,
  icon,
}: {
  value: Verdict;
  selected: boolean;
  onSelect: () => void;
  title: string;
  hint: string;
  icon: 'ok' | 'danger';
}) {
  return (
    <label className={cx('portal-option', 'portal-choice', `portal-choice--${value}`, selected && 'is-selected')}>
      <input type="radio" name="verdict" value={value} checked={selected} onChange={onSelect} />
      <span className="portal-choice__icon" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <span className="portal-option__body">
        <span className="portal-option__word">{title}</span>
        <span className="portal-option__hint">{hint}</span>
      </span>
    </label>
  );
}
