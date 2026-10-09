import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { globToRegExp, mtimeOf, walkFiles } from './glob';
import type { McpContentBlock } from './mcp';
import { isWithin, realpathLoose } from './paths';
import { killGroup } from './process';

/** What a tool call produced: the tool_result content the model sees plus the structured `toolUseResult`. */
export interface ToolOutcome {
  content: string | McpContentBlock[];
  isError: boolean;
  toolUseResult: unknown;
  /** What PostToolUse hooks get as `tool_response` when it is not `toolUseResult` (MCP results with structuredContent). */
  hookResponse?: unknown;
  /** Value stored under the step's `saveAs`. */
  saveValue?: unknown;
  /** Line counts of a file change (the cost-state ledger tracks them). */
  linesAdded?: number;
  linesRemoved?: number;
}

export interface ToolContext {
  cwd: string;
  env: Readonly<Record<string, string>>;
  /** CLAUDE_SIM_EXEC=1: bash steps marked `exec: true` really run. */
  execAllowed: boolean;
  /** Aborting the run (SIGINT, SIGTERM) kills a command that is still running, as the real CLI does. */
  signal?: AbortSignal;
}

export interface BashScript {
  stdout: string;
  stderr?: string;
  exitCode?: number;
  exec?: boolean;
}

export function toolError(message: string): ToolOutcome {
  return {
    content: `<tool_use_error>${message}</tool_use_error>`,
    isError: true,
    toolUseResult: `Error: ${message}`,
  };
}

/** Input keys holding a path, per built-in tool; relative values are made absolute like the model would send. */
const PATH_KEYS: Readonly<Record<string, readonly string[]>> = {
  Read: ['file_path'],
  Write: ['file_path'],
  Edit: ['file_path'],
  NotebookEdit: ['notebook_path'],
  Glob: ['path'],
  Grep: ['path'],
};

export function absolutizePaths(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): Record<string, unknown> {
  const keys = PATH_KEYS[name];
  if (!keys) return input;
  const out = { ...input };
  for (const key of keys) {
    const value = out[key];
    if (typeof value === 'string' && value !== '' && !path.isAbsolute(value))
      out[key] = path.resolve(cwd, value);
  }
  return out;
}

function pathArg(input: Record<string, unknown>, key: string, cwd: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value !== '' ? path.resolve(cwd, value) : undefined;
}

function missingParam(tool: string, key: string): ToolOutcome {
  return toolError(
    `InputValidationError: ${tool} failed due to the following issue:\nThe required parameter \`${key}\` is missing`,
  );
}

function outsideCwd(cwd: string, file: string): boolean {
  return !isWithin(realpathLoose(cwd), realpathLoose(file));
}

function refuseOutside(file: string): ToolOutcome {
  return toolError(`claude-sim refuses to modify files outside the working directory: ${file}`);
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

function numbered(lines: string[], firstLine: number): string {
  return lines.map((line, i) => `${String(firstLine + i).padStart(6)}\t${line}`).join('\n');
}

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** One hunk (3 lines of context) covering everything between the common prefix and suffix. */
export function structuredPatch(before: string, after: string): PatchHunk[] {
  if (before === after) return [];
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const start = Math.max(0, prefix - 3);
  const contextAfter = Math.min(3, suffix);
  const lines = [
    ...a.slice(start, prefix).map((line) => ` ${line}`),
    ...a.slice(prefix, a.length - suffix).map((line) => `-${line}`),
    ...b.slice(prefix, b.length - suffix).map((line) => `+${line}`),
    ...a.slice(a.length - suffix, a.length - suffix + contextAfter).map((line) => ` ${line}`),
  ];
  return [
    {
      oldStart: start + 1,
      oldLines: a.length - suffix - start + contextAfter,
      newStart: start + 1,
      newLines: b.length - suffix - start + contextAfter,
      lines,
    },
  ];
}

function lineDelta(before: string, after: string): { linesAdded: number; linesRemoved: number } {
  const lines = structuredPatch(before, after).flatMap((hunk) => hunk.lines);
  return {
    linesAdded: lines.filter((line) => line.startsWith('+')).length,
    linesRemoved: lines.filter((line) => line.startsWith('-')).length,
  };
}

function editSnippet(after: string, patch: PatchHunk[]): string {
  const lines = splitLines(after);
  const first = Math.max(1, (patch[0]?.newStart ?? 1) - 1);
  const shown = lines.slice(first - 1, first - 1 + Math.max(8, patch[0]?.newLines ?? 0));
  return numbered(shown, first);
}

function readTool(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const file = pathArg(input, 'file_path', ctx.cwd);
  if (!file) return missingParam('Read', 'file_path');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return toolError(`File does not exist. Note: your current working directory is ${ctx.cwd}.`);
  }
  if (stat.isDirectory()) return toolError(`EISDIR: illegal operation on a directory, read '${file}'`);
  const text = fs.readFileSync(file, 'utf8');
  const all = splitLines(text);
  const offset = Math.max(1, Math.floor(Number(input.offset)) || 1);
  const limit = Math.max(1, Math.floor(Number(input.limit)) || 2000);
  const selected = all.slice(offset - 1, offset - 1 + limit);
  const toolUseResult = {
    type: 'text',
    file: {
      filePath: file,
      content: selected.join('\n'),
      numLines: selected.length,
      startLine: offset,
      totalLines: all.length,
    },
  };
  if (text.length === 0) {
    return {
      content: '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>',
      isError: false,
      toolUseResult,
    };
  }
  const shown = selected.map((line) => (line.length > 2000 ? line.slice(0, 2000) : line));
  return { content: numbered(shown, offset), isError: false, toolUseResult };
}

