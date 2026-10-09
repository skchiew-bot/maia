import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// Pages are lazy chunks: the first render of a real page transforms its whole module graph, which takes
// seconds on a busy machine. Give async queries and tests room for that; assertions are unchanged.
configure({ asyncUtilTimeout: 10_000 });
vi.setConfig({ testTimeout: 30_000 });

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(() => {
  cleanup();
});

// jsdom logs "not implemented" for scrolling; the shell scrolls to top on navigation.
window.scrollTo = (() => undefined) as typeof window.scrollTo;
