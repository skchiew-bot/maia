import { useEffect, useId, useState, type FormEvent } from 'react';
import type {
  LessonDTO,
  LessonScopeType,
  OffenceDTO,
  ProcessTypeView,
  RootCauseClassDTO,
} from '@aoc/contracts';
import { apiPost } from '../../api';
import { Button, Dialog, InlineAlert, Select, TextArea, TextField, describeError } from '../../components';

export interface ProposeLessonDialogProps {
  open: boolean;
  /** Preselected root-cause class (from Learning's "Propose a lesson"). */
  initialClassId?: string | null;
  classes: readonly RootCauseClassDTO[];
  /** Used to prefill the fix from the class's repeat offence. */
  offences: readonly OffenceDTO[];
  processTypes: readonly ProcessTypeView[];
  onClose: () => void;
  onDone: (lesson: LessonDTO) => void;
}

/** Client-side mirror of mod-learning's scope rule: repo-relative, specific, never the whole repo. */
export function codeAreaProblem(raw: string): string | null {
  const v = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!v) return 'Name a repo-relative directory, e.g. src/config.';
  if (v.startsWith('/') || /^[a-z]:\//i.test(v)) return 'Use a path relative to the repository root.';
  if (['.', '*', '**', '**/*', '~'].includes(v)) return 'That would make the lesson global: name one area.';
  if (v.split('/').some((seg) => seg === '..' || seg === '')) return 'No “..” or empty path segments.';
  if (!/^[A-Za-z0-9._@+\-/]+$/.test(v)) return 'Letters, digits and . _ @ + - / only.';
  return null;
}

const MIN = 3;

/**
 * Proposes a scoped lesson. Proposing raises a lesson-binding decision: nothing reaches any session until an
 * Approver binds it (one bad lesson corrupts the fleet, §11).
 */
export function ProposeLessonDialog({
  open,
  initialClassId,
  classes,
  offences,
  processTypes,
  onClose,
  onDone,
}: ProposeLessonDialogProps) {
  const formId = useId();
  const [classId, setClassId] = useState('');
  const [scopeType, setScopeType] = useState<LessonScopeType>('process_type');
  const [processType, setProcessType] = useState('');
  const [codeArea, setCodeArea] = useState('');
  const [rule, setRule] = useState('');
  const [fix, setFix] = useState('');
  const [rationale, setRationale] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  // Prefill once per opening: the class (and its offence's stated fix) when coming from Learning.
  useEffect(() => {
    if (!open) return;
    const cls = initialClassId ? classes.find((c) => c.classId === initialClassId) : undefined;
    const offence = cls ? offences.find((o) => o.classId === cls.classId) : undefined;
    setClassId(cls?.classId ?? '');
    setScopeType('process_type');
    setProcessType('');
    setCodeArea('');
    setRule('');
    setFix(offence?.fix ?? '');
    setRationale(
      offence
        ? `Repeat offence “${offence.className}”: ${offence.occurrences} occurrences, fix ${
            offence.state === 'verified_closed' ? 'verified' : 'applied'
          }.`
        : '',
    );
    setTouched(false);
    setBusy(false);
    setError(undefined);
  }, [open]); // classes/offences refresh live underneath; only a new opening resets the form

  const scopeValue = scopeType === 'process_type' ? processType : codeArea.trim();
  const scopeError = !touched
    ? undefined
    : scopeType === 'process_type'
      ? processType
        ? undefined
        : 'Choose the process type it applies to.'
      : (codeAreaProblem(codeArea) ?? undefined);
  const ruleError = touched && rule.trim().length < MIN ? 'State the rule sessions must follow.' : undefined;
  const fixError = touched && fix.trim().length < MIN ? 'State the fix.' : undefined;
  const rationaleError =
    touched && rationale.trim().length < MIN ? 'Say why: the evidence behind the lesson.' : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    const invalid =
      (scopeType === 'process_type' ? !processType : codeAreaProblem(codeArea) !== null) ||
      rule.trim().length < MIN ||
      fix.trim().length < MIN ||
      rationale.trim().length < MIN;
    if (invalid) return;
    setBusy(true);
    setError(undefined);
    try {
      const lesson = await apiPost<LessonDTO>('/api/learning/lessons', {
        ...(classId ? { classId } : {}),
        scopeType,
        scopeValue,
        rule: rule.trim(),
        fix: fix.trim(),
        rationale: rationale.trim(),
      });
      onDone(lesson);
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
      title="Propose a lesson"
      description="A lesson binds only when an Approver decides. Until then no session sees it."
      dismissOnBackdrop={false}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} loadingText="Proposing…">
            Propose for a decision
          </Button>
        </>
      }
    >
      <form id={formId} className="knowledge-form" onSubmit={submit} noValidate>
        <Select
          label="Root-cause class"
          value={classId}
          onChange={(e) => setClassId(e.target.value)}
          options={[
            { value: '', label: 'No class (payoff cannot be measured)' },
            ...classes.map((c) => ({ value: c.classId, label: c.name })),
          ]}
          hint="Payoff (repeats prevented, time and tokens saved) is measured against this class's recurrence rate."
        />
        <fieldset className="knowledge-form__choice">
          <legend>Scope (never global)</legend>
          <div className="knowledge-form__radios">
            <label className="knowledge-form__radio">
              <input
                type="radio"
                name={`${formId}-scope`}
                checked={scopeType === 'process_type'}
                onChange={() => setScopeType('process_type')}
              />
              <span>A process type</span>
            </label>
            <label className="knowledge-form__radio">
              <input
                type="radio"
                name={`${formId}-scope`}
                checked={scopeType === 'code_area'}
                onChange={() => setScopeType('code_area')}
              />
              <span>A code area</span>
            </label>
          </div>
        </fieldset>
        {scopeType === 'process_type' ? (
          <Select
            label="Process type"
            required
            value={processType}
            onChange={(e) => setProcessType(e.target.value)}
            placeholder="Choose a process type"
            error={scopeError}
            options={processTypes.map((t) => ({ value: t.id, label: `${t.name} (${t.id})` }))}
            hint="Injected into every run of this type."
          />
        ) : (
          <TextField
            label="Code area"
            required
            value={codeArea}
            maxLength={200}
            onChange={(e) => setCodeArea(e.target.value)}
            error={scopeError}
            placeholder="src/config"
            hint="Repo-relative directory. Injected into sessions whose changes touch it."
            spellCheck={false}
            autoCapitalize="off"
          />
        )}
        <TextArea
          label="Rule"
          required
          value={rule}
          maxLength={2000}
          onChange={(e) => setRule(e.target.value)}
          error={ruleError}
          rows={2}
          hint="What every session in scope must do, in one or two sentences."
        />
        <TextArea
          label="Fix"
          required
          value={fix}
          maxLength={4000}
          onChange={(e) => setFix(e.target.value)}
          error={fixError}
          rows={3}
          hint="How to apply it when the situation comes up."
        />
        <TextArea
          label="Rationale"
          required
          value={rationale}
          maxLength={4000}
          onChange={(e) => setRationale(e.target.value)}
          error={rationaleError}
          rows={2}
          hint="The evidence: which repeat offence, how often, what it cost. Shown to the Approver."
        />
        {error !== undefined && (
          <InlineAlert tone="danger" title="Not proposed" live>
            {describeError(error)}
          </InlineAlert>
        )}
      </form>
    </Dialog>
  );
}