function writeTool(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const file = pathArg(input, 'file_path', ctx.cwd);
  if (!file) return missingParam('Write', 'file_path');
  if (typeof input.content !== 'string') return missingParam('Write', 'content');
  if (outsideCwd(ctx.cwd, file)) return refuseOutside(file);
  const content = input.content;
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  const patch = original === null ? [] : structuredPatch(original, content);
  return {
    content:
      original === null
        ? `File created successfully at: ${file}`
        : `The file ${file} has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file:\n${editSnippet(content, patch)}`,
    isError: false,
    toolUseResult: {
      type: original === null ? 'create' : 'update',
      filePath: file,
      content,
      structuredPatch: patch,
      originalFile: original,
    },
    ...lineDelta(original ?? '', content),
  };
}

/** Apply one edit to `text`, or explain why it cannot be applied (Claude Code's wording). */
function applyEdit(
  text: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): { text: string } | { error: string } {
  if (oldString === newString)
    return { error: 'No changes to make: old_string and new_string are exactly the same.' };
  const count = text.split(oldString).length - 1;
  if (count === 0) return { error: `String to replace not found in file.\nString: ${oldString}` };
  if (count > 1 && !replaceAll) {
    return {
      error:
        `Found ${count} matches of the string to replace, but replace_all is false. To replace all occurrences, ` +
        `set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\n` +
        `String: ${oldString}`,
    };
  }
  return {
    text: replaceAll ? text.split(oldString).join(newString) : text.replace(oldString, () => newString),
  };
}

function editTool(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const file = pathArg(input, 'file_path', ctx.cwd);
  if (!file) return missingParam('Edit', 'file_path');
  if (typeof input.old_string !== 'string') return missingParam('Edit', 'old_string');
  if (typeof input.new_string !== 'string') return missingParam('Edit', 'new_string');
  if (outsideCwd(ctx.cwd, file)) return refuseOutside(file);
  const oldString = input.old_string;
  const newString = input.new_string;
  const replaceAll = input.replace_all === true;
  const exists = fs.existsSync(file);
  if (!exists && oldString !== '')
    return toolError(`File does not exist. Note: your current working directory is ${ctx.cwd}.`);
  if (exists && oldString === '') return toolError('Cannot create new file - file already exists.');
  const original = exists ? fs.readFileSync(file, 'utf8') : '';
  // An empty old_string on a missing file creates it, as in Claude Code.
  const applied = exists ? applyEdit(original, oldString, newString, replaceAll) : { text: newString };
  if ('error' in applied) return toolError(applied.error);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, applied.text);
  const patch = structuredPatch(original, applied.text);
  return {
    content: exists
      ? `The file ${file} has been updated. Here's the result of running \`cat -n\` on a snippet of the edited file:\n${editSnippet(applied.text, patch)}`
      : `File created successfully at: ${file}`,
    isError: false,
    toolUseResult: {
      filePath: file,
      oldString,
      newString,
      originalFile: original,
      structuredPatch: patch,
      userModified: false,
      replaceAll,
    },
    ...lineDelta(original, applied.text),
  };
}

