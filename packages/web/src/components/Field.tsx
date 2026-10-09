import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx } from '../lib/dom';
import { Icon } from './Icon';

export interface FieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  required?: boolean;
}

export interface FieldProps {
  /** Visible label (always visible — placeholders are not labels). */
  label: string;
  /** Help text under the control. */
  hint?: ReactNode;
  /** Validation message; marks the control invalid and is announced with it. */
  error?: string;
  /** Adds "required" to the label and `required` to the control. */
  required?: boolean;
  /** Renders the control with the wiring it needs (id, aria-describedby, aria-invalid). */
  children: (control: FieldControlProps) => ReactNode;
  className?: string;
}

/** Label + hint + error wrapper for any control. TextField, TextArea, Select and Checkbox build on it. */
export function Field({ label, hint, error, required, children, className }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy =
    [hint ? hintId : undefined, error ? errorId : undefined].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx('aoc-field', error && 'is-invalid', className)}>
      <label htmlFor={id} className="aoc-field__label">
        {label}
        {required && <span className="aoc-field__required"> (required)</span>}
      </label>
      {children({ id, 'aria-describedby': describedBy, 'aria-invalid': error ? true : undefined, required })}
      {hint && (
        <p id={hintId} className="aoc-field__hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="aoc-field__error">
          <Icon name="danger" size={12} />
          {error}
        </p>
      )}
    </div>
  );
}

type FieldBase = Pick<FieldProps, 'label' | 'hint' | 'error' | 'required'> & { fieldClassName?: string };

export type TextFieldProps = FieldBase & Omit<ComponentPropsWithRef<'input'>, 'id' | 'required'>;

/** Single-line input with label, hint and error. */
export function TextField({
  label,
  hint,
  error,
  required,
  fieldClassName,
  className,
  ...input
}: TextFieldProps) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={fieldClassName}>
      {(control) => <input {...input} {...control} className={cx('aoc-input', className)} />}
    </Field>
  );
}

export type TextAreaProps = FieldBase & Omit<ComponentPropsWithRef<'textarea'>, 'id' | 'required'>;

/** Multi-line input. Text entered here is untrusted data wherever it is shown later. */
export function TextArea({
  label,
  hint,
  error,
  required,
  fieldClassName,
  className,
  rows = 4,
  ...area
}: TextAreaProps) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={fieldClassName}>
      {(control) => (
        <textarea {...area} {...control} rows={rows} className={cx('aoc-input', 'aoc-textarea', className)} />
      )}
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export type SelectProps = FieldBase &
  Omit<ComponentPropsWithRef<'select'>, 'id' | 'required' | 'children'> & {
    options: readonly SelectOption[];
    /** Placeholder option shown when no value is chosen. */
    placeholder?: string;
  };

/** Native select (best keyboard/mobile behaviour) with label, hint and error. */
export function Select({
  label,
  hint,
  error,
  required,
  fieldClassName,
  className,
  options,
  placeholder,
  ...select
}: SelectProps) {
  return (
    <Field label={label} hint={hint} error={error} required={required} className={fieldClassName}>
      {(control) => (
        <span className="aoc-select">
          <select {...select} {...control} className={cx('aoc-input', 'aoc-select__control', className)}>
            {placeholder !== undefined && (
              <option value="" disabled={required}>
                {placeholder}
              </option>
            )}
            {options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
          </select>
          <Icon name="chevron-down" size={14} className="aoc-select__icon" />
        </span>
      )}
    </Field>
  );
}

export interface CheckboxProps extends Omit<ComponentPropsWithRef<'input'>, 'type' | 'id'> {
  /** Label to the right of the box. */
  label: ReactNode;
  /** Help text under the label. */
  hint?: ReactNode;
}

/** Checkbox with a clickable label. */
export function Checkbox({ label, hint, className, ...input }: CheckboxProps) {
  const id = useId();
  return (
    <div className={cx('aoc-check', className)}>
      <input
        {...input}
        id={id}
        type="checkbox"
        className="aoc-check__box"
        aria-describedby={hint ? `${id}-hint` : undefined}
      />
      <label htmlFor={id} className="aoc-check__label">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="aoc-field__hint aoc-check__hint">
          {hint}
        </p>
      )}
    </div>
  );
}
