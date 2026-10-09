/**
 * PreToolUse guard `protected-op` (decision tests 1 main, 2 production, 5 data).
 *
 * Pattern matching is a speed bump, not a wall: `bash -c`, scripts, make targets, aliases and anything else that
 * hides the command bypass it. Credential isolation is the wall (§2.4, §3): sessions never hold deploy keys or
 * protected-branch push rights, only supervisor-controlled environments do. This guard's job is to turn a visible
 * attempt into a decision card for a human.
 */
import { resolve } from 'node:path';
import {
  DECISION_TEST_INFO,
  type DecisionTest,
  type GuardResult,
  type PreToolContext,
  type PreToolGuard,
} from '@aoc/contracts';

export type ProtectedTest = Extract<DecisionTest, 'main' | 'production' | 'data'>;
export interface ProtectedHit {
  test: ProtectedTest;
  label: string;
}

export const DEFAULT_PROTECTED_BRANCHES = ['main', 'master', 'production', 'release/*'];

export interface MatchOptions {
  protectedBranches?: string[];
  /** Current branch of a directory (`git -C <dir>`, null = the session cwd), for bare `git push` and `HEAD`. */
  currentBranch?: (dir: string | null) => string | null;
}

// ── shell splitting ──────────────────────────────────────────────────────────

/**
 * Split a command line into simple commands (word arrays). Understands quoting, escapes, comments, the
 * operators ; & | && || and newlines, subshell parens, `$(` and backticks, redirections and heredoc bodies.
 */
export function splitShell(src: string): string[][] {
  const cmds: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  const heredocs: string[] = [];
  let i = 0;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCmd = () => {
    endWord();
    if (words.length) cmds.push(words);
    words = [];
  };
  const skipRedirectTarget = () => {
    while (src[i] === ' ' || src[i] === '\t') i++;
    while (i < src.length && !/[\s;&|<>()]/.test(src[i]!)) {
      const q = src[i];
      if (q === '"' || q === "'") {
        const j = src.indexOf(q, i + 1);
        i = j < 0 ? src.length : j + 1;
      } else i++;
    }
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === '\\') {
      if (src[i + 1] === '\n') i += 2;
      else {
        if (i + 1 < src.length) ((word += src[i + 1]), (inWord = true));
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? src.length : j;
      word += src.slice(i + 1, end);
      inWord = true;
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length && '"\\$`\n'.includes(src[j + 1]!)) {
          if (src[j + 1] !== '\n') word += src[j + 1];
          j += 2;
          continue;
        }
        word += src[j];
        j++;
      }
      inWord = true;
      i = j + 1;
      continue;
    }
    if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '\n') {
      endCmd();
      i++;
      // Heredoc bodies are data, not commands: skip them up to their delimiter line.
      while (heredocs.length) {
        const delim = heredocs.shift()!;
        while (i < src.length) {
          const nl = src.indexOf('\n', i);
          const line = src.slice(i, nl < 0 ? src.length : nl);
          i = nl < 0 ? src.length : nl + 1;
          if (line.replace(/^\t+/, '').trim() === delim) break;
        }
      }
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    // `{ cmd; }` groups: `{` opens only before whitespace and `}` closes only as its own word (`{}`, `${x}` stay words).
    const braceGroup = (c === '{' && !inWord && /\s/.test(src[i + 1] ?? '')) || (c === '}' && !inWord);
    if (c === ';' || c === '|' || c === '(' || c === ')' || c === '`' || braceGroup) {
      endCmd();
      i++;
      continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      endCmd();
      i += 2;
      continue;
    }
    if (c === '&') {
      if (src[i + 1] === '>') {
        endWord();
        i += 2;
        if (src[i] === '>') i++;
        skipRedirectTarget();
        continue;
      }
      endCmd();
      i++;
      continue;
    }
    if (c === '>' || c === '<') {
      if (inWord && /^\d+$/.test(word)) ((word = ''), (inWord = false));
      else endWord();
      if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
        i += 2;
        if (src[i] === '-') i++;
        while (src[i] === ' ' || src[i] === '\t') i++;
        let delim = '';
        while (i < src.length && !/[\s;&|<>()]/.test(src[i]!)) {
          if (!`"'\\`.includes(src[i]!)) delim += src[i];
          i++;
        }
        if (delim) heredocs.push(delim);
        continue;
      }
      i++;
      while (i < src.length && '<>&|'.includes(src[i]!)) i++;
      skipRedirectTarget();
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endCmd();
  return cmds;
}

