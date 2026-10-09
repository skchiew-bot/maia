/**
 * `useDocumentBadge(count)` prefixes the tab title with `(n) ` while `count > 0` — the background-tab signal
 * for waiting decisions (R15). Shares one title owner with `useDocumentTitle` (PageHeader).
 */
export { useDocumentBadge, useDocumentTitle } from '../lib/documentTitle';