function existingPathArg(input: Record<string, unknown>, ctx: ToolContext): string | ToolOutcome {
  const target = pathArg(input, 'path', ctx.cwd) ?? ctx.cwd;
  return fs.existsSync(target) ? target : toolError(`Path does not exist: ${target}`);
}

function globTool(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  if (typeof input.pattern !== 'string' || input.pattern === '') return missingParam('Glob', 'pattern');
  const base = existingPathArg(input, ctx);
  if (typeof base !== 'string') return base;
  const started = Date.now();
  const matcher = globToRegExp(input.pattern);
  const matches = walkFiles(base)
    .filter((rel) => matcher.test(rel))
    .map((rel) => path.join(base, rel))
    .sort((a, b) => mtimeOf(b) - mtimeOf(a) || a.localeCompare(b));
  const filenames = matches.slice(0, 100);
  const truncated = matches.length > filenames.length;
  return {
    content:
      filenames.length === 0
        ? 'No files found'
        : filenames.join('\n') +
          (truncated ? '\n(Results are truncated. Consider using a more specific path or pattern.)' : ''),
    isError: false,
    toolUseResult: { filenames, durationMs: Date.now() - started, numFiles: filenames.length, truncated },
  };
}

function grepTool(input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  if (typeof input.pattern !== 'string' || input.pattern === '') return missingParam('Grep', 'pattern');
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, input['-i'] === true ? 'i' : '');
  } catch (error) {
    return toolError(`Invalid regular expression: ${(error as Error).message}`);
  }
  const base = existingPathArg(input, ctx);
  if (typeof base !== 'string') return base;
  const glob = typeof input.glob === 'string' && input.glob !== '' ? input.glob : undefined;
  const globMatcher = glob ? globToRegExp(glob.includes('/') ? glob : `**/${glob}`) : undefined;
  const files = fs.statSync(base).isFile()
    ? [base]
    : walkFiles(base)
        .filter((rel) => !globMatcher || globMatcher.test(rel))
        .map((rel) => path.join(base, rel));
  const mode =
    input.output_mode === 'content' || input.output_mode === 'count'
      ? input.output_mode
      : 'files_with_matches';
  const showLineNumbers = input['-n'] !== false;
  const headLimit = Number(input.head_limit) > 0 ? Math.floor(Number(input.head_limit)) : Infinity;
  const hits: { file: string; lines: { number: number; text: string }[] }[] = [];
  for (const file of files) {
    let text: string;
    try {
      const buffer = fs.readFileSync(file);
      if (buffer.length > 2_000_000 || buffer.subarray(0, 8000).includes(0)) continue;
      text = buffer.toString('utf8');
    } catch {
      continue;
    }
    const lines = splitLines(text)
      .map((line, i) => ({ number: i + 1, text: line }))
      .filter((line) => regex.test(line.text));
    if (lines.length > 0) hits.push({ file, lines });
  }
  const filenames = hits.map((hit) => hit.file);
  if (mode === 'files_with_matches') {
    const sorted = [...filenames]
      .sort((a, b) => mtimeOf(b) - mtimeOf(a) || a.localeCompare(b))
      .slice(0, headLimit);
    return {
      content:
        sorted.length === 0
          ? 'No files found'
          : `Found ${sorted.length} file${sorted.length === 1 ? '' : 's'}\n${sorted.join('\n')}`,
      isError: false,
      toolUseResult: { mode, filenames: sorted, numFiles: sorted.length },
    };
  }
  if (mode === 'count') {
    const rows = hits.map((hit) => `${hit.file}:${hit.lines.length}`).slice(0, headLimit);
    const numMatches = hits.reduce((sum, hit) => sum + hit.lines.length, 0);
    return {
      content: rows.length === 0 ? 'No matches found' : rows.join('\n'),
      isError: false,
      toolUseResult: { mode, filenames, numFiles: filenames.length, content: rows.join('\n'), numMatches },
    };
  }
  const rows = hits
    .flatMap((hit) =>
      hit.lines.map((line) =>
        showLineNumbers ? `${hit.file}:${line.number}:${line.text}` : `${hit.file}:${line.text}`,
      ),
    )
    .slice(0, headLimit);
  return {
    content: rows.length === 0 ? 'No matches found' : rows.join('\n'),
    isError: false,
    toolUseResult: {
      mode,
      filenames,
      numFiles: filenames.length,
      content: rows.join('\n'),
      numLines: rows.length,
    },
  };
}