// ── command normalisation ───────────────────────────────────────────────────

const base = (p: string | undefined): string => (p ?? '').split('/').pop() ?? '';
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Wrapper programs → their options that take a value. */
const WRAPPERS: Record<string, ReadonlySet<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-U', '-T', '-r', '-t', '-D']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
  nice: new Set(['-n', '--adjustment']),
  ionice: new Set(['-c', '-n', '-p']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  stdbuf: new Set(['-i', '-o', '-e']),
  xargs: new Set([
    '-I',
    '-i',
    '-n',
    '-P',
    '-L',
    '-l',
    '-d',
    '-E',
    '-e',
    '-s',
    '-a',
    '--arg-file',
    '--delimiter',
    '--max-args',
    '--max-procs',
    '--replace',
  ]),
  command: new Set(),
  exec: new Set(['-a']),
  nohup: new Set(),
  time: new Set(['-f', '-o']),
};

/** Drop leading VAR=value assignments and wrappers such as sudo/env/nohup/timeout/xargs. */
export function stripWrappers(words: string[]): string[] {
  let w = words;
  for (let round = 0; round < 8; round++) {
    let i = 0;
    while (i < w.length && ASSIGNMENT.test(w[i]!)) i++;
    w = w.slice(i);
    const prog = base(w[0]);
    const valued = WRAPPERS[prog];
    if (!valued) return w;
    i = 1;
    while (i < w.length) {
      const t = w[i]!;
      if (t === '--') {
        i++;
        break;
      }
      if (prog === 'env' && ASSIGNMENT.test(t)) i++;
      else if (t.startsWith('-') && t.length > 1) i += valued.has(t) ? 2 : 1;
      else break;
    }
    if (prog === 'timeout' && i < w.length) i++; // the duration
    w = w.slice(i);
  }
  return w;
}

const RUNNER_VALUED = new Set([
  '-p',
  '--package',
  '-c',
  '--call',
  '--filter',
  '-F',
  '-C',
  '--dir',
  '--prefix',
  '--cwd',
]);

function skipOptions(args: string[], valued: ReadonlySet<string>): string[] {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-') && args[i]!.length > 1)
    i += valued.has(args[i]!) ? 2 : 1;
  return args.slice(i);
}

/** `npx prisma …`, `pnpm exec knex …`, `bundle exec rails …`, `uv run alembic …`, `python -m alembic …` → the tool itself. */
function unwrapRunner(w: string[]): string[] | null {
  const p = base(w[0]);
  if (p === 'npx' || p === 'pnpx' || p === 'bunx') return skipOptions(w.slice(1), RUNNER_VALUED);
  if (p === 'npm' || p === 'pnpm' || p === 'yarn' || p === 'bun') {
    const rest = skipOptions(w.slice(1), RUNNER_VALUED);
    if (rest[0] === 'exec' || rest[0] === 'dlx' || rest[0] === 'x')
      return skipOptions(rest.slice(1), RUNNER_VALUED);
    return p === 'npm' ? null : rest; // pnpm / yarn / bun run package binaries directly
  }
  if (p === 'bundle' && w[1] === 'exec') return w.slice(2);
  if (['poetry', 'uv', 'pipenv', 'pdm', 'hatch', 'rye'].includes(p) && w[1] === 'run')
    return skipOptions(w.slice(2), new Set());
  if (/^python[0-9.]*$/.test(p)) {
    const m = w.indexOf('-m');
    return m > 0 ? w.slice(m + 1) : skipOptions(w.slice(1), new Set(['-W', '-X', '-c']));
  }
  return null;
}

function candidates(words: string[]): string[][] {
  const out = [words];
  let cur: string[] | null = words;
  for (let k = 0; k < 3 && cur; k++) {
    cur = unwrapRunner(cur);
    if (cur?.length) out.push(cur);
  }
  return out;
}

/** Positional arguments, skipping options (and the values of options known to take one). */
function positionals(args: string[], valued: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!;
    if (t === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (t.startsWith('-') && t.length > 1) {
      if (valued.has(t)) i++;
      continue;
    }
    out.push(t);
  }
  return out;
}

// ── rules ────────────────────────────────────────────────────────────────────

function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
}

const GIT_GLOBAL_VALUED = new Set([
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
  '--super-prefix',
]);

