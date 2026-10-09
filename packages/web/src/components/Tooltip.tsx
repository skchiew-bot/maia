import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export interface TooltipProps {
  /** Tooltip text. Supplementary only — never the sole place a value or action name lives. */
  content: ReactNode;
  /** Exactly one focusable element (button, link). It receives `aria-describedby`. */
  children: ReactElement<{ 'aria-describedby'?: string }>;
  /** Preferred side; flips when there is no room. Default `top`. */
  placement?: 'top' | 'bottom';
  /** Hover delay in ms before showing. Focus shows immediately. Default 350. */
  delay?: number;
  /** Suppress the tooltip (e.g. while a menu is open). */
  disabled?: boolean;
}

const GAP = 6;
const MARGIN = 8;

/**
 * Accessible tooltip (WCAG 1.4.13): shows on hover and keyboard focus, stays while hovered, dismisses on
 * Escape, and is referenced by `aria-describedby`. Rendered in a portal so cards never clip it.
 */
export function Tooltip({ content, children, placement = 'top', delay = 350, disabled }: TooltipProps) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });

  const clearTimers = () => {
    clearTimeout(showTimer.current);
    clearTimeout(hideTimer.current);
  };
  const show = useCallback(
    (immediate: boolean) => {
      if (disabled) return;
      clearTimers();
      if (immediate) setOpen(true);
      else showTimer.current = setTimeout(() => setOpen(true), delay);
    },
    [delay, disabled],
  );
  const hide = useCallback(() => {
    clearTimers();
    hideTimer.current = setTimeout(() => setOpen(false), 80);
  }, []);

  useEffect(() => clearTimers, []);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setStyle({ visibility: 'hidden' });
      return;
    }
    const anchor = anchorRef.current?.getBoundingClientRect();
    const tip = tipRef.current?.getBoundingClientRect();
    if (!anchor || !tip) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = placement === 'top' ? anchor.top - tip.height - GAP : anchor.bottom + GAP;
    if (placement === 'top' && top < MARGIN) top = anchor.bottom + GAP;
    if (placement === 'bottom' && top + tip.height > vh - MARGIN) top = anchor.top - tip.height - GAP;
    let left = anchor.left + anchor.width / 2 - tip.width / 2;
    left = Math.max(MARGIN, Math.min(left, vw - tip.width - MARGIN));
    setStyle({ top: Math.round(top), left: Math.round(left) });
  }, [open, placement, content]);

  const child = isValidElement(children)
    ? cloneElement(children, {
        'aria-describedby':
          [children.props['aria-describedby'], open ? id : undefined].filter(Boolean).join(' ') || undefined,
      })
    : children;

  return (
    <>
      <span
        ref={anchorRef}
        className="aoc-tooltip-anchor"
        onPointerEnter={(e) => {
          if (e.pointerType !== 'touch') show(false);
        }}
        onPointerLeave={hide}
        onFocus={() => show(true)}
        onBlur={hide}
      >
        {child}
      </span>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className="aoc-tooltip"
            style={style}
            onPointerEnter={() => clearTimers()}
            onPointerLeave={hide}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
