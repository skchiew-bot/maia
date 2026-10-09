import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/** Joins class names, skipping falsy parts. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/** Keeps a ref pointing at the latest value so long-lived listeners never see stale props. */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Live result of a media query; false where `matchMedia` is unavailable (tests, SSR). */
export function useMediaQuery(query: string): boolean {
  const get = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Read once at call time (for event handlers that must not animate under reduced motion). */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** localStorage access that never throws (private windows, blocked storage). */
export function readPref<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  try {
    const v = window.localStorage.getItem(key);
    return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Preference only; the UI works without it.
  }
}

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Tabbable descendants in DOM order (skips hidden and inert content). */
export function getTabbable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('inert') && !el.closest('[inert]') && el.getAttribute('aria-hidden') !== 'true',
  );
}

export interface FocusTrapOptions {
  /** Element to focus on activation; defaults to the first tabbable, then the container. */
  initialFocus?: RefObject<HTMLElement | null>;
  /** Called on Escape. */
  onEscape?: () => void;
}

/**
 * Traps Tab/Shift+Tab inside `ref` while `active`, focuses an initial element and restores focus to the
 * previously focused element on deactivation. Used by Dialog and Drawer.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  options: FocusTrapOptions = {},
): void {
  const opts = useLatest(options);

  useEffect(() => {
    if (!active) return undefined;
    const container = ref.current;
    if (!container) return undefined;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const target = opts.current.initialFocus?.current ?? getTabbable(container)[0] ?? container;
    target.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (opts.current.onEscape) {
          e.stopPropagation();
          opts.current.onEscape();
        }
        return;
      }
      if (e.key !== 'Tab') return;
      const items = getTabbable(container);
      if (items.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !container.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !container.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus();
    };
    // Option changes are read through `opts`, so only activation re-runs the trap.
  }, [active, ref, opts]);
}

let inertDepth = 0;

/**
 * Makes the app root inert while a modal surface is open so assistive tech and pointer input cannot reach
 * the page behind it. Nested modals are reference-counted.
 */
export function useInertBackground(active: boolean, rootId = 'root'): void {
  useEffect(() => {
    if (!active) return undefined;
    const root = document.getElementById(rootId);
    inertDepth += 1;
    root?.setAttribute('inert', '');
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      inertDepth -= 1;
      if (inertDepth === 0) {
        root?.removeAttribute('inert');
        document.body.style.overflow = prevOverflow;
      }
    };
  }, [active, rootId]);
}

/** Calls `onOutside` for pointer-downs outside every given element. */
export function useOutsidePointer(
  refs: ReadonlyArray<RefObject<HTMLElement | null>>,
  active: boolean,
  onOutside: () => void,
): void {
  const cb = useLatest(onOutside);
  const refsRef = useLatest(refs);
  useEffect(() => {
    if (!active) return undefined;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && refsRef.current.some((r) => r.current?.contains(t))) return;
      cb.current();
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [active, cb, refsRef]);
}

/** Stable callback identity that always calls the latest closure. */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useLatest(fn);
  return useCallback((...args: A) => ref.current(...args), [ref]);
}
