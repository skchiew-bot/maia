import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import {
  BLIND_AFFIRM_DWELL_MS,
  type ChangeFieldDTO,
  type ChangeRequestDTO,
  type PinListDTO,
} from '@aoc/contracts';
import { apiPost } from '../../api/client';
import { Badge } from '../../components/Badge';
import { Button } from '../../components/Button';
import { InlineAlert, describeError } from '../../components/EmptyState';
import { TextArea } from '../../components/Field';
import { RelativeTime } from '../../components/RelativeTime';
import { useToast } from '../../components/Toast';
import type { Tone } from '../../components/tone';
import type { IconName } from '../../components/Icon';
import { useClock, type Clock } from '../../lib/clock';
import { cx } from '../../lib/dom';
import { formatDuration, formatPercent } from '../../lib/format';
import { PersonName } from '../audit/people';
import { RefValue } from './bits';
import { FIELD_META, authorship, fieldState, hasAiDraft, type FieldState } from './model';
import { RollbackTargetPicker } from './RollbackTargetPicker';

const STATE_BADGE: Record<FieldState, { label: string; tone: Tone; icon: IconName }> = {
  pending: { label: 'Not affirmed', tone: 'neutral', icon: 'clock' },
  edited: { label: 'Edited and affirmed', tone: 'ok', icon: 'ok' },
  affirmed: { label: 'Affirmed', tone: 'ok', icon: 'ok' },
  blind: { label: 'Blind confirm', tone: 'warn', icon: 'warn' },
  erased: { label: '[erased]', tone: 'neutral', icon: 'minus' },
};

/**
 * Review dwell for the blind-confirm rule (§14): the clock starts when the field is first on screen (or
 * focused), not when the page loaded, so scrolling past three fields does not count as reading the fourth.
 */
