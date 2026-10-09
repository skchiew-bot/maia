import type { PinDTO, PinListDTO, PinProblem } from '@aoc/contracts';
import { Field } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { formatDateTime, shortHash } from '../../lib/format';
import { shortId } from '../audit/ids';

export const PIN_PROBLEM_TEXT: Record<PinProblem, string> = {
  repo_unknown: 'project repository unknown',
  tag_missing: 'tag no longer in the repository',
  tag_moved: 'tag moved off its pinned commit',
  commit_missing: 'commit not in the repository',
};

/** What pinned a state, in words ("phase verify", "change chg_…HK2621"). */
export function pinSourceText(pin: PinDTO): string {
  const first = pin.pinnedBy[0];
  if (!first) return 'pinned';
  const id = first.sourceId;
  switch (first.source) {
    case 'phase.completed':
      return id ? `phase ${id} completed` : 'phase completed';
    case 'change.completed':
      return id ? `change ${shortId(id)} completed` : 'change completed';
    case 'change.submitted':
      return id ? `rollback point of change ${shortId(id)}` : 'change rollback point';
    case 'git.ref_pinned':
      return first.sourceId === 'change.completed'
        ? 'change completed'
        : `pinned (${first.sourceId ?? 'tag'})`;
  }
}

/** The ref a pin is restored by: its tag when it has one, else its full SHA. */
export function pinRef(pin: PinDTO): string {
  return pin.tag || pin.resolvedSha || pin.sha || '';
}

export interface RollbackTargetPickerProps {
  label?: string;
  pins: PinListDTO | undefined;
  /** Offer the default branch head (a change record's natural return point). Rollbacks need a pinned state. */
  includeHead?: boolean;
  value: string;
  onChange: (ref: string) => void;
  error?: string;
  hint?: string;
  disabled?: boolean;
}

/**
 * Pick the exact tag or commit to return to (§8) from the project's pinned states. States that no longer resolve
 * in the repository are listed but disabled, with the reason, so nobody plans a return to a state that is gone.
 */
export function RollbackTargetPicker({
  label = 'Rollback target',
  pins,
  includeHead = false,
  value,
  onChange,
  error,
  hint,
  disabled,
}: RollbackTargetPickerProps) {
  const usable = pins?.pins.filter((p) => !p.problem) ?? [];
  const broken = pins?.pins.filter((p) => p.problem) ?? [];
  const head = includeHead ? pins?.head : null;
  const empty = !head && usable.length === 0;
  return (
    <Field
      label={label}
      required
      error={error}
      hint={
        hint ??
        (pins
          ? `${usable.length} pinned ${usable.length === 1 ? 'state resolves' : 'states resolve'} in the repository${
              broken.length ? `; ${broken.length} no longer ${broken.length === 1 ? 'does' : 'do'}` : ''
            }.`
          : 'Loading the pinned tags and SHAs…')
      }
    >
      {(control) => (
        <span className="aoc-select">
          <select
            {...control}
            className="aoc-input aoc-select__control"
            value={value}
            disabled={disabled || !pins || empty}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="" disabled>
              {!pins
                ? 'Loading…'
                : empty
                  ? 'No pinned state resolves in this repository'
                  : 'Choose the exact tag or commit'}
            </option>
            {head && (
              <optgroup label={`Current head of ${pins?.defaultBranch ?? 'the default branch'}`}>
                <option value={head}>
                  {pins?.defaultBranch ?? 'head'} @ {shortHash(head, 12)} (the state before this change)
                </option>
              </optgroup>
            )}
            {usable.length > 0 && (
              <optgroup label="Pinned states, newest first">
                {usable.map((p) => (
                  <option key={pinRef(p)} value={pinRef(p)}>
                    {p.tag
                      ? `${p.tag} @ ${shortHash(p.resolvedSha ?? p.sha ?? '', 8)}`
                      : shortHash(p.resolvedSha ?? p.sha ?? '', 12)}{' '}
                    · {pinSourceText(p)} · {formatDateTime(p.pinnedBy[0]!.at)}
                  </option>
                ))}
              </optgroup>
            )}
            {broken.length > 0 && (
              <optgroup label="Pinned, but no longer restorable">
                {broken.slice(0, 40).map((p) => (
                  <option key={`${p.tag ?? ''}:${p.sha ?? ''}`} value="" disabled>
                    {p.tag ?? shortHash(p.sha ?? '', 12)} · {PIN_PROBLEM_TEXT[p.problem!]}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <Icon name="chevron-down" size={14} className="aoc-select__icon" />
        </span>
      )}
    </Field>
  );
}
