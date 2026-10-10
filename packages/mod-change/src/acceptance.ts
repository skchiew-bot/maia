/** Acceptance tests for rollback verification (§8): which command to run, and a best-effort read of its results. Pure. */

/**
 * Programs an acceptance command may start by name. No shell (`sh`, `bash`) and no "run any package" launcher
 * (`npx`, `bunx`): the command is run as argv without a shell (G-50), and these would bring the shell back.
 */
const RUNNERS = new Set([
  'npm',
  'pnpm',
  'yarn',
  'bun',
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
  'ctest',
  'phpunit',
  'composer',
  'swift',
  'sbt',
]);

/** Arguments that turn a runner into "run this text as code": long options and subcommands, and short-option letters
 * (which may be combined, as in `node -pe` or `python3 -Bc`). */
const INLINE_CODE: Record<string, { words: ReadonlySet<string>; letters: string }> = {
  node: { words: new Set(['--eval', '--print']), letters: 'ep' },
  bun: { words: new Set(['--eval', '--print']), letters: 'ep' },
  deno: { words: new Set(['eval']), letters: '' },
  python: { words: new Set(), letters: 'c' },
  python3: { words: new Set(), letters: 'c' },
};

function runsInlineCode(program: string, arg: string): boolean {
  const rule = INLINE_CODE[program];
  if (!rule) return false;
  if (rule.words.has(arg.split('=')[0]!)) return true;
  const short = /^-([A-Za-z]+)$/.exec(arg)?.[1];
  return !!short && [...short].some((c) => rule.letters.includes(c));
}

/** `<runner> <subcommand>` pairs that start an arbitrary program. */
const EXEC_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  npm: new Set(['exec', 'x']),
  pnpm: new Set(['exec', 'dlx']),
  yarn: new Set(['exec', 'dlx']),
  bun: new Set(['x']),
  bundle: new Set(['exec']),
};

/** Variables that load code or change which program runs. */
const LOADER_ENV =
  /^(PATH|NODE_OPTIONS|BASH_ENV|ENV|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|RUBYOPT|LD_\w*|DYLD_\w*|GIT_\w*)$/;

/** Characters a shell would act on. Without a shell they would be passed literally, so a line holding one is refused. */
const SHELL_SYNTAX = /[;&|<>()$`\\{}*?[\]~!#\n]/;

export interface AcceptanceCommand {
  /** The command as written (after unwrapping), for the report. */
  text: string;
  /** Program and arguments, run without a shell. */
  argv: string[];
  /** Leading `NAME=value` assignments. */
  env: Record<string, string>;
}

/** Splits on blanks, honouring '…' and "…" quotes; null when quotes do not close or shell syntax is outside them. */
function words(line: string): string[] | null {
  const out: string[] = [];
  let cur: string | null = null;
  let quote: '"' | "'" | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === '$' || ch === '`' || ch === '\\')) return null;
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur ??= '';
    } else if (ch === ' ' || ch === '\t') {
      if (cur !== null) out.push(cur);
      cur = null;
    } else if (SHELL_SYNTAX.test(ch)) {
      return null;
    } else cur = (cur ?? '') + ch;
  }
  if (quote) return null;
  if (cur !== null) out.push(cur);
  return out;
}

/**
 * The acceptance test as a command to run without a shell (G-50), when it is one: a single line (optionally
 * `backticked`, fenced or `$ `-prefixed) whose program is a known test runner or a script inside the checkout
 * (`./scripts/accept.sh`), with no shell syntax, no inline code (`node -e`, `python -c`), no "run any program"
 * subcommand (`npm exec`, `pnpm dlx`), no URL or `data:` argument and no loader variable (`NODE_OPTIONS`, `LD_*`).
 * Anything else, prose acceptance criteria included, returns null.
 */
export function acceptanceCommandOf(text: string | null | undefined): AcceptanceCommand | null {
  if (!text) return null;
  let t = text.trim();
  const fenced = /^```[\w-]*\n([^\n]+)\n```$/.exec(t);
  if (fenced) t = fenced[1]!.trim();
  const inline = /^`([^`\n]+)`$/.exec(t);
  if (inline) t = inline[1]!.trim();
  if (t.startsWith('$ ')) t = t.slice(2).trim();
  if (!t || t.length > 500) return null;
  const all = words(t);
  if (!all?.length) return null;
  const env: Record<string, string> = {};
  let i = 0;
  for (let m; i < all.length && (m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(all[i]!)); i++) {
    if (LOADER_ENV.test(m[1]!)) return null;
    env[m[1]!] = m[2]!;
  }
  const argv = all.slice(i);
  const program = argv[0];
  if (!program) return null;
  const script = /^\.\/[\w.-]+(\/[\w.-]+)*$/.test(program) && !program.split('/').includes('..');
  if (!script && !RUNNERS.has(program)) return null;
  const args = argv.slice(1);
  if (args.some((a) => runsInlineCode(program, a))) return null;
  if (args[0] !== undefined && EXEC_SUBCOMMANDS[program]?.has(args[0])) return null;
  if (args.some((a) => /^data:/i.test(a) || a.includes('://'))) return null;
  return { text: t, argv, env };
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
