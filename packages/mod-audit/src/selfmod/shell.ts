/**
 * Bash write-target analysis for the self-modification guard. Command matching is a speed bump, not a wall
 * (§2.4): it catches the direct forms (redirects, rm/mv/cp/tee/sed -i/…, git checkout --, git apply, patch,
 * sh -c, inline interpreter code, find -delete, xargs) without denying read-only commands that merely mention a
 * protected path. Variables are unknown; a word that starts with one is skipped, a literal prefix
 * (`packages/kernel/$F`) is matched as a glob.
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { BoundaryMatcher, ProtectedHit } from './matcher';
import { physicalPath } from './paths';

export interface Word {
  text: string;
  /** Contains an expansion ($VAR, $(…), `…`), replaced by `*` in `text`. */
  dynamic: boolean;
  /** Starts with an expansion — location unknown, never matched. */
  leadingDynamic: boolean;
}

interface Redirect {
  op: string;
  fd: number | null;
  target: Word | null;
  /** Here-document / here-string content. */
  body: string | null;
}

interface Cmd {
  words: Word[];
  redirects: Redirect[];
}

export type ShellFindingKind =
  'redirect' | 'command' | 'patch' | 'patch_unverifiable' | 'interpreter' | 'xargs' | 'too_large';

export interface ShellFinding {
  kind: ShellFindingKind;
  hit: ProtectedHit | null;
}

const MAX_COMMAND = 1024 * 1024;
const MAX_DEPTH = 4;
const MAX_READ = 2 * 1024 * 1024;

// ── lexer ────────────────────────────────────────────────────────────────────
type Tok = { t: 'w'; w: Word } | { t: 'op'; op: string; fd: number | null; body: string | null };

const OPS = [
  '&&',
  '||',
  ';;&',
  ';;',
  ';&',
  '|&',
  '<<<',
  '<<-',
  '<<',
  '>>',
  '>|',
  '>&',
  '<&',
  '<>',
  '&>>',
  '&>',
  '>',
  '<',
  '|',
  '&',
  ';',
  '(',
  ')',
  '\n',
];
const REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<', '<>', '<<', '<<-', '<<<', '>&', '<&']);
const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&']);

function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === "'") {
      const e = src.indexOf("'", i + 1);
      i = e === -1 ? src.length : e;
    } else if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) if (src[i] === '\\') i++;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return src.length;
}

function matchBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return i;
  }
  return src.length;
}

