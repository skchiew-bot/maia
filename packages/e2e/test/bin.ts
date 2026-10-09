import { join } from 'node:path';
import { inject } from 'vitest';
import type { BINARIES } from './paths';

/** Path of a binary bundled by global-setup.ts; run it as `node <path> …` (claude-sim is the `claude` of supervisor runs). */
export const bin = (name: keyof typeof BINARIES): string => join(inject('binDir'), `${name}.mjs`);
