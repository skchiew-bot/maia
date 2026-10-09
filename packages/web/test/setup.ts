import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest runs without globals, so Testing Library cannot register its own cleanup.
afterEach(() => {
  cleanup();
});

// jsdom logs "not implemented" for scrolling; the shell scrolls to top on navigation.
window.scrollTo = (() => undefined) as typeof window.scrollTo;
