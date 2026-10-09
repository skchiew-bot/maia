import { useEffect, useId, useState, type FormEvent } from 'react';
import type { OffenceDTO } from '@aoc/contracts';
import { apiPost } from '../../api';
import { Button, Dialog, InlineAlert, TextArea, describeError, useToast } from '../../components';
import { STEP_ACTION, STATE_META, nextSteps, type HumanStep } from './model';

export interface TransitionDialogProps {
  /** The offence to move; `null` closes the dialog. */
  offence: OffenceDTO | null;
  /** Preselected step (when an offence allows two). */
  initialStep?: HumanStep;
  onClose: () => void;
  onDone: (updated: OffenceDTO) => void;
}

const MAX_TEXT = 4000;

/**
 * Moves a repeat offence one step: root-caused (what really causes it) or fix applied (the stated fix).
 * Verified closed is never set by hand — the daily job closes it after a full window without recurrence.
 */
export function TransitionDialog({ offence, initialStep, onClose, onDone }: TransitionDialogProps) {
  const steps = offence ? nextSteps(offence.state) : [];
  const [step, setStep] = useState<HumanStep | undefined>(undefined);
  const [note, setNote] = useState('');
  const [fix, setFix] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const [touched, setTouched] = useState(false);
  const toast = useToast();
  const groupId = useId();

  // Reset only when a different offence opens: `offence` itself refreshes live while the dialog is open.
  const offenceId = offence?.offenceId;
  const priorFix = offence?.fix ?? '';
  useEffect(() => {
    setStep(undefined);
    setNote('');
    setFix(priorFix);
    setError(undefined);
    setTouched(false);
    setBusy(false);
  }, [offenceId]);

  const current = step ?? (initialStep && steps.includes(initialStep) ? initialStep : steps[0]);
  const needsFix = current === 'fix_applied';
  const noteError = !needsFix && touched && note.trim().length < 3 ? 'Say what causes it (at least 3 characters).' : undefined;
  const fixError = needsFix && touched && fix.trim().length < 3 ? 'State the fix (at least 3 characters).' : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!offence || !current) return;
    if (needsFix ? fix.trim().length < 3 : note.trim().length < 3) return;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await apiPost<OffenceDTO>(
        `/api/learning/offences/${encodeURIComponent(offence.offenceId)}/transition`,
        {
          to: current,
          ...(note.trim() ? { note: note.trim() } : {}),
          ...(needsFix ? { fix: fix.trim() } : {}),
        },
      );
      toast.notify({
        tone: 'ok',
        title: `${STATE_META[current].label}: ${offence.className}`,
        body:
          current === 'fix_applied'
            ? 'It closes on its own if nothing recurs during the verification window.'
            : undefined,
      });
      onDone(updated);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={offence !== null && steps.length > 0}
      onClose={onClose}
      title={current ? `${STEP_ACTION[current]}` : 'Update repeat offence'}
      description={offence?.className}
      dismissOnBackdrop={false}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={`${groupId}-form`} loading={busy} loadingText="Saving…">
            {current ? STEP_ACTION[current] : 'Save'}
          </Button>
        </>
      }
    >
      <form id={`${groupId}-form`} className="learning-form" onSubmit={submit} noValidate>
        {steps.length > 1 && (
          <fieldset className="learning-form__choice">
            <legend>Next step</legend>
            {steps.map((s) => (
              <label key={s} className="learning-form__radio">
                <input
                  type="radio"
                  name={`${groupId}-step`}
                  value={s}
                  checked={current === s}
                  onChange={() => setStep(s)}
                />
                <span>
                  {STATE_META[s].label}
                  <span className="learning-form__radio-hint">
                    {s === 'fix_applied'
                      ? 'The cause is known and a fix is in place.'
                      : 'The cause is known; the fix is still to come.'}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {needsFix && (
          <TextArea
            label="Fix"
            required
            value={fix}
            maxLength={MAX_TEXT}
            onChange={(e) => setFix(e.target.value)}
            error={fixError}
            hint="What was changed so this class stops recurring: a spec rule, a guardrail, a code change or a model upgrade for one process type."
            rows={4}
          />
        )}
        <TextArea
          label={needsFix ? 'Note' : 'Root cause'}
          required={!needsFix}
          value={note}
          maxLength={MAX_TEXT}
          onChange={(e) => setNote(e.target.value)}
          error={noteError}
          hint={
            needsFix
              ? 'Optional context for the audit trail.'
              : 'Point at the cause, not the symptom: an ambiguous spec, a confusing codebase or a missing guardrail is common. Never a person.'
          }
          rows={3}
        />
        <p className="learning-form__aside">
          {needsFix
            ? 'Verified closed is automatic: it happens after a full verification window with no recurrence. A recurrence reopens the offence.'
            : 'Text is stored in the encrypted body store; only its hash is chained.'}
        </p>
        {error !== undefined && (
          <InlineAlert tone="danger" title="Not saved" live>
            {describeError(error)}
          </InlineAlert>
        )}
      </form>
    </Dialog>
  );
}
