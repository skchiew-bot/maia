/**
 * In-app deep links. One owner per target so a page never spells another page's URL contract by hand.
 */

/**
 * The Decisions inbox with one card selected (`?focus=`). Every link to a specific decision goes through here:
 * the page reads `focus`, not `id` or a `#hash`, and `/decisions/:id` (notification and webhook links) redirects
 * to this form.
 */
export function decisionHref(decisionId: string): string {
  return `/decisions?focus=${encodeURIComponent(decisionId)}`;
}