function matchGitPush(w: string[], opts: MatchOptions): ProtectedHit | null {
  if (base(w[0]) !== 'git') return null;
  let i = 1;
  let dir: string | null = null;
  while (i < w.length && w[i]!.startsWith('-')) {
    const t = w[i]!;
    if (t === '-C') {
      dir = w[i + 1] ?? null;
      i += 2;
    } else i += GIT_GLOBAL_VALUED.has(t) ? 2 : 1;
  }
  if (w[i] !== 'push') return null;
  const args = w.slice(i + 1);
  let force = false;
  let mirror = false;
  let all = false;
  let del = false;
  let dryRun = false;
  let tagsOnly = false;
  let repoFlag = false;
  const positional: string[] = [];
  for (let k = 0; k < args.length; k++) {
    const t = args[k]!;
    if (t === '--') {
      positional.push(...args.slice(k + 1));
      break;
    }
    if (t.startsWith('--')) {
      const name = t.split('=')[0]!;
      if (name === '--force' || name === '--force-with-lease' || name === '--force-if-includes') force = true;
      else if (name === '--mirror') mirror = true;
      else if (name === '--all' || name === '--branches') all = true;
      else if (name === '--delete') del = true;
      else if (name === '--dry-run') dryRun = true;
      else if (name === '--tags') tagsOnly = true;
      else if (name === '--repo') {
        repoFlag = true;
        if (!t.includes('=')) k++;
      } else if (['--push-option', '--receive-pack', '--exec'].includes(name) && !t.includes('=')) k++;
      continue;
    }
    if (t.startsWith('-') && t.length > 1) {
      for (let j = 1; j < t.length; j++) {
        const f = t[j];
        if (f === 'f') force = true;
        else if (f === 'd') del = true;
        else if (f === 'n') dryRun = true;
        else if (f === 'o') {
          if (j === t.length - 1) k++;
          break;
        }
      }
      continue;
    }
    positional.push(t);
  }
  if (dryRun) return null;
  if (mirror) return { test: 'main', label: 'git push --mirror' };
  if (all) return { test: 'main', label: 'git push --all' };
  if (force) return { test: 'main', label: 'git push --force' };
  const patterns = (opts.protectedBranches ?? DEFAULT_PROTECTED_BRANCHES).map(globToRegExp);
  const isProtected = (branch: string) => patterns.some((re) => re.test(branch));
  const current = () => opts.currentBranch?.(dir) ?? null;
  const refspecs = repoFlag ? positional : positional.slice(1);
  if (!refspecs.length) {
    if (tagsOnly) return null;
    const branch = current();
    return branch && isProtected(branch)
      ? { test: 'main', label: `git push (current branch ${branch})` }
      : null;
  }
  for (const spec of refspecs) {
    if (spec.startsWith('+')) return { test: 'main', label: 'git push +refspec (force)' };
    let dst = spec.includes(':') ? spec.slice(spec.indexOf(':') + 1) : spec;
    if (dst === 'HEAD' || dst === '@') dst = current() ?? dst;
    dst = dst.replace(/^refs\/heads\//, '');
    if (!dst || dst.startsWith('refs/')) continue;
    if (isProtected(dst))
      return { test: 'main', label: `git push ${del || spec.startsWith(':') ? '--delete ' : ''}to ${dst}` };
  }
  return null;
}

const VALUED = new Set([
  '-n',
  '--namespace',
  '--context',
  '--kube-context',
  '--kubeconfig',
  '--cluster',
  '-s',
  '--server',
  '--user',
  '--token',
  '-f',
  '--filename',
  '-l',
  '--selector',
  '-o',
  '--output',
  '-R',
  '--repo',
  '-H',
  '--host',
  '-c',
  '--config',
  '-a',
  '--app',
  '--project',
  '--region',
  '--profile',
  '-t',
  '--tag',
  '--file',
  '-C',
  '--chdir',
  '-e',
  '--env',
  '--stage',
  '-F',
  '--filter',
  '--dir',
  '--cwd',
  '-x',
]);

type Rule = (pos: string[], args: string[], prog: string) => string | null;
const pick = (set: string[], x: string | undefined) => (x !== undefined && set.includes(x) ? x : null);

const KUBE_MUTATING = ['apply', 'delete', 'replace', 'patch', 'create', 'scale', 'set', 'edit', 'drain'];
const kube: Rule = (p, _a, prog) =>
  pick(KUBE_MUTATING, p[0])
    ? `${prog} ${p[0]}`
    : p[0] === 'rollout' && pick(['restart', 'undo', 'resume', 'pause'], p[1])
      ? `${prog} rollout ${p[1]}`
      : null;
const terraform: Rule = (p, _a, prog) => (pick(['apply', 'destroy'], p[0]) ? `${prog} ${p[0]}` : null);
const publish: Rule = (p, _a, prog) =>
  p[0] === 'publish' || (p[0] === 'npm' && p[1] === 'publish') ? `${prog} publish` : null;
const verbs =
  (list: string[]): Rule =>
  (p, _a, prog) =>
    pick(list, p[0]) ? `${prog} ${p[0]}` : null;

const DEPLOY_RULES: Record<string, Rule> = {
  kubectl: kube,
  oc: kube,
  terraform,
  tofu: terraform,
  terragrunt: (p) => {
    const v = p.slice(0, 2).find((x) => x === 'apply' || x === 'destroy');
    return v ? `terragrunt ${v}` : null;
  },
  helm: verbs(['install', 'upgrade', 'uninstall', 'delete', 'rollback']),
  vercel: (p, a) =>
    a.includes('--prod') || a.includes('--production') || p[0] === 'promote' ? 'vercel --prod' : null,
  vc: (p, a) =>
    a.includes('--prod') || a.includes('--production') || p[0] === 'promote' ? 'vercel --prod' : null,
  netlify: (p, a) =>
    p[0] === 'deploy' && a.some((x) => x === '--prod' || x === '--prodIfUnlocked')
      ? 'netlify deploy --prod'
      : null,
  fly: verbs(['deploy']),
  flyctl: verbs(['deploy']),
  npm: publish,
  pnpm: publish,
  yarn: publish,
  bun: publish,
  gh: (p) =>
    (p[0] === 'release' && p[1] === 'create') || (p[0] === 'pr' && p[1] === 'merge')
      ? `gh ${p[0]} ${p[1]}`
      : null,
  docker: (p, a, prog) =>
    p[0] === 'push' ||
    (p[0] === 'image' && p[1] === 'push') ||
    ((p[0] === 'buildx' || p[0] === 'build') && a.includes('--push')) ||
    (p[0] === 'compose' && p.includes('push'))
      ? `${prog} push`
      : null,
  gcloud: (p) => (p.includes('deploy') ? 'gcloud deploy' : null),
  aws: (p) => (p.slice(0, 2).includes('deploy') ? 'aws deploy' : null),
  cdk: verbs(['deploy', 'destroy']),
  serverless: verbs(['deploy', 'remove']),
  sls: verbs(['deploy', 'remove']),
  pulumi: verbs(['up', 'update', 'destroy']),
  wrangler: verbs(['deploy', 'publish']),
  firebase: verbs(['deploy']),
};
DEPLOY_RULES.podman = DEPLOY_RULES.docker!;

const RAILS_DB =
  /^db:(migrate(:(up|down|redo|reset))?|drop(:all)?|reset|rollback|schema:load|purge|truncate_all|setup|seed:replant)$/;
const findIn = (re: RegExp) => (p: string[], _a: string[], prog: string) => {
  const x = p.find((y) => re.test(y));
  return x ? `${prog} ${x}` : null;
};

const DATA_RULES: Record<string, Rule> = {
  prisma: (p, a) =>
    (p[0] === 'migrate' && pick(['deploy', 'reset'], p[1])) ||
    (p[0] === 'db' && p[1] === 'push' && a.some((x) => x === '--force-reset' || x === '--accept-data-loss'))
      ? `prisma ${p[0]} ${p[1]}`
      : null,
  rails: findIn(RAILS_DB),
  rake: findIn(RAILS_DB),
  knex: findIn(/^migrate:(latest|rollback|up|down|unlock)$/),
  alembic: verbs(['upgrade', 'downgrade']),
  'manage.py': verbs(['migrate', 'flush']),
  'django-admin': verbs(['migrate', 'flush']),
  sequelize: findIn(/^db:(migrate|migrate:undo(:all)?|drop|seed:undo(:all)?)$/),
  'sequelize-cli': findIn(/^db:(migrate|migrate:undo(:all)?|drop|seed:undo(:all)?)$/),
  typeorm: findIn(/^(migration:(run|revert)|schema:(drop|sync))$/),
  flyway: findIn(/^(migrate|clean|undo|repair)$/),
  liquibase: findIn(/^(update|rollback|rollback-count|rollback-to-date|drop-all|dropAll)$/),
  diesel: (p) =>
    (p[0] === 'migration' && pick(['run', 'revert', 'redo'], p[1])) ||
    (p[0] === 'database' && pick(['reset', 'drop'], p[1]))
      ? `diesel ${p[0]} ${p[1]}`
      : null,
  goose: findIn(/^(up|up-by-one|up-to|down|down-to|reset|redo)$/),
};

const SQL_CLIENTS = new Set([
  'psql',
  'mysql',
  'mariadb',
  'sqlite3',
  'sqlite',
  'sqlcmd',
  'clickhouse-client',
  'cockroach',
]);
const DESTRUCTIVE_SQL =
  /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX|VIEW|MATERIALIZED\s+VIEW|COLUMN|CONSTRAINT|USER|ROLE|TRIGGER|FUNCTION|SEQUENCE|TYPE|EXTENSION|OWNED)|TRUNCATE|DELETE\s+FROM)\b/i;