function useDwell(ref: RefObject<HTMLElement | null>, active: boolean, clock: Clock) {
  const start = useRef<number | null>(null);
  useEffect(() => {
    if (!active) return undefined;
    start.current = null;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      start.current = clock.now();
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (start.current === null && entries.some((e) => e.isIntersecting)) {
          start.current = clock.now();
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [active, clock, ref]);
  return {
    mark: () => {
      if (start.current === null) start.current = clock.now();
    },
    elapsed: () => (start.current === null ? 0 : Math.max(0, clock.now() - start.current)),
  };
}

export interface FieldCardProps {
  change: ChangeRequestDTO;
  field: ChangeFieldDTO;
  /** Draft record and the viewer may act on it (owner or Approver). */
  editable: boolean;
  /** Pinned states of the project, for the rollback plan's target. */
  pins?: PinListDTO;
  onSaved: (change: ChangeRequestDTO) => void;
}

export function FieldCard({ change, field, editable, pins, onSaved }: FieldCardProps) {
  const meta = FIELD_META[field.field];
  const state = fieldState(field, change.erased);
  const badge = STATE_BADGE[state];
  const who = authorship(change, field);
  const isRollback = field.field === 'rollbackPlan';
  const ai = hasAiDraft(change, field);
  const titleId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const clock = useClock();
  const toast = useToast();

  const stored = field.value ?? field.draft ?? '';
  const [editing, setEditing] = useState(editable && !field.affirmed);
  const [text, setText] = useState(stored);
  const [target, setTarget] = useState(change.rollbackRef ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const dwell = useDwell(cardRef, editable && editing, clock);

  // A refetch after someone else's edit replaces the baseline unless this card holds unsaved text.
  useEffect(() => {
    if (!busy) {
      setText((t) => (t.trim() === '' || !editing ? stored : t));
      setTarget((t) => t || change.rollbackRef || '');
    }
    if (!editable) setEditing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, change.rollbackRef, editable]);

  const changed = text.trim() !== stored.trim() || (isRollback && target !== (change.rollbackRef ?? ''));
  const missing = !text.trim()
    ? 'Write this field before affirming it.'
    : isRollback && !target
      ? 'Pick the exact tag or commit to return to.'
      : null;

  const save = async () => {
    if (missing) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await apiPost<ChangeRequestDTO & { affirmation?: { blind: boolean; edited: boolean } }>(
        `/api/changes/${encodeURIComponent(change.changeId)}/fields/${field.field}`,
        {
          value: text.trim(),
          dwellMs: Math.round(dwell.elapsed()),
          ...(isRollback ? { rollbackRef: target } : {}),
        },
      );
      setEditing(false);
      onSaved(res);
      if (res.affirmation?.blind)
        toast.notify({
          tone: 'warn',
          title: `${meta.label} recorded as a blind one-click confirm`,
          body: `It was affirmed without an edit within ${formatDuration(BLIND_AFFIRM_DWELL_MS)} of being shown (§14).`,
        });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      ref={cardRef}
      className={cx('changes-field', `is-${state}`, editing && 'is-editing')}
      aria-labelledby={titleId}
      onFocusCapture={dwell.mark}
    >
      <header className="changes-field__head">
        <h3 id={titleId} className="changes-field__title">
          {meta.label}
        </h3>
        <Badge tone={badge.tone} icon={badge.icon}>
          {badge.label}
        </Badge>
      </header>

      {editing ? (
        <div className="changes-field__edit">
          {ai && !field.affirmed && (
            <p className="changes-field__note">
              Pre-filled with the AI draft. Edit it, or read it and affirm it as written.
            </p>
          )}
          <TextArea
            label={meta.label}
            fieldClassName="changes-field__textarea"
            hint={meta.prompt}
            value={text}
            rows={isRollback ? 3 : 4}
            maxLength={8000}
            onChange={(e) => setText(e.target.value)}
          />
          {isRollback && (
            <RollbackTargetPicker
              label="Return to (exact tag or commit)"
              pins={pins}
              includeHead
              value={target}
              onChange={setTarget}
            />
          )}
          {error !== undefined && (
            <InlineAlert tone="danger" title={`${meta.label} was not saved`} live>
              {describeError(error)}
            </InlineAlert>
          )}
          <div className="changes-field__actions">
            <Button
              variant={changed ? 'primary' : 'secondary'}
              size="sm"
              icon="check"
              disabled={!!missing}
              loading={busy}
              loadingText="Saving…"
              onClick={() => void save()}
            >
              {changed ? 'Save and affirm' : 'Affirm as written'}
            </Button>
            {field.affirmed && (
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </Button>
            )}
            <span className="changes-field__hint">
              {missing ??
                (ai && !changed
                  ? `Affirming a draft without an edit within ${formatDuration(BLIND_AFFIRM_DWELL_MS)} is flagged.`
                  : '')}
            </span>
          </div>
        </div>
      ) : (
        <>
          {state === 'erased' ? (
            <p className="changes-field__value changes-field__value--erased">
              [erased] — the text was crypto-shredded; its hash stays in the chain.
            </p>
          ) : stored ? (
            <p className="changes-field__value">{stored}</p>
          ) : (
            <p className="changes-field__value changes-field__value--empty">Not written yet.</p>
          )}
          {isRollback && (
            <p className="changes-field__target">
              <span>Returns to</span>
              {change.rollbackRef ? (
                <RefValue refName={change.rollbackRef} sha={change.rollbackSha} label="rollback target" />
              ) : (
                <span className="changes-muted">no target named yet</span>
              )}
            </p>
          )}
        </>
      )}

      <dl className="changes-field__facts">
        <div>
          <dt>Written by</dt>
          <dd>
            {who.wrote === 'ai' ? (
              'AI draft'
            ) : who.wrote === 'developer' && field.affirmedBy ? (
              <PersonName id={field.affirmedBy} />
            ) : (
              '—'
            )}
            <span className="changes-field__sub">{who.summary}</span>
          </dd>
        </div>
        <div>
          <dt>Affirmed by</dt>
          <dd>
            {field.affirmedBy ? (
              <>
                <PersonName id={field.affirmedBy} />
                {field.affirmedAt && (
                  <span className="changes-field__sub">
                    <RelativeTime value={field.affirmedAt} suffix=" ago" />
                  </span>
                )}
              </>
            ) : (
              <span className="changes-muted">not yet</span>
            )}
          </dd>
        </div>
        {field.affirmed && field.dwellMs !== null && (
          <div>
            <dt>Reviewed for</dt>
            <dd className="aoc-num">
              {formatDuration(field.dwellMs)}
              {field.blind && (
                <span className="changes-field__sub">
                  below the {formatDuration(BLIND_AFFIRM_DWELL_MS)} threshold
                </span>
              )}
            </dd>
          </div>
        )}
        {field.affirmed && ai && field.editRatio !== null && (
          <div>
            <dt>Changed from the AI draft</dt>
            <dd className="aoc-num">{formatPercent(field.editRatio)}</dd>
          </div>
        )}
      </dl>

      {!editing && ai && field.edited && field.draft && (
        <details className="changes-field__draft">
          <summary>Show the AI draft it replaced</summary>
          <p>{field.draft}</p>
        </details>
      )}
      {!editing && editable && (
        <div className="changes-field__actions">
          <Button size="sm" variant="ghost" icon="changes" onClick={() => setEditing(true)}>
            {field.affirmed ? 'Edit again' : 'Edit or affirm'}
          </Button>
        </div>
      )}
    </section>
  );
}
