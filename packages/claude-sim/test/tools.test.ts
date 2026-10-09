import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { globToRegExp } from '../src/glob';
import { runBash, runBuiltinTool, structuredPatch, type ToolContext } from '../src/tools';
import { makeSandbox, readTranscript, runSim, SESSION_A, type Sandbox } from './helpers';

let box: Sandbox;
let ctx: ToolContext;
beforeEach(() => {
  box = makeSandbox();
  ctx = { cwd: box.cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, execAllowed: false };
});
afterEach(() => box.cleanup());

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(box.cwd, rel)), { recursive: true });
  fs.writeFileSync(path.join(box.cwd, rel), text);
};

describe('globToRegExp', () => {
  it('supports **, *, ?, braces and classes', () => {
    expect(globToRegExp('**/*.ts').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('**/*.ts').test('b.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/b.ts')).toBe(false);
    expect(globToRegExp('src/**').test('src/a/b.md')).toBe(true);
    expect(globToRegExp('**/*.{ts,js}').test('lib/x.js')).toBe(true);
    expect(globToRegExp('file?.[ch]').test('file1.c')).toBe(true);
    expect(globToRegExp('file?.[!ch]').test('file1.c')).toBe(false);
  });
});

describe('built-in tools', () => {
  it('Read numbers lines like cat -n and honours offset/limit', () => {
    write('a.txt', 'one\ntwo\nthree\n');
    const all = runBuiltinTool('Read', { file_path: path.join(box.cwd, 'a.txt') }, ctx);
    expect(all.content).toBe('     1\tone\n     2\ttwo\n     3\tthree');
    const slice = runBuiltinTool('Read', { file_path: 'a.txt', offset: 2, limit: 1 }, ctx);
    expect(slice).toMatchObject({
      content: '     2\ttwo',
      toolUseResult: { file: { numLines: 1, startLine: 2, totalLines: 3, content: 'two' } },
    });
    expect(runBuiltinTool('Read', { file_path: 'missing.txt' }, ctx)).toMatchObject({
      isError: true,
      content: `<tool_use_error>File does not exist. Note: your current working directory is ${box.cwd}.</tool_use_error>`,
    });
  });

  it('Write creates and updates files, Edit replaces exactly one match unless replace_all', () => {
    const created = runBuiltinTool('Write', { file_path: 'src/x.ts', content: 'a\nb\n' }, ctx);
    expect(created).toMatchObject({
      isError: false,
      linesAdded: 2,
      linesRemoved: 0,
      toolUseResult: { type: 'create', originalFile: null },
    });
    const updated = runBuiltinTool('Write', { file_path: 'src/x.ts', content: 'a\nc\n' }, ctx);
    expect(updated).toMatchObject({
      toolUseResult: { type: 'update', originalFile: 'a\nb\n' },
      linesAdded: 1,
      linesRemoved: 1,
    });
    expect(
      runBuiltinTool('Edit', { file_path: 'src/x.ts', old_string: 'zzz', new_string: 'y' }, ctx).content,
    ).toContain('String to replace not found');
    write('dup.txt', 'x x\n');
    expect(
      runBuiltinTool('Edit', { file_path: 'dup.txt', old_string: 'x', new_string: 'y' }, ctx).content,
    ).toContain('Found 2 matches');
    expect(
      runBuiltinTool(
        'Edit',
        { file_path: 'dup.txt', old_string: 'x', new_string: '$&y', replace_all: true },
        ctx,
      ).isError,
    ).toBe(false);
    expect(fs.readFileSync(path.join(box.cwd, 'dup.txt'), 'utf8')).toBe('$&y $&y\n');
    expect(
      runBuiltinTool('Edit', { file_path: 'new.txt', old_string: '', new_string: 'fresh' }, ctx).content,
    ).toBe(`File created successfully at: ${path.join(box.cwd, 'new.txt')}`);
    expect(
      runBuiltinTool('Edit', { file_path: 'new.txt', old_string: '', new_string: 'again' }, ctx).content,
    ).toContain('file already exists');
  });

  it('structuredPatch produces one hunk with context', () => {
    expect(structuredPatch('1\n2\n3\n4\n5\n6\n7\n8\n', '1\n2\n3\n4\nfive\n6\n7\n8\n')).toEqual([
      {
        oldStart: 2,
        oldLines: 7,
        newStart: 2,
        newLines: 7,
        lines: [' 2', ' 3', ' 4', '-5', '+five', ' 6', ' 7', ' 8'],
      },
    ]);
    expect(structuredPatch('same', 'same')).toEqual([]);
  });

  it('Glob and Grep search the real tree, skipping .git and node_modules', () => {
    write('src/a.ts', 'const token = Date.now();\n');
    write('src/b.js', 'export {};\n');
    write('node_modules/dep/index.ts', 'Date.now()\n');
    write('.git/config', 'Date.now()\n');
    const glob = runBuiltinTool('Glob', { pattern: '**/*.ts' }, ctx);
    expect(glob.toolUseResult).toMatchObject({
      filenames: [path.join(box.cwd, 'src/a.ts')],
      numFiles: 1,
      truncated: false,
    });
    expect(runBuiltinTool('Glob', { pattern: '*.md' }, ctx).content).toBe('No files found');
    const files = runBuiltinTool('Grep', { pattern: 'date\\.now', '-i': true }, ctx);
    expect(files.content).toBe(`Found 1 file\n${path.join(box.cwd, 'src/a.ts')}`);
    const content = runBuiltinTool('Grep', { pattern: 'Date', output_mode: 'content', glob: '*.ts' }, ctx);
    expect(content.content).toBe(`${path.join(box.cwd, 'src/a.ts')}:1:const token = Date.now();`);
    expect(runBuiltinTool('Grep', { pattern: '(' }, ctx).isError).toBe(true);
  });

  it('tools that do not exist in Claude Code 2.1 are not simulated', () => {
    expect(runBuiltinTool('MultiEdit', { file_path: 'x' }, ctx).content).toContain(
      'claude-sim does not simulate MultiEdit',
    );
  });
});

