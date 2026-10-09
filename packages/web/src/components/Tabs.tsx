import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../lib/dom';

export interface TabItem {
  /** Stable id (also the controlled value). */
  id: string;
  label: ReactNode;
  /** Small count after the label (e.g. open items). */
  count?: number;
  disabled?: boolean;
  /** Panel content. Only the selected panel is mounted. */
  content?: ReactNode;
}

export interface TabsProps {
  /** Accessible name of the tab list ("Session views"). */
  label: string;
  items: readonly TabItem[];
  /** Controlled selection. */
  value?: string;
  /** Initial selection when uncontrolled. Default: first enabled tab. */
  defaultValue?: string;
  onChange?: (id: string) => void;
  /**
   * `auto` (default): arrow keys move and select (cheap panels). `manual`: arrows move focus only;
   * Enter/Space selects — use when a panel triggers a fetch.
   */
  activation?: 'auto' | 'manual';
  className?: string;
}

/**
 * WAI-ARIA tabs with a roving tabindex: one tab stop for the list, ←/→ to move (wrapping), Home/End to
 * jump, disabled tabs skipped.
 */
export function Tabs({
  label,
  items,
  value,
  defaultValue,
  onChange,
  activation = 'auto',
  className,
}: TabsProps) {
  const baseId = useId();
  const firstEnabled = items.find((t) => !t.disabled)?.id;
  const [inner, setInner] = useState<string | undefined>(defaultValue ?? firstEnabled);
  const selected = value ?? inner ?? firstEnabled;
  const [focusedId, setFocusedId] = useState<string | undefined>(undefined);
  const refs = useRef(new Map<string, HTMLButtonElement>());

  const select = (id: string) => {
    if (value === undefined) setInner(id);
    if (id !== selected) onChange?.(id);
  };

  const enabled = items.filter((t) => !t.disabled);
  // The roving stop follows focus while the list is focused, otherwise the selected tab.
  const stopId = focusedId ?? selected;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const current = enabled.findIndex((t) => t.id === (focusedId ?? selected));
    let next = -1;
    if (e.key === 'ArrowRight') next = (current + 1) % enabled.length;
    else if (e.key === 'ArrowLeft') next = (current - 1 + enabled.length) % enabled.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = enabled.length - 1;
    else if ((e.key === 'Enter' || e.key === ' ') && activation === 'manual' && focusedId) {
      e.preventDefault();
      select(focusedId);
      return;
    }
    if (next < 0 || !enabled[next]) return;
    e.preventDefault();
    const target = enabled[next]!;
    setFocusedId(target.id);
    refs.current.get(target.id)?.focus();
    if (activation === 'auto') select(target.id);
  };

  const active = items.find((t) => t.id === selected);
  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const panelId = (id: string) => `${baseId}-panel-${id}`;
  const hasPanels = items.some((t) => t.content !== undefined);

  return (
    <div className={cx('aoc-tabs', className)}>
      <div
        role="tablist"
        aria-label={label}
        className="aoc-tabs__list"
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocusedId(undefined);
        }}
      >
        {items.map((t) => {
          const isSelected = t.id === selected;
          return (
            <button
              key={t.id}
              ref={(el) => {
                if (el) refs.current.set(t.id, el);
                else refs.current.delete(t.id);
              }}
              type="button"
              role="tab"
              id={tabId(t.id)}
              aria-selected={isSelected}
              aria-controls={hasPanels ? panelId(t.id) : undefined}
              aria-disabled={t.disabled || undefined}
              tabIndex={t.id === stopId ? 0 : -1}
              className={cx('aoc-tabs__tab', isSelected && 'is-selected')}
              onFocus={() => setFocusedId(t.id)}
              onClick={() => {
                if (!t.disabled) select(t.id);
              }}
            >
              <span>{t.label}</span>
              {t.count !== undefined && <span className="aoc-tabs__count aoc-num">{t.count}</span>}
            </button>
          );
        })}
      </div>
      {hasPanels && active && (
        <div
          role="tabpanel"
          id={panelId(active.id)}
          aria-labelledby={tabId(active.id)}
          tabIndex={0}
          className="aoc-tabs__panel"
        >
          {active.content}
        </div>
      )}
    </div>
  );
}

export interface SegmentedOption<V extends string> {
  value: V;
  label: string;
}

export interface SegmentedControlProps<V extends string> {
  /** Accessible group name ("Time range"). */
  label: string;
  options: readonly SegmentedOption<V>[];
  value: V;
  onChange: (value: V) => void;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * Single-choice toggle for view options and time ranges (Today / 7d / 30d). A radio group: one tab stop,
 * arrows move and select.
 */
export function SegmentedControl<V extends string>({
  label,
  options,
  value,
  onChange,
  size = 'md',
  className,
}: SegmentedControlProps<V>) {
  const refs = useRef(new Map<string, HTMLButtonElement>());
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = options.findIndex((o) => o.value === value);
    let next = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + options.length) % options.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = options.length - 1;
    if (next < 0 || !options[next]) return;
    e.preventDefault();
    const o = options[next]!;
    onChange(o.value);
    refs.current.get(o.value)?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx('aoc-seg', `aoc-seg--${size}`, className)}
      onKeyDown={onKeyDown}
    >
      {options.map((o) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              if (el) refs.current.set(o.value, el);
              else refs.current.delete(o.value);
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={cx('aoc-seg__option', checked && 'is-selected')}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
