import { describe, expect, it } from 'vitest';
import { BoundaryMatcher } from '../src';
import { analyzeBash } from '../src/selfmod/shell';

const matcher = () =>
  new BoundaryMatcher({ aocRepoPaths: ['/r'], protectedPaths: ['packages/kernel/'], auditStorePaths: ['/var/lib/aoc'] });

describe('the self-modification analyzer is linear in agent-controlled input', () => {
  it('answers fast for inline code built to backtrack (it runs on the daemon thread for every managed Bash call)', () => {
    const m = matcher();
    for (const code of ['open('.repeat(24_000), `open('${"x'".repeat(12_000)}`]) {
      const started = performance.now();
      analyzeBash(`python3 -c "${code}"`, '/r', m);
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it('still catches a write through open() to a protected path', () => {
    const m = matcher();
    expect(analyzeBash(`python3 -c "open('/r/packages/kernel/x.ts', 'w').write('x')"`, '/tmp', m)).toMatchObject({ kind: 'interpreter' });
    expect(analyzeBash(`python3 -c "f = open('/r/packages/kernel/x.ts', \\"a+\\")"`, '/tmp', m)).toMatchObject({ kind: 'interpreter' });
    expect(analyzeBash(`python3 -c "print(open('/r/packages/kernel/x.ts').read())"`, '/tmp', m)).toBeNull();
  });
});
