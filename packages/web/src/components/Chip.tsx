import type { ReactNode } from 'react';
import { cx } from '../lib/dom';
import { Icon, type IconName } from './Icon';
import type { Tone } from './tone';

export interface ChipProps {
  children: ReactNode;
  /** Default `neutral`. Role chips use `accent`. */
  tone?: Tone;
  icon?: IconName;
  /**
   * Makes the chip a toggle (filter chips): renders a `<button aria-pressed>`. Requires `onToggle`.
   */
  selected?: boolean;
  onToggle?: (next: boolean) => void;
  /** Adds a remove button (`×`) labelled `removeLabel`. */
  onRemove?: () => void;
  /** Accessible name of the remove button. Default `Remove`. */
  removeLabel?: string;
  className?: string;
}

/** Compact label for roles, filters, tags and scopes. */
export function Chip({
  children,
  tone = 'neutral',
  icon,
  selected,
  onToggle,
  onRemove,
  removeLabel = 'Remove',
  className,
}: ChipProps) {
  const classes = cx('aoc-chip', `aoc-tone--${tone}`, selected && 'is-selected', className);
  if (onToggle) {
    return (
      <button
        type="button"
        className={cx(classes, 'aoc-chip--toggle')}
        aria-pressed={!!selected}
        onClick={() => onToggle(!selected)}
      >
        {selected ? <Icon name="check" size={12} /> : icon && <Icon name={icon} size={12} />}
        <span>{children}</span>
      </button>
    );
  }
  return (
    <span className={classes}>
      {icon && <Icon name={icon} size={12} />}
      <span>{children}</span>
      {onRemove && (
        <button type="button" className="aoc-chip__remove" aria-label={removeLabel} onClick={onRemove}>
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

export interface KbdProps {
  children: ReactNode;
}

/** Keyboard key, e.g. <Kbd>Esc</Kbd>. */
export function Kbd({ children }: KbdProps) {
  return <kbd className="aoc-kbd">{children}</kbd>;
}