function lex(src: string, subs: string[]): Tok[] {
  const toks: Tok[] = [];
  let buf = '';
  let inWord = false;
  let dynamic = false;
  let leadingDynamic = false;
  const pending: { delim: string; strip: boolean; tok: Extract<Tok, { t: 'op' }> }[] = [];

  const flush = () => {
    if (inWord) toks.push({ t: 'w', w: { text: buf, dynamic, leadingDynamic } });
    buf = '';
    inWord = false;
    dynamic = false;
    leadingDynamic = false;
  };
  const expansion = (inner: string | null) => {
    if (inner !== null) subs.push(inner);
    if (!inWord || buf === '') leadingDynamic = true;
    buf += '*';
    dynamic = true;
    inWord = true;
  };
  /** `$…` at i; returns the index after it. */
  const dollar = (i: number): number => {
    const n = src[i + 1];
    if (n === '(') {
      const end = matchParen(src, i + 1);
      expansion(src.slice(i + 2, end));
      return end + 1;
    }
    if (n === '{') {
      const end = matchBrace(src, i + 1);
      expansion(src.slice(i + 2, end));
      return end + 1;
    }
    if (n !== undefined && /[A-Za-z0-9_@*#?$!-]/.test(n)) {
      let j = i + 1;
      if (/[A-Za-z_]/.test(n)) while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      else j++;
      expansion(null);
      return j;
    }
    buf += '$';
    inWord = true;
    return i + 1;
  };
  const readDelimiter = (start: number): [string, number] => {
    let i = start;
    while (src[i] === ' ' || src[i] === '\t') i++;
    let d = '';
    while (i < src.length && !/[\s;&|<>()]/.test(src[i]!)) {
      const c = src[i]!;
      if (c === "'" || c === '"') {
        const e = src.indexOf(c, i + 1);
        d += src.slice(i + 1, e === -1 ? src.length : e);
        i = e === -1 ? src.length : e + 1;
      } else if (c === '\\') {
        d += src[i + 1] ?? '';
        i += 2;
      } else {
        d += c;
        i++;
      }
    }
    return [d, i];
  };
  const readHeredocs = (start: number): number => {
    let i = start;
    for (const h of pending.splice(0)) {
      const lines: string[] = [];
      for (;;) {
        if (i >= src.length) break;
        const nl = src.indexOf('\n', i);
        const line = src.slice(i, nl === -1 ? src.length : nl);
        i = nl === -1 ? src.length : nl + 1;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        lines.push(line);
      }
      h.tok.body = lines.join('\n');
    }
    return i;
  };

  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\r') {
      flush();
      i++;
    } else if (c === '\\') {
      if (src[i + 1] !== '\n') {
        buf += src[i + 1] ?? '';
        inWord = true;
      }
      i += 2;
    } else if (c === "'") {
      const e = src.indexOf("'", i + 1);
      buf += src.slice(i + 1, e === -1 ? src.length : e);
      inWord = true;
      i = e === -1 ? src.length : e + 1;
    } else if (c === '"') {
      inWord = true;
      i++;
      while (i < src.length && src[i] !== '"') {
        const d = src[i]!;
        if (d === '\\' && /[$`"\\\n]/.test(src[i + 1] ?? '')) {
          if (src[i + 1] !== '\n') buf += src[i + 1];
          i += 2;
        } else if (d === '$') i = dollar(i);
        else if (d === '`') {
          const e = src.indexOf('`', i + 1);
          expansion(src.slice(i + 1, e === -1 ? src.length : e));
          i = e === -1 ? src.length : e + 1;
        } else {
          buf += d;
          i++;
        }
      }
      i++;
    } else if (c === '$' && src[i + 1] === "'") {
      const e = src.indexOf("'", i + 2);
      buf += src.slice(i + 2, e === -1 ? src.length : e).replace(/\\(.)/g, '$1');
      inWord = true;
      i = e === -1 ? src.length : e + 1;
    } else if (c === '$') {
      i = dollar(i);
    } else if (c === '`') {
      const e = src.indexOf('`', i + 1);
      expansion(src.slice(i + 1, e === -1 ? src.length : e));
      i = e === -1 ? src.length : e + 1;
    } else if (c === '#' && !inWord) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
    } else if ((c === '<' || c === '>') && src[i + 1] === '(') {
      const end = matchParen(src, i + 1);
      expansion(src.slice(i + 2, end));
      i = end + 1;
    } else {
      const op = OPS.find((o) => src.startsWith(o, i));
      if (!op) {
        buf += c;
        inWord = true;
        i++;
        continue;
      }
      let fd: number | null = null;
      if ((op[0] === '>' || op[0] === '<') && inWord && !dynamic && /^\d+$/.test(buf)) {
        fd = Number(buf);
        buf = '';
        inWord = false;
      } else flush();
      const tok: Extract<Tok, { t: 'op' }> = { t: 'op', op, fd, body: null };
      toks.push(tok);
      i += op.length;
      if (op === '<<' || op === '<<-') {
        const [delim, next] = readDelimiter(i);
        pending.push({ delim, strip: op === '<<-', tok });
        i = next;
      } else if (op === '\n' && pending.length) i = readHeredocs(i);
    }
  }
  flush();
  for (const h of pending) h.tok.body = '';
  return toks;
}

function parse(toks: Tok[]): Cmd[][] {
  const pipelines: Cmd[][] = [];
  let pipe: Cmd[] = [];
  let cmd: Cmd = { words: [], redirects: [] };
  const endCmd = () => {
    if (cmd.words.length || cmd.redirects.length) pipe.push(cmd);
    cmd = { words: [], redirects: [] };
  };
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k]!;
    if (tk.t === 'w') {
      cmd.words.push(tk.w);
      continue;
    }
    if (REDIRECTS.has(tk.op)) {
      const r: Redirect = { op: tk.op, fd: tk.fd, target: null, body: tk.body };
      if (tk.op !== '<<' && tk.op !== '<<-') {
        const nx = toks[k + 1];
        if (nx?.t === 'w') {
          r.target = nx.w;
          k++;
        }
        if (tk.op === '<<<') r.body = r.target?.text ?? '';
      }
      cmd.redirects.push(r);
    } else if (tk.op === '|' || tk.op === '|&') {
      endCmd();
    } else {
      endCmd();
      if (pipe.length) pipelines.push(pipe);
      pipe = [];
    }
  }
  endCmd();
  if (pipe.length) pipelines.push(pipe);
  return pipelines;
}

// ── analysis ─────────────────────────────────────────────────────────────────
interface Ctx {
  m: BoundaryMatcher;
  cwds: string[];
  cmd: Cmd;
  pipe: Cmd[];
  depth: number;
}

const word = (text: string): Word => ({ text, dynamic: false, leadingDynamic: false });
const expandTilde = (t: string) => (t === '~' ? homedir() : t.startsWith('~/') ? homedir() + t.slice(1) : t);

