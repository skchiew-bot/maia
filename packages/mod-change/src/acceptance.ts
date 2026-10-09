/** Acceptance tests for rollback verification (§8): which command to run, and a best-effort read of its results. Pure. */

const RUNNERS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'bun',
  'bunx',
  'deno',
  'node',
  'make',
  'just',
  'task',
  'pytest',
  'python',
  'python3',
  'tox',
  'nox',
  'go',
  'cargo',
  'mvn',
  'gradle',
  'rake',
  'bundle',
  'rspec',
  'dotnet',
  'mix',
  'vitest',
  'jest',
  'sh',
  'bash',
  'ctest',
  'phpunit',
  'composer',
  'swift',
  'sbt',
]);

/**
 * The acceptance test as a runnable command, when it is one: a single line (optionally `backticked`, fenced or
 * `$ `-prefixed) whose program is a known test runner or a path such as `./scripts/accept.sh`. Prose acceptance
 * criteria return null.
 */
export function acceptanceCommandOf(text: string | null | undefined): string | null {
  if (!text) return null;
  let t = text.trim();
  const fenced = /^```[\w-]*\n([^\n]+)\n```$/.exec(t);
  if (fenced) t = fenced[1]!.trim();
  const inline = /^`([^`\n]+)`$/.exec(t);
  if (inline) t = inline[1]!.trim();
  if (t.startsWith('$ ')) t = t.slice(2).trim();
  if (!t || t.includes('\n') || t.length > 500) return null;
  const words = t.split(/\s+/);
  let i = 0;
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!)) i++;
  const program = words[i];
  if (!program) return null;
  return RUNNERS.has(program) || /^\.{0,2}\/[\w./-]+$/.test(program) ? t : null;
}

export interface TestCounts {
  passed: number;
  failed: number;
  /** false when no known summary line was found (counts are then 0/0 and only the exit code decides). */
  parsed: boolean;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Best-effort pass/fail counts from common runners: vitest, jest, pytest, cargo, TAP / node:test, mocha, go test -v. */
export function parseTestCounts(output: string): TestCounts {
  const text = output.replace(ANSI, '');
  const lastMatch = (re: RegExp): RegExpExecArray | null => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    let m: RegExpExecArray | null;
    let out: RegExpExecArray | null = null;
    while ((m = g.exec(text))) out = m;
    return out;
  };
  const countIn = (line: string, word: string): number =>
    Number(new RegExp(`(\\d+)\\s+${word}`, 'i').exec(line)?.[1] ?? 0);
  const found = (passed: number, failed: number): TestCounts => ({ passed, failed, parsed: true });

  const vitest = lastMatch(/^\s*Tests\s+(\d+\s+(?:passed|failed|skipped|todo)[^\n]*)$/m);
  if (vitest) return found(countIn(vitest[1]!, 'passed'), countIn(vitest[1]!, 'failed'));
  const jest = lastMatch(/^Tests:\s+([^\n]+)$/m);
  if (jest) return found(countIn(jest[1]!, 'passed'), countIn(jest[1]!, 'failed'));
  const pytest = lastMatch(/^=+ ([^=\n]*\b(?:passed|failed|errors?)\b[^=\n]*) in [\d.]+s[^=\n]*=+$/m);
  if (pytest)
    return found(
      countIn(pytest[1]!, 'passed'),
      countIn(pytest[1]!, 'failed') + countIn(pytest[1]!, 'errors?'),
    );
  const cargo = [...text.matchAll(/^test result: \w+\. (\d+) passed; (\d+) failed/gm)];
  if (cargo.length) return found(sum(cargo.map((m) => Number(m[1]))), sum(cargo.map((m) => Number(m[2]))));
  const tapPass = lastMatch(/^(?:#|ℹ)\s*pass\s+(\d+)/m);
  const tapFail = lastMatch(/^(?:#|ℹ)\s*fail\s+(\d+)/m);
  if (tapPass || tapFail) return found(Number(tapPass?.[1] ?? 0), Number(tapFail?.[1] ?? 0));
  const mochaPass = lastMatch(/^\s*(\d+) passing\b/m);
  const mochaFail = lastMatch(/^\s*(\d+) failing\b/m);
  if (mochaPass || mochaFail) return found(Number(mochaPass?.[1] ?? 0), Number(mochaFail?.[1] ?? 0));
  const goPass = (text.match(/^\s*--- PASS:/gm) ?? []).length;
  const goFail = (text.match(/^\s*--- FAIL:/gm) ?? []).length;
  if (goPass || goFail) return found(goPass, goFail);
  return { passed: 0, failed: 0, parsed: false };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export interface VerificationOutcome {
  rollbackId: string;
  targetRef: string;
  targetSha: string;
  branch: string;
  command: string | null;
  commandSource: 'change' | 'project' | 'package.json' | null;
  exitCode: number | null;
  durationMs: number;
  counts: TestCounts;
  output: string;
  /** Set when verification could not run at all (worktree, supervisor, no acceptance command). */
  problem: string | null;
}

/** clean = the acceptance command ran, exited 0 and reported no failures. */
export function isClean(o: VerificationOutcome): boolean {
  return o.problem === null && o.exitCode === 0 && o.counts.failed === 0;
}

const REPORT_TAIL = 6000;

export function verificationReport(o: VerificationOutcome): string {
  const clean = isClean(o);
  const lines = [
    `Rollback verification ${o.rollbackId}`,
    `Target: ${o.targetRef} -> ${o.targetSha}`,
    `Branch: ${o.branch}`,
    `Command: ${o.command ?? '(none)'}${o.commandSource ? ` [from ${o.commandSource}]` : ''}`,
  ];
  if (o.exitCode !== null) lines.push(`Exit code: ${o.exitCode} after ${(o.durationMs / 1000).toFixed(1)}s`);
  lines.push(
    o.counts.parsed
      ? `Tests: ${o.counts.passed} passed, ${o.counts.failed} failed`
      : 'Tests: no summary found (exit code decides)',
  );
  if (o.problem) lines.push(`Problem: ${o.problem}`);
  lines.push(
    clean
      ? 'Result: CLEAN — the rollback can go to the approver.'
      : 'Result: NOT CLEAN — no approval will be requested.',
  );
  if (o.output.trim()) {
    const tail = o.output.length > REPORT_TAIL ? `…${o.output.slice(-REPORT_TAIL)}` : o.output;
    lines.push('', '--- output ---', tail.replace(ANSI, ''));
  }
  return lines.join('\n');
}