const IMPLEMENTATIONS: Readonly<
  Record<string, (input: Record<string, unknown>, ctx: ToolContext) => ToolOutcome>
> = {
  Read: readTool,
  Write: writeTool,
  Edit: editTool,
  Glob: globTool,
  Grep: grepTool,
};

/** Run a simulated built-in tool (Bash goes through runBash). */
export function runBuiltinTool(name: string, input: Record<string, unknown>, ctx: ToolContext): ToolOutcome {
  const implementation = IMPLEMENTATIONS[name];
  if (!implementation) {
    return toolError(
      `claude-sim does not simulate ${name}; give the scenario step a "result" to script its output`,
    );
  }
  try {
    return implementation(input, ctx);
  } catch (error) {
    return toolError((error as Error).message);
  }
}

/** A scripted (not executed) tool result from a step's `result`. */
export function scriptedResult(result: string, isError: boolean): ToolOutcome {
  return {
    content: result,
    isError,
    toolUseResult: isError ? `Error: ${result}` : result,
    saveValue: result,
  };
}

interface ShellRun {
  stdout: string;
  stderr: string;
  exitCode: number;
  interrupted: boolean;
}

function execShell(command: string, ctx: ToolContext, timeoutMs: number, shell = 'bash'): Promise<ShellRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-c', command], {
      cwd: ctx.cwd,
      env: { ...ctx.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let interrupted = false;
    const stop = () => {
      interrupted = true;
      killGroup(child, 'SIGTERM');
    };
    const timer = setTimeout(stop, timeoutMs);
    if (ctx.signal?.aborted) stop();
    else ctx.signal?.addEventListener('abort', stop, { once: true });
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === 'ENOENT' && shell === 'bash')
        execShell(command, ctx, timeoutMs, '/bin/sh').then(resolve, reject);
      else reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', stop);
      resolve({ stdout, stderr, exitCode: code ?? (interrupted ? 143 : 1), interrupted });
    });
  });
}

/**
 * The Bash tool. Scripted by default; executed for real only when CLAUDE_SIM_EXEC=1 *and* the step says
 * `exec: true`, so a scenario can never run arbitrary commands by accident.
 */
export async function runBash(
  input: Record<string, unknown>,
  script: BashScript,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const command = typeof input.command === 'string' ? input.command : '';
  if (!command) return missingParam('Bash', 'command');
  let run: ShellRun;
  if (script.exec === true && ctx.execAllowed) {
    const requested = Number(input.timeout);
    const timeoutMs = Math.min(600_000, requested > 0 ? requested : 120_000);
    try {
      run = await execShell(command, ctx, timeoutMs);
    } catch (error) {
      return toolError((error as Error).message);
    }
  } else {
    run = {
      stdout: script.stdout,
      stderr: script.stderr ?? '',
      exitCode: script.exitCode ?? 0,
      interrupted: false,
    };
  }
  const saveValue = { stdout: run.stdout.trim(), stderr: run.stderr.trim(), exitCode: run.exitCode };
  const output = [run.stdout.replace(/\n+$/, ''), run.stderr.replace(/\n+$/, '')].filter(Boolean).join('\n');
  if (run.exitCode !== 0) {
    const message = `Exit code ${run.exitCode}${output ? `\n${output}` : ''}`;
    return { content: message, isError: true, toolUseResult: `Error: ${message}`, saveValue };
  }
  return {
    content: output || '(Bash completed with no output)',
    isError: false,
    toolUseResult: {
      stdout: run.stdout,
      stderr: run.stderr,
      interrupted: run.interrupted,
      isImage: false,
      noOutputExpected: false,
    },
    saveValue,
  };
}