/** Bash brace expansion (`a/{b,c}` → a/b, a/c; `{1..3}` → `*`), capped. Quoted braces are expanded too (conservative). */
export function expandBraces(text: string, limit = 64): string[] {
  let out = [text];
  for (let guard = 0; guard < 8; guard++) {
    let changed = false;
    const next: string[] = [];
    for (const t of out) {
      const m = /\{([^{}]*(?:,|\.\.)[^{}]*)\}/.exec(t);
      if (!m) {
        next.push(t);
        continue;
      }
      changed = true;
      const alts = m[1]!.includes(',') ? m[1]!.split(',') : ['*'];
      for (const a of alts) next.push(t.slice(0, m.index) + a + t.slice(m.index + m[0].length));
    }
    out = next.slice(0, limit);
    if (!changed) break;
  }
  return out;
}

function hitWord(w: Word, cwds: string[], m: BoundaryMatcher, subtree: boolean): ProtectedHit | null {
  if (w.leadingDynamic || w.text === '' || w.text === '-') return null;
  for (const text of expandBraces(expandTilde(w.text))) {
    for (const cwd of cwds) {
      const h = m.check(text, cwd, subtree);
      if (h) return h;
    }
  }
  return null;
}

function hitAll(
  words: Word[],
  c: Ctx,
  subtree: boolean,
  kind: ShellFindingKind = 'command',
): ShellFinding | null {
  for (const w of words) {
    const hit = hitWord(w, c.cwds, c.m, subtree);
    if (hit) return { kind, hit };
  }
  return null;
}

function cdInto(target: Word | undefined, cwds: string[]): string[] {
  if (target?.leadingDynamic || target?.text === '-') return cwds;
  const t = target ? expandTilde(target.text) : homedir();
  return [...new Set([...cwds, ...cwds.map((c) => physicalPath(t, c))])].slice(0, 16);
}

interface Parsed {
  pos: Word[];
  flags: Set<string>;
  values: Map<string, Word[]>;
  afterDashDash: Word[];
}

function parseArgs(args: Word[], withValue: readonly string[] = []): Parsed {
  const out: Parsed = { pos: [], flags: new Set(), values: new Map(), afterDashDash: [] };
  const add = (k: string, w: Word) => out.values.set(k, [...(out.values.get(k) ?? []), w]);
  let dashdash = false;
  for (let k = 0; k < args.length; k++) {
    const w = args[k]!;
    const t = w.text;
    if (dashdash) {
      out.pos.push(w);
      out.afterDashDash.push(w);
    } else if (t === '--') dashdash = true;
    else if (t === '-' || !t.startsWith('-') || w.leadingDynamic) out.pos.push(w);
    else if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq === -1 ? t : t.slice(0, eq);
      out.flags.add(name);
      if (eq !== -1) add(name, { ...w, text: t.slice(eq + 1) });
      else if (withValue.includes(name) && k + 1 < args.length) add(name, args[++k]!);
    } else {
      for (let j = 1; j < t.length; j++) {
        const f = `-${t[j]}`;
        out.flags.add(f);
        if (withValue.includes(f)) {
          const rest = t.slice(j + 1);
          if (rest) add(f, { ...w, text: rest });
          else if (k + 1 < args.length) add(f, args[++k]!);
          break;
        }
      }
    }
  }
  return out;
}

const vals = (p: Parsed, ...names: string[]) => names.flatMap((n) => p.values.get(n) ?? []);

/** Every word that is not a flag (after `--` everything) plus `--opt=value` values — immune to option-value misparsing. */
function nonFlagWords(args: Word[]): Word[] {
  const out: Word[] = [];
  let dashdash = false;
  for (const w of args) {
    if (dashdash || w.leadingDynamic || w.text === '-' || !w.text.startsWith('-')) out.push(w);
    else if (w.text === '--') dashdash = true;
    else if (w.text.startsWith('--') && w.text.includes('='))
      out.push({ ...w, text: w.text.slice(w.text.indexOf('=') + 1) });
  }
  return out;
}

function statAt(w: Word, cwds: string[]): ReturnType<typeof statSync> | null {
  if (w.dynamic) return null;
  for (const cwd of cwds) {
    try {
      return statSync(physicalPath(expandTilde(w.text), cwd));
    } catch {
      // try the next cwd
    }
  }
  return null;
}

function readSmall(w: Word, cwds: string[]): string | null {
  const st = statAt(w, cwds);
  if (!st?.isFile() || st.size > MAX_READ) return null;
  for (const cwd of cwds) {
    try {
      return readFileSync(physicalPath(expandTilde(w.text), cwd), 'utf8');
    } catch {
      // try the next cwd
    }
  }
  return null;
}