describe('Bash', () => {
  it('returns scripted output unless CLAUDE_SIM_EXEC allows a step marked exec', async () => {
    const scripted = await runBash({ command: 'echo real' }, { stdout: 'scripted\n', exec: true }, ctx);
    expect(scripted).toMatchObject({
      content: 'scripted',
      isError: false,
      saveValue: { stdout: 'scripted', stderr: '', exitCode: 0 },
    });
    const exec = { ...ctx, execAllowed: true };
    const real = await runBash(
      { command: 'echo real-$((1+1)); echo warn >&2' },
      { stdout: 'scripted', exec: true },
      exec,
    );
    expect(real).toMatchObject({
      content: 'real-2\nwarn',
      toolUseResult: { stdout: 'real-2\n', stderr: 'warn\n', interrupted: false },
    });
    const failed = await runBash({ command: 'echo oops; exit 3' }, { stdout: '', exec: true }, exec);
    expect(failed).toMatchObject({
      isError: true,
      content: 'Exit code 3\noops',
      toolUseResult: 'Error: Exit code 3\noops',
    });
    const silent = await runBash({ command: 'true' }, { stdout: '', exec: true }, exec);
    expect(silent.content).toBe('(Bash completed with no output)');
    const started = Date.now();
    const slow = await runBash(
      { command: 'sleep 20 & sleep 20', timeout: 200 },
      { stdout: '', exec: true },
      exec,
    );
    expect(slow).toMatchObject({ isError: true, content: 'Exit code 143' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(fs.existsSync(path.join(box.cwd, 'real'))).toBe(false);
  });

  it('executes for real in a session only with CLAUDE_SIM_EXEC=1 and exec:true', async () => {
    const file = box.file('exec.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        name: 'exec',
        steps: [
          { kind: 'bash', command: 'pwd > where.txt && echo made', stdout: 'scripted', exec: true },
          { kind: 'bash', command: 'touch never.txt', stdout: 'scripted' },
          { kind: 'endTurn' },
        ],
      }),
    );
    await runSim(box, ['-p', '--session-id', SESSION_A, '--dangerously-skip-permissions', 'x'], {
      env: { CLAUDE_SIM_SCENARIO: file, CLAUDE_SIM_EXEC: '1' },
    });
    expect(fs.readFileSync(path.join(box.cwd, 'where.txt'), 'utf8').trim()).toBe(box.cwd);
    expect(fs.existsSync(path.join(box.cwd, 'never.txt'))).toBe(false);
    const results = readTranscript(box, SESSION_A)
      .filter((line) => line.type === 'user' && Array.isArray(line.message.content))
      .map((line) => line.message.content[0].content);
    expect(results).toEqual(['made', 'scripted']);
  });
});
