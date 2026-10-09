import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cx, useOutsidePointer } from '../lib/dom';
import { Icon, type IconName } from './Icon';

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
  onSelect: () => void;
  /** `danger` for destructive items (sign out, revoke). */
  tone?: 'danger';
  disabled?: boolean;
}

export interface MenuProps {
  /** Accessible name of the trigger when its content is not plain text (e.g. an avatar). */
  label: string;
  /** Visible trigger content. */
  trigger: ReactNode;
  items: readonly MenuItem[];
  /** Non-interactive header inside the popup ("Signed in as …"). */
  header?: ReactNode;
  /** Popup alignment relative to the trigger. Default `end`. */
  align?: 'start' | 'end';
  triggerClassName?: string;
}

/**
 * Action menu (menu button pattern): Enter/Space/↓ opens and focuses the first item, ↑/↓ move, Home/End
 * jump, Escape closes and returns focus to the trigger, outside clicks close.
 */
export function Menu({ label, trigger, items, header, align = 'end', triggerClassName }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabled = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);

  useOutsidePointer([triggerRef, popupRef], open, () => setOpen(false));

  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  const openAt = (index: number) => {
    setActive(index);
    setOpen(true);
  };

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openAt(enabled[0] ?? 0);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      openAt(enabled[enabled.length - 1] ?? 0);
    }
  };

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const pos = enabled.indexOf(active);
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(enabled[(pos + 1) % enabled.length] ?? active);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(enabled[(pos - 1 + enabled.length) % enabled.length] ?? active);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(enabled[0] ?? active);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(enabled[enabled.length - 1] ?? active);
    } else if (e.key === 'Tab') {
      close(false);
    }
  };

  return (
    <div className={cx('aoc-menu', `aoc-menu--${align}`)}>
      <button
        ref={triggerRef}
        type="button"
        className={cx('aoc-menu__trigger', triggerClassName)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        onClick={() => (open ? close(false) : openAt(enabled[0] ?? 0))}
        onKeyDown={onTriggerKey}
      >
        {trigger}
      </button>
      {open && (
        <div ref={popupRef} className="aoc-menu__popup" onKeyDown={onMenuKey}>
          {header && <div className="aoc-menu__header">{header}</div>}
          <div role="menu" id={menuId} aria-label={label} className="aoc-menu__list">
            {items.map((it, i) => (
              <button
                key={it.id}
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={i === active ? 0 : -1}
                aria-disabled={it.disabled || undefined}
                className={cx('aoc-menu__item', it.tone === 'danger' && 'is-danger')}
                onClick={() => {
                  if (it.disabled) return;
                  close(true);
                  it.onSelect();
                }}
              >
                {it.icon && <Icon name={it.icon} size={14} />}
                <span>{it.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