const COPY_VALUE_OPTS: Record<string, string[]> = {
  cp: ['-t', '--target-directory', '-S', '--suffix'],
  mv: ['-t', '--target-directory', '-S', '--suffix'],
  ln: ['-t', '--target-directory', '-S', '--suffix'],
  install: ['-t', '--target-directory', '-S', '--suffix', '-m', '--mode', '-o', '--owner', '-g', '--group'],
  rsync: [
    '-e',
    '--rsh',
    '--exclude',
    '--include',
    '--filter',
    '-f',
    '--backup-dir',
    '--chmod',
    '--chown',
    '--log-file',
    '--partial-dir',
    '--temp-dir',
    '-T',
    '--suffix',
  ],
  scp: ['-i', '-P', '-o', '-F', '-c', '-l', '-S', '-J'],
};

/** cp / mv / install / ln / rsync / scp: the destination, or dest/basename(src) when copying into a directory. */
function copyTargets(
  args: Word[],
  c: Ctx,
  name: string,
): { targets: Word[]; sources: Word[]; dest: Word; recursive: boolean } | null {
  const p = parseArgs(args, COPY_VALUE_OPTS[name] ?? []);
  const tdir = vals(p, '-t', '--target-directory')[0];
  if (name === 'install' && p.flags.has('-d'))
    return p.pos[0] ? { targets: p.pos, sources: [], dest: p.pos[0], recursive: false } : null;
  let sources = p.pos;
  let dest = tdir;
  if (!dest) {
    dest = sources[sources.length - 1];
    sources = sources.slice(0, -1);
  }
  if (!dest) return null;
  const recursive = ['-r', '-R', '-a', '--recursive', '--archive'].some((f) => p.flags.has(f));
  const deleting = [...p.flags].some((f) => f.startsWith('--delete'));
  const intoDir =
    !!tdir || sources.length > 1 || dest.text.endsWith('/') || statAt(dest, c.cwds)?.isDirectory() === true;
  const targets: Word[] = [];
  if (intoDir && sources.length) {
    for (const s of sources) {
      const contents = name === 'rsync' && s.text.endsWith('/');
      const base = contents ? '*' : basename(s.text.replace(/\/+$/, '')) || '*';
      targets.push({ ...dest, text: join(dest.text, base) });
    }
  } else targets.push(dest);
  if (deleting) targets.push(dest);
  return { targets, sources, dest, recursive: recursive || deleting };
}

