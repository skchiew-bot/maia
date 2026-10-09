import { useEffect, useId, useState, type FormEvent } from 'react';
import type { ErrorOccurrenceDTO, RootCauseClassDTO, RootCauseDimension } from '@aoc/contracts';
import { apiPost } from '../../api';
import {
  Button,
  Dialog,
  InlineAlert,
  Select,
  TextArea,
  TextField,
  describeError,
  formatInteger,
  useToast,
} from '../../components';
import { DIMENSIONS, DIMENSION_META, SOURCE_LABEL, type SignatureGroup } from './model';

export interface AssignRootCauseDialogProps {
  /** The signature to classify; `null` closes the dialog. */
  group: SignatureGroup | null;
  classes: readonly RootCauseClassDTO[];
  onClose: () => void;
  onDone: () => void;
}

type Mode = 'existing' | 'new';

/**
 * Puts a repeating signature into a root-cause class (an existing one or a new one). Only the newest
 * occurrence is assigned explicitly; mod-learning's rule assignment moves every same-signature occurrence
 * after it, and a class with two or more occurrences becomes a tracked repeat offence.
 */
export function AssignRootCauseDialog({ group, classes, onClose, onDone }: AssignRootCauseDialogProps) {
  const formId = useId();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('existing');
  const [classId, setClassId] = useState('');
  const [name, setName] = useState('');
  const [dimension, setDimension] = useState<RootCauseDimension | ''>('');
  const [description, setDescription] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(undefined);

  const signature = group?.signature;
  const hasClasses = classes.length > 0;
  useEffect(() => {
    setMode(hasClasses ? 'existing' : 'new');
    setClassId('');
    setName('');
    setDimension('');
    setDescription('');
    setTouched(false);
    setBusy(false);
    setError(undefined);
  }, [signature]); // reset per signature; the class list refreshes live underneath

  const effectiveMode: Mode = hasClasses ? mode : 'new';
  const classError = effectiveMode === 'existing' && touched && !classId ? 'Choose a class.' : undefined;
  const nameError =
    effectiveMode === 'new' && touched && name.trim().length < 2
      ? 'Name the cause (2–120 characters).'
      : undefined;
  const dimensionError =
    effectiveMode === 'new' && touched && !dimension ? 'Choose where the cause points.' : undefined;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!group) return;
    const body =
      effectiveMode === 'existing'
        ? classId
          ? { classId }
          : null
        : name.trim().length >= 2 && dimension
          ? {
              newClass: {
                name: name.trim(),
                dimension,
                ...(description.trim() ? { description: description.trim() } : {}),
              },
            }
          : null;
    if (!body) return;
    setBusy(true);
    setError(undefined);
    try {
      const updated = await apiPost<ErrorOccurrenceDTO>(
        `/api/learning/errors/${encodeURIComponent(group.latestErrorId)}/root-cause`,
        body,
      );
      toast.notify({
        tone: 'ok',
        title: `Root cause assigned: ${updated.className ?? 'class'}`,
        body:
          group.count > 1
            ? `The other ${formatInteger(group.count - 1)} occurrences with this signature follow.`
            : undefined,
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={group !== null}
      onClose={onClose}
      title="Assign a root cause"
      description="Cluster by cause, not by error text: the same cause often shows different symptoms."
      dismissOnBackdrop={false}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} loadingText="Assigning…">
            Assign root cause
          </Button>
        </>
      }
    >
      {group && (
        <form id={formId} className="learning-form" onSubmit={submit} noValidate>
          <div className="learning-sig">
            <code className="learning-sig__text">{group.text}</code>
            <p className="learning-sig__meta aoc-num">
              {formatInteger(group.count)} occurrence{group.count === 1 ? '' : 's'} ·{' '}
              {group.sources.map((s) => SOURCE_LABEL[s]).join(', ')}
              {group.processTypes.length > 0 && ` · ${group.processTypes.join(', ')}`}
            </p>
          </div>
          {hasClasses && (
            <fieldset className="learning-form__choice">
              <legend>Class</legend>
              <label className="learning-form__radio">
                <input
                  type="radio"
                  name={`${formId}-mode`}
                  checked={effectiveMode === 'existing'}
                  onChange={() => setMode('existing')}
                />
                <span>An existing class</span>
              </label>
              <label className="learning-form__radio">
                <input
                  type="radio"
                  name={`${formId}-mode`}
                  checked={effectiveMode === 'new'}
                  onChange={() => setMode('new')}
                />
                <span>A new class</span>
              </label>
            </fieldset>
          )}
          {effectiveMode === 'existing' ? (
            <Select
              label="Root-cause class"
              required
              value={classId}
              onChange={(e) => setClassId(e.target.value)}
              placeholder="Choose a class"
              error={classError}
              options={classes.map((c) => ({
                value: c.classId,
                label: `${c.name} · ${DIMENSION_META[c.dimension].label}`,
              }))}
            />
          ) : (
            <>
              <TextField
                label="Class name"
                required
                value={name}
                maxLength={120}
                onChange={(e) => setName(e.target.value)}
                error={nameError}
                hint="Name the cause, e.g. “Missing env-var guard in config loader”, not the error text."
              />
              <Select
                label="Where the cause points"
                required
                value={dimension}
                onChange={(e) => setDimension(e.target.value as RootCauseDimension)}
                placeholder="Choose a dimension"
                error={dimensionError}
                hint={
                  dimension
                    ? DIMENSION_META[dimension].hint
                    : 'Spec, codebase and guardrail causes are common.'
                }
                options={DIMENSIONS.map((d) => ({ value: d, label: DIMENSION_META[d].label }))}
              />
              <TextArea
                label="Description"
                value={description}
                maxLength={2000}
                onChange={(e) => setDescription(e.target.value)}
                hint="Optional. What ties these occurrences together."
                rows={3}
              />
            </>
          )}
          {error !== undefined && (
            <InlineAlert tone="danger" title="Not assigned" live>
              {describeError(error)}
            </InlineAlert>
          )}
        </form>
      )}
    </Dialog>
  );
}
