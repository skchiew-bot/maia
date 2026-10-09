/**
 * Route-change focus hand-off. The layout marks a navigation; the next PageHeader to mount (possibly after a
 * lazy chunk loads) moves focus to its `<h1>`, which announces the new page to screen readers.
 */
let pending = false;

export function markRouteChange(): void {
  pending = true;
}

/** Returns true once per marked navigation. */
export function consumeRouteChange(): boolean {
  const was = pending;
  pending = false;
  return was;
}
