import { useEffect } from 'react';

/**
 * One owner for `document.title`, composed as `(3) Decisions · AOC`: the badge prefix (R15 — waiting
 * decisions must be visible from a background tab), the page title and the surface name.
 */
const state = { page: '', badge: 0, product: 'AOC' };

function apply(): void {
  if (typeof document === 'undefined') return;
  const prefix = state.badge > 0 ? `(${state.badge}) ` : '';
  document.title = `${prefix}${state.page ? `${state.page} · ` : ''}${state.product}`;
}

/** Sets the page part of the tab title while mounted. */
export function useDocumentTitle(title: string | undefined): void {
  useEffect(() => {
    if (title === undefined) return;
    state.page = title;
    apply();
  }, [title]);
}

/** Sets the surface name (operator console vs. requester portal). */
export function useDocumentProduct(name: string): void {
  useEffect(() => {
    const previous = state.product;
    state.product = name;
    apply();
    return () => {
      state.product = previous;
      apply();
    };
  }, [name]);
}

/** Prefixes the tab title with `(n) ` while `count > 0`. */
export function useDocumentBadge(count: number | null | undefined): void {
  useEffect(() => {
    state.badge = count && count > 0 ? Math.floor(count) : 0;
    apply();
    return () => {
      state.badge = 0;
      apply();
    };
  }, [count]);
}
