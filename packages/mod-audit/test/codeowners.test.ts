import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROTECTED_PATHS } from '@aoc/contracts';

describe('.github/CODEOWNERS.example (layer 3 of the self-modification boundary)', () => {
  const rules = readFileSync(new URL('../../../.github/CODEOWNERS.example', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim() && !l.trimStart().startsWith('#'))
    .map((l) => l.trim().split(/\s+/));

  it('assigns every default protected path to reviewers', () => {
    for (const p of DEFAULT_PROTECTED_PATHS) {
      const rule = rules.find(([pattern]) => pattern === `/${p}`);
      expect(rule, p).toBeDefined();
      expect(rule!.length, p).toBeGreaterThan(1);
    }
  });

  it('names no path that the guard leaves unprotected', () => {
    const guarded = new Set(DEFAULT_PROTECTED_PATHS.map((p) => `/${p}`));
    for (const [pattern] of rules) if (pattern !== '*') expect(guarded.has(pattern!), pattern).toBe(true);
  });
});