const WRITE_API =
  /\b(?:write\w*|append\w*|unlink\w*|remove\w*|rename\w*|replace|rmtree|rm(?:Sync|dir\w*)?|mkdir\w*|truncate\w*|copy\w*|move|chmod\w*|chown\w*|symlink\w*|touch|system|exec\w*|spawn\w*|popen|subprocess|run|tee|sed|patch|shutil|FileUtils|createWriteStream|mv|cp|ln|dd)\b|>|open\s*\([^)]*['"](?:[wax]|[rwa]\+)/i;

/** Inline interpreter code / awk programs: a protected path together with any write-capable API. */
function opaque(code: string, c: Ctx): ShellFinding | null {
  if (!code || !WRITE_API.test(code)) return null;
  const candidates = [...new Set(code.split(/[\s'"`(){}[\];,<>|&=!?$:\\]+/))]
    .filter((t) => t && t.length < 512 && /^[\w.@+~/*-]+$/.test(t))
    .slice(0, 2000);
  for (const t of candidates) {
    const hit = hitWord(word(t), c.cwds, c.m, false);
    if (hit) return { kind: 'interpreter', hit };
  }
  return null;
}

/** Text fed to a shell / interpreter through earlier pipeline stages (`echo '…' | sh`). */
function pipedTexts(c: Ctx): string[] {
  const out: string[] = [];
  for (const other of c.pipe) {
    if (other === c.cmd) break;
    out.push(
      other.words
        .slice(1)
        .map((w) => w.text)
        .join(' '),
    );
    for (const r of other.redirects) if (r.body !== null) out.push(r.body);
  }
  return out;
}

const bodies = (cmd: Cmd) => cmd.redirects.flatMap((r) => (r.body !== null ? [r.body] : []));

function diffPaths(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split('\n')) {
    let m: RegExpExecArray | null;
    if ((m = /^diff --git (\S+) (\S+)/.exec(line))) {
      out.add(m[1]!);
      out.add(m[2]!);
    } else if ((m = /^(?:---|\+\+\+|\*\*\*) (\S+)/.exec(line))) out.add(m[1]!);
    else if ((m = /^(?:rename|copy) (?:from|to) (\S+)/.exec(line))) out.add(m[1]!);
    else if ((m = /^Index: (\S+)/.exec(line))) out.add(m[1]!);
  }
  out.delete('/dev/null');
  return [...out];
}

/** Every plausible on-disk spelling of a path named in a patch (-p0, -p1, basename). */
function patchCandidates(p: string): string[] {
  const clean = p.replace(/^"|"$/g, '');
  const parts = clean.split('/').filter(Boolean);
  return [...new Set([clean, parts.slice(1).join('/'), parts[parts.length - 1] ?? ''])].filter(Boolean);
}

/** git apply / git am / patch: read the patch (files, `<` input, here-docs) and check every path it touches. */
function patchCheck(c: Ctx, files: Word[], extraCwds: string[]): ShellFinding | null {
  const texts: string[] = [];
  let unverifiable = false;
  for (const f of files) {
    const t = readSmall(f, c.cwds);
    if (t === null) unverifiable = true;
    else texts.push(t);
  }
  let stdin = false;
  for (const r of c.cmd.redirects) {
    if (r.body !== null) {
      texts.push(r.body);
      stdin = true;
    } else if (r.op === '<' && r.target) {
      stdin = true;
      const t = readSmall(r.target, c.cwds);
      if (t === null) unverifiable = true;
      else texts.push(t);
    }
  }
  if (!files.length && !stdin) unverifiable = true;
  const cwds = [...new Set([...c.cwds, ...extraCwds])];
  for (const t of texts) {
    for (const p of diffPaths(t)) {
      for (const cand of patchCandidates(p)) {
        const hit = hitWord(word(cand), cwds, c.m, false);
        if (hit) return { kind: 'patch', hit };
      }
    }
  }
  if (unverifiable && c.cwds.some((d) => c.m.repoOf(d))) return { kind: 'patch_unverifiable', hit: null };
  return null;
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish']);
const CODE_FLAGS: Record<string, string[]> = {
  python: ['-c'],
  python2: ['-c'],
  python3: ['-c'],
  node: ['-e', '--eval', '-p', '--print'],
  nodejs: ['-e', '--eval', '-p', '--print'],
  bun: ['-e', '--eval', '-p', '--print'],
  deno: [],
  php: ['-r'],
  lua: ['-e'],
  rscript: ['-e'],
  osascript: ['-e'],
};
const ALWAYS_WRITE = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'srm',
  'mv',
  'cp',
  'install',
  'ln',
  'rsync',
  'tee',
  'truncate',
  'touch',
  'mkdir',
  'chmod',
  'chown',
  'chgrp',
  'dd',
  'patch',
  ...SHELLS,
]);
const GIT_WRITES = ['checkout', 'restore', 'rm', 'mv', 'clean', 'apply', 'am'];

/** Does this command line (name + args) modify files given as arguments? */
function writeish(words: Word[]): boolean {
  const name = basename(words[0]?.text ?? '').toLowerCase();
  if (ALWAYS_WRITE.has(name)) return true;
  if (name === 'sed' || name === 'perl' || name === 'ruby')
    return words.some((w) => /^-[a-zA-Z]*i/.test(w.text) || w.text.startsWith('--in-place'));
  if (name === 'git') return words.some((w) => GIT_WRITES.includes(w.text));
  return false;
}

/** Strip assignments, keywords and transparent wrappers (sudo, env, nohup, timeout, …). */
function commandOf(
  words: Word[],
  cwds: string[],
): { name: string | null; dynamicName: boolean; args: Word[]; cwds: string[] } {
  let k = 0;
  const n = words.length;
  const skipOpts = (withValue: string[] = []) => {
    while (k < n && words[k]!.text.startsWith('-') && words[k]!.text !== '-') {
      if (withValue.includes(words[k]!.text)) k++;
      k++;
    }
  };
  while (k < n) {
    const t = words[k]!.text;
    const base = basename(t).toLowerCase();
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(t) && !words[k]!.leadingDynamic) k++;
    else if (
      ['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time', 'coproc'].includes(t)
    )
      k++;
    else if (base === 'sudo' || base === 'doas') {
      k++;
      skipOpts(['-u', '-g', '-C', '-h', '-p', '-r', '-t', '-U', '-D']);
    } else if (base === 'env') {
      k++;
      while (k < n) {
        const e = words[k]!.text;
        if (e === '-C' || e === '--chdir') {
          cwds = cdInto(words[k + 1], cwds);
          k += 2;
        } else if (e.startsWith('--chdir=')) {
          cwds = cdInto({ ...words[k]!, text: e.slice(8) }, cwds);
          k++;
        } else if (e === '-u' || e === '-S' || e === '--unset') k += 2;
        else if ((e.startsWith('-') && e !== '-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(e)) k++;
        else break;
      }
    } else if (
      [
        'command',
        'builtin',
        'exec',
        'nohup',
        'chronic',
        'unbuffer',
        'stdbuf',
        'setsid',
        'nice',
        'ionice',
        'timeout',
        'caffeinate',
      ].includes(base)
    ) {
      k++;
      skipOpts(['-n', '-c', '-s', '-k', '--signal', '--kill-after', '-a']);
      if (base === 'timeout' && k < n) k++;
    } else break;
  }
  return {
    name: k < n ? basename(words[k]!.text).toLowerCase() : null,
    dynamicName: k < n && words[k]!.leadingDynamic,
    args: words.slice(k + 1),
    cwds,
  };
}

const XARGS_VALUE = [
  '-I',
  '-n',
  '-L',
  '-l',
  '-P',
  '-s',
  '-d',
  '-E',
  '-e',
  '-a',
  '--arg-file',
  '--delimiter',
  '--max-args',
  '--max-lines',
  '--max-procs',
  '--replace',
  '--eof',
  '--max-chars',
  '--process-slot-var',
];
const PATCH_VALUE = [
  '-i',
  '--input',
  '-d',
  '--directory',
  '-p',
  '--strip',
  '-o',
  '--output',
  '-r',
  '--reject-file',
  '-B',
  '--prefix',
  '-z',
  '--suffix',
  '-F',
  '--fuzz',
  '-D',
  '--ifdef',
  '-V',
  '--version-control',
  '-Y',
  '-g',
];

function analyzeCmd(c: Ctx): ShellFinding | null {
  for (const r of c.cmd.redirects) {
    if (!WRITE_REDIRECTS.has(r.op) || !r.target) continue;
    if (r.op === '>&' && /^(\d+|-)$/.test(r.target.text)) continue;
    const hit = hitWord(r.target, c.cwds, c.m, false);
    if (hit) return { kind: 'redirect', hit };
  }
  const { name, dynamicName, args, cwds } = commandOf(c.cmd.words, c.cwds);
  if (!name) return null;
  const cc: Ctx = { ...c, cwds };
  // `$EDITOR packages/kernel/x.ts`, `$(echo rm) -rf …`: an unknown program pointed at the core.
  if (dynamicName) return hitAll(args, cc, true);
  switch (name) {
    case 'rm':
    case 'shred':
    case 'srm':
      return hitAll(nonFlagWords(args), cc, true);
    case 'rmdir':
    case 'unlink':
    case 'tee':
    case 'truncate':
    case 'touch':
    case 'mkdir':
    case 'mkfifo':
    case 'sqlite3':
    case 'sqlite':
      return hitAll(nonFlagWords(args), cc, false);
    case 'chmod':
    case 'chown':
    case 'chgrp':
    case 'chattr':
    case 'setfacl':
      return hitAll(
        nonFlagWords(args),
        cc,
        args.some((w) => /^-[a-zA-Z]*R/.test(w.text) || w.text === '--recursive'),
      );
    case 'mv': {
      const t = copyTargets(args, cc, name);
      if (!t) return null;
      return (
        hitAll(
          nonFlagWords(args).filter((w) => w !== t.dest),
          cc,
          true,
        ) ?? hitAll(t.targets, cc, true)
      );
    }
    case 'cp':
    case 'install':
    case 'rsync':
    case 'scp': {
      const t = copyTargets(args, cc, name);
      return t ? hitAll(t.targets, cc, t.recursive) : null;
    }
    case 'ln': {
      // A link into the core is the first half of a write-through bypass; symlink sources resolve from the link's directory.
      const t = copyTargets(args, cc, name);
      if (!t) return null;
      const symbolic = args.some((w) => /^-[a-zA-Z]*s/.test(w.text) || w.text === '--symbolic');
      const sources = t.sources.flatMap((s) => [
        s,
        ...(symbolic && !s.text.startsWith('/')
          ? t.targets.map((x) => ({ ...s, text: join(dirname(x.text), s.text) }))
          : []),
      ]);
      return hitAll(t.targets, cc, false) ?? hitAll(sources, cc, false);
    }
    case 'dd':
      return hitAll(
        args.filter((w) => w.text.startsWith('of=')).map((w) => ({ ...w, text: w.text.slice(3) })),
        cc,
        false,
      );
    case 'sed':
    case 'perl':
    case 'ruby': {
      const inPlace = args.some((w) => /^-[a-zA-Z0-9]*i/.test(w.text) || w.text.startsWith('--in-place'));
      if (inPlace) return hitAll(nonFlagWords(args), cc, false);
      if (name === 'sed') return null;
      const p = parseArgs(args, ['-e', '-E']);
      return opaque([...vals(p, '-e', '-E').map((w) => w.text), ...bodies(c.cmd)].join('\n'), cc);
    }
    case 'awk':
    case 'gawk':
    case 'mawk':
    case 'nawk': {
      const p = parseArgs(args, ['-f', '-v', '-F']);
      return p.values.has('-f') ? null : opaque(p.pos[0]?.text ?? '', cc);
    }
    case 'git':
      return gitCmd(args, cc);
    case 'patch': {
      const p = parseArgs(args, PATCH_VALUE);
      const dir = vals(p, '-d', '--directory')[0];
      const pc: Ctx = dir ? { ...cc, cwds: cdInto(dir, cc.cwds) } : cc;
      const direct = hitAll(
        [...vals(p, '-o', '--output', '-r', '--reject-file'), ...p.pos.slice(0, 1)],
        pc,
        false,
        'patch',
      );
      if (direct) return direct;
      const input = vals(p, '-i', '--input');
      return patchCheck(pc, input.length ? input : p.pos.slice(1, 2), []);
    }
    case 'find':
      return findCmd(args, cc);
    case 'xargs':
    case 'parallel': {
      let k = 0;
      while (k < args.length && args[k]!.text.startsWith('-'))
        k += XARGS_VALUE.includes(args[k]!.text) ? 2 : 1;
      const inner = args.slice(k);
      if (!writeish(inner)) return null;
      const direct = analyzeCmd({ ...cc, cmd: { words: inner, redirects: [] } });
      if (direct) return direct;
      for (const other of c.pipe) {
        if (other === c.cmd) continue;
        for (const w of other.words) {
          const hit = hitWord(w, cc.cwds, cc.m, true);
          if (hit) return { kind: 'xargs', hit };
        }
      }
      return null;
    }
    case 'eval':
      return analyzeScript(args.map((w) => w.text).join(' '), cc.cwds, cc.m, c.depth + 1);
    case 'source':
    case '.': {
      const text = args[0] ? readSmall(args[0], cc.cwds) : null;
      return text === null ? null : analyzeScript(text, cc.cwds, cc.m, c.depth + 1);
    }
    default:
      break;
  }
  if (SHELLS.has(name)) {
    const ci = args.findIndex((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.text));
    const scripts: string[] = [];
    if (ci !== -1) scripts.push(args[ci + 1]?.text ?? '');
    else {
      scripts.push(...bodies(c.cmd));
      const file = args.find((w) => !w.text.startsWith('-'));
      const text = file ? readSmall(file, cc.cwds) : null;
      if (text !== null) scripts.push(text);
      if (!file) scripts.push(...pipedTexts(c));
    }
    for (const s of scripts) {
      const f = analyzeScript(s, cc.cwds, cc.m, c.depth + 1);
      if (f) return f;
    }
    return null;
  }
  const flags = CODE_FLAGS[name] ?? (/^python\d/.test(name) ? ['-c'] : null);
  if (flags) {
    const p = parseArgs(args, flags);
    const code = [...vals(p, ...flags).map((w) => w.text), ...bodies(c.cmd)];
    if (name === 'deno' && p.pos[0]?.text === 'eval')
      code.push(
        p.pos
          .slice(1)
          .map((w) => w.text)
          .join(' '),
      );
    if (!code.length) code.push(...pipedTexts(c));
    return opaque(code.join('\n'), cc);
  }
  return null;
}

function gitCmd(args: Word[], c: Ctx): ShellFinding | null {
  let k = 0;
  let cwds = c.cwds;
  while (k < args.length && args[k]!.text.startsWith('-')) {
    const t = args[k]!.text;
    if (t === '-C' || t === '--work-tree') {
      cwds = cdInto(args[k + 1], cwds);
      k += 2;
    } else if (t.startsWith('--work-tree=')) {
      cwds = cdInto({ ...args[k]!, text: t.slice('--work-tree='.length) }, cwds);
      k++;
    } else if (
      t === '-c' ||
      t === '--git-dir' ||
      t === '--namespace' ||
      t === '--super-prefix' ||
      t === '--config-env'
    )
      k += 2;
    else k++;
  }
  const sub = args[k]?.text;
  const rest = args.slice(k + 1);
  const cc: Ctx = { ...c, cwds };
  switch (sub) {
    case 'checkout': {
      // `git checkout [<tree-ish>] [--] <paths>`: the first operand is a path only if it exists on disk.
      const p = parseArgs(rest, ['-b', '-B', '--orphan', '--conflict', '--pathspec-from-file']);
      const before = p.pos.filter((w) => !p.afterDashDash.includes(w));
      const paths = [
        ...(before[0] && statAt(before[0], cwds) ? before : before.slice(1)),
        ...p.afterDashDash,
      ];
      return hitAll(paths, cc, true);
    }
    case 'restore':
      return hitAll(parseArgs(rest, ['-s', '--source', '--pathspec-from-file']).pos, cc, true);
    case 'rm':
    case 'mv':
      return hitAll(nonFlagWords(rest), cc, true);
    case 'clean': {
      const p = parseArgs(rest, ['-e', '--exclude']);
      return hitAll(p.pos.length ? p.pos : [word('.')], cc, true);
    }
    case 'apply':
    case 'am': {
      const p = parseArgs(rest, [
        '-p',
        '-C',
        '--directory',
        '--exclude',
        '--include',
        '--whitespace',
        '--build-fake-ancestor',
        '-S',
      ]);
      const roots = cwds.map((d) => cc.m.repoOf(d)).filter((r): r is string => r !== null);
      return patchCheck(cc, p.pos, roots);
    }
    default:
      return null;
  }
}

function findCmd(args: Word[], c: Ctx): ShellFinding | null {
  let k = 0;
  const paths: Word[] = [];
  while (k < args.length && !/^[-(!]/.test(args[k]!.text)) paths.push(args[k++]!);
  if (!paths.length) paths.push(word('.'));
  const expr = args.slice(k);
  let writes = false;
  for (let j = 0; j < expr.length; j++) {
    const t = expr[j]!.text;
    if (t === '-delete') writes = true;
    else if (['-exec', '-execdir', '-ok', '-okdir'].includes(t)) {
      const end = expr.findIndex((w, q) => q > j && (w.text === ';' || w.text === '+'));
      if (writeish(expr.slice(j + 1, end === -1 ? undefined : end))) writes = true;
    } else if (['-fprint', '-fprint0', '-fprintf', '-fls'].includes(t) && expr[j + 1]) {
      const f = hitAll([expr[j + 1]!], c, false);
      if (f) return f;
    }
  }
  return writes ? hitAll(paths, c, true) : null;
}

function analyzeScript(src: string, cwds: string[], m: BoundaryMatcher, depth: number): ShellFinding | null {
  if (depth > MAX_DEPTH) return null;
  if (src.length > MAX_COMMAND)
    return cwds.some((d) => m.repoOf(d)) ? { kind: 'too_large', hit: null } : null;
  const subs: string[] = [];
  const pipelines = parse(lex(src, subs));
  let cur = cwds;
  // Values the analysis cannot follow — loop lists (`for f in …`, `while read f … < <(find …)`), substitutions and
  // variable assignments (`P=packages/kernel; echo x > $P/a`): a protected path there is tied to any write in the
  // script whose target starts with a variable.
  let listHit: ProtectedHit | null = null;
  let dynamicWrite = false;
  for (const pipe of pipelines) {
    for (const cmd of pipe) {
      const f = analyzeCmd({ m, cwds: cur, cmd, pipe, depth });
      if (f) return f;
      const { name, args } = commandOf(cmd.words, cur);
      if (name === 'cd' || name === 'pushd')
        cur = cdInto(
          args.find((w) => !/^-[LPe@]$/.test(w.text)),
          cur,
        );
      if (name === 'for') {
        const inAt = args.findIndex((w) => w.text === 'in');
        for (const w of inAt === -1 ? [] : args.slice(inAt + 1)) listHit ??= hitWord(w, cur, m, true);
      }
      for (const w of cmd.words) {
        const value = /^[A-Za-z_][A-Za-z0-9_]*\+?=(.+)$/s.exec(w.text)?.[1];
        if (value && !value.startsWith('*')) listHit ??= hitWord({ ...w, text: value }, cur, m, true);
      }
      if (name && writeish([word(name), ...args]) && args.some((w) => w.leadingDynamic)) dynamicWrite = true;
      if (cmd.redirects.some((r) => WRITE_REDIRECTS.has(r.op) && r.target?.leadingDynamic))
        dynamicWrite = true;
    }
  }
  for (const s of subs) {
    const f = analyzeScript(s, cur, m, depth + 1);
    if (f) return f;
    if (!listHit)
      for (const w of lex(s, []).flatMap((t) => (t.t === 'w' ? [t.w] : [])))
        listHit ??= hitWord(w, cur, m, true);
  }
  if (listHit && dynamicWrite) return { kind: 'command', hit: listHit };
  return null;
}

/** Analyse a Bash tool command run from `cwd`; returns the first protected write found. */
export function analyzeBash(command: string, cwd: string, m: BoundaryMatcher): ShellFinding | null {
  return analyzeScript(command, [physicalPath(cwd, '/')], m, 0);
}
