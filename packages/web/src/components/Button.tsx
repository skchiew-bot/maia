import type { ComponentPropsWithRef, MouseEvent, ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import { cx } from '../lib/dom';
import { Icon, type IconName } from './Icon';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children'> {
  /**
   * `primary` — the one main action in a view; `secondary` — default; `ghost` — low-emphasis/toolbar;
   * `danger` — destructive or governance-critical (rollback, revoke). Default `secondary`.
   */
  variant?: ButtonVariant;
  /** `md` = 28px (default), `sm` = 24px for dense rows and toolbars. */
  size?: ButtonSize;
  /**
   * Request in flight: the label becomes `loadingText`, the button reports `aria-busy` and ignores clicks
   * while staying focusable. There is deliberately no spinner (no idle animation, §12).
   */
  loading?: boolean;
  /** Label shown while `loading`. Default `Working…`. */
  loadingText?: string;
  /** Leading icon. */
  icon?: IconName;
  /** Trailing icon (e.g. `chevron-down` for menus, `external` for off-site links). */
  iconAfter?: IconName;
  children: ReactNode;
}

/** Text button. Defaults to `type="button"` so it never submits a form by accident. */
export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  loadingText = 'Working…',
  icon,
  iconAfter,
  className,
  children,
  type = 'button',
  onClick,
  disabled,
  ...rest
}: ButtonProps) {
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    if (loading) {
      e.preventDefault();
      return;
    }
    onClick?.(e);
  };
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-disabled={loading || undefined}
      className={cx('aoc-btn', `aoc-btn--${variant}`, `aoc-btn--${size}`, loading && 'is-loading', className)}
      onClick={handleClick}
    >
      {icon && !loading && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      <span className="aoc-btn__label">{loading ? loadingText : children}</span>
      {iconAfter && !loading && <Icon name={iconAfter} size={size === 'sm' ? 14 : 16} />}
    </button>
  );
}

export interface ButtonLinkProps extends Omit<LinkProps, 'children'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconAfter?: IconName;
  children: ReactNode;
}

/** A router link styled as a button — use for navigation ("New request"), never for actions. */
export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  icon,
  iconAfter,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link {...rest} className={cx('aoc-btn', `aoc-btn--${variant}`, `aoc-btn--${size}`, className)}>
      {icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      <span className="aoc-btn__label">{children}</span>
      {iconAfter && <Icon name={iconAfter} size={size === 'sm' ? 14 : 16} />}
    </Link>
  );
}

export interface IconButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> {
  /** Glyph to show. */
  icon: IconName;
  /** Accessible name; also shown as the tooltip. Required — an icon alone is never a label. */
  label: string;
  /** Default `ghost`. */
  variant?: ButtonVariant;
  /** `md` = 28px square (default), `sm` = 24px. */
  size?: ButtonSize;
  /** Suppress the tooltip (when a visible label sits right next to the button). */
  noTooltip?: boolean;
  /** Small count/status rendered on the button's corner (e.g. inbox count). */
  badge?: ReactNode;
}

/** Square icon-only button with a required accessible label and a matching tooltip. */
export function IconButton({
  icon,
  label,
  variant = 'ghost',
  size = 'md',
  noTooltip,
  badge,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      {...rest}
      type={type}
      aria-label={label}
      className={cx('aoc-btn', 'aoc-btn--icon', `aoc-btn--${variant}`, `aoc-btn--${size}`, className)}
    >
      <Icon name={icon} size={size === 'sm' ? 14 : 16} />
      {badge !== undefined && badge !== null && <span className="aoc-btn__badge">{badge}</span>}
    </button>
  );
  return noTooltip ? button : <Tooltip content={label}>{button}</Tooltip>;
}