const CONTAINER_EXEC = new Set(['docker', 'podman', 'kubectl', 'oc']);

function usesProgram(cmds: string[][], programs: ReadonlySet<string>): boolean {
  return cmds.some(
    (w) =>
      programs.has(base(w[0])) || (CONTAINER_EXEC.has(base(w[0])) && w.some((x) => programs.has(base(x)))),
  );
}

/** Classify a Bash command line; null when it is not a protected operation (or is hidden from pattern matching). */
export function matchProtectedOperation(command: string, opts: MatchOptions = {}): ProtectedHit | null {
  const cmds = splitShell(command)
    .map(stripWrappers)
    .filter((w) => w.length);
  for (const words of cmds) {
    for (const cand of candidates(words)) {
      const push = matchGitPush(cand, opts);
      if (push) return push;
      const prog = base(cand[0]).startsWith('typeorm') ? 'typeorm' : base(cand[0]);
      const args = cand.slice(1);
      const pos = positionals(args, VALUED);
      const deploy = DEPLOY_RULES[prog]?.(pos, args, prog);
      if (deploy) return { test: 'production', label: deploy };
      const data = DATA_RULES[prog]?.(pos, args, prog);
      if (data) return { test: 'data', label: data };
    }
  }
  if (DESTRUCTIVE_SQL.test(command) && usesProgram(cmds, SQL_CLIENTS))
    return { test: 'data', label: 'destructive SQL (DROP / TRUNCATE / DELETE FROM)' };
  if (/\bflush(?:all|db)\b/i.test(command) && usesProgram(cmds, new Set(['redis-cli'])))
    return { test: 'data', label: 'redis FLUSHALL / FLUSHDB' };
  if (
    /dropDatabase\s*\(|\.drop\s*\(|deleteMany\s*\(/.test(command) &&
    usesProgram(cmds, new Set(['mongo', 'mongosh']))
  ) {
    return { test: 'data', label: 'destructive mongo operation' };
  }
  return null;
}

const CONTEXT_LIMIT = 4000;

export function createProtectedOpGuard(
  opts: { protectedBranches?: string[]; currentBranch?: (dir: string) => string | null } = {},
): PreToolGuard {
  return {
    name: 'protected-op',
    order: 30,
    evaluate(ctx: PreToolContext): GuardResult | null {
      if (ctx.toolName !== 'Bash') return null;
      const command = ctx.toolInput['command'];
      if (typeof command !== 'string' || !command.trim()) return null;
      const cwd = ctx.cwd || ctx.session.cwd || null;
      const hit = matchProtectedOperation(command, {
        protectedBranches: opts.protectedBranches,
        currentBranch: (dir) =>
          opts.currentBranch && cwd ? opts.currentBranch(resolve(cwd, dir ?? '.')) : null,
      });
      if (!hit) return null;
      const info = DECISION_TEST_INFO[hit.test];
      return {
        decision: 'deny',
        guard: 'protected-op',
        blockReason: 'protected_operation',
        reason:
          `AOC blocked a protected operation (test ${info.no}: ${info.label}): ${hit.label}. ` +
          'A decision card was raised for the approver. End your turn; the supervisor resumes this session with the answer.',
        raiseDecision: {
          kind: 'protected_operation',
          test: hit.test,
          title: `Protected operation: ${hit.label}`,
          question: `The agent attempted a protected operation (${info.label.toLowerCase()}). Allow it to run?`,
          options: [
            { id: 'approve', label: 'Approve', description: 'Let the agent run this command.' },
            { id: 'reject', label: 'Reject', description: 'Keep it blocked.' },
          ],
          context: command.length > CONTEXT_LIMIT ? `${command.slice(0, CONTEXT_LIMIT)}…` : command,
          subjectType: 'session',
          subjectId: ctx.session.sessionId,
          sessionId: ctx.session.sessionId,
          projectId: ctx.session.projectId,
        },
      };
    },
  };
}
