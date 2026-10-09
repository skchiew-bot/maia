#!/usr/bin/env node
/*
 * Probe for gap G-48 (docs/compliance/gaps.md, ADR-0006): what does `claude -p --resume <id> "<prompt>"` do with a
 * tool call that a PreToolUse hook deferred? Only a resume WITHOUT a prompt is observed (research §7.4: it re-runs
 * the same call). AOC resumes with the decision answers as the prompt, so G-48's size depends on this answer.
 *
 * Needs a logged-in `claude` on PATH. Spends two short -p turns (default model unless PROBE_MODEL is set). Run from
 * anywhere: node docs/research/probes/defer-resume-with-prompt.mjs [outDir]
 *
 * The hook defers the first call it sees for a tool_use_id and denies any later call for the same id, so a re-run
 * is visible in hook-log.jsonl without the command ever executing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), 'aoc-defer-probe-')));
const work = join(out, 'work');
mkdirSync(work, { recursive: true });
const hookLog = join(out, 'hook-log.jsonl');
const marker = join(work, 'executed.txt');

const hook = join(out, 'hook.mjs');
writeFileSync(
  hook,
  `import { appendFileSync, readFileSync } from 'node:fs';
const input = JSON.parse(readFileSync(0, 'utf8'));
const log = ${JSON.stringify(hookLog)};
const seen = (() => { try { return readFileSync(log, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
const again = seen.some((e) => e.tool_use_id === input.tool_use_id);
const decision = again ? 'deny' : 'defer';
appendFileSync(log, JSON.stringify({ event: input.hook_event_name, tool_use_id: input.tool_use_id, tool_name: input.tool_name, tool_input: input.tool_input, decision }) + '\\n');
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision,
  permissionDecisionReason: again ? 'PROBE: the re-run of the deferred call was denied by the hook.' : 'PROBE: deferred for a human.' } }));
`,
);
const settings = join(out, 'settings.json');
writeFileSync(
  settings,
  JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${JSON.stringify(hook)}` }] }] },
  }),
);

/** The prompt goes right after -p: --allowedTools takes several values and would swallow a trailing prompt. */
function claude(prompt, extra, file) {
  const args = ['-p', prompt, ...extra, '--output-format', 'stream-json', '--verbose', '--settings', settings];
  args.push('--allowedTools', 'Bash');
  if (process.env.PROBE_MODEL) args.push('--model', process.env.PROBE_MODEL);
  const r = spawnSync('claude', args, { cwd: work, encoding: 'utf8', timeout: 300_000 });
  writeFileSync(join(out, file), r.stdout ?? '');
  if (r.stderr) writeFileSync(join(out, file.replace('.jsonl', '.stderr.txt')), r.stderr);
  const lines = (r.stdout ?? '').split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { unparsed: l };
    }
  });
  return { code: r.status, lines, result: lines.findLast((l) => l.type === 'result') ?? null };
}

const first = claude(`Use the Bash tool to run exactly this command and nothing else: echo probe > ${marker}`, [], 'turn1.jsonl');
const sessionId = first.result?.session_id ?? first.lines.find((l) => l.session_id)?.session_id;
if (!sessionId) {
  console.error(`No session id in turn 1 (exit ${first.code}); see ${out}`);
  process.exit(1);
}
const deferred = first.result?.deferred_tool_use ?? null;

const second = claude(
  'A human answered your pending request: APPROVED. Say "done" and stop.',
  ['--resume', sessionId],
  'turn2.jsonl',
);

const transcript = (() => {
  const root = join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
})();
const toolResults = transcript
  ? readFileSync(transcript, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .flatMap((l) => (Array.isArray(l.message?.content) ? l.message.content : []))
      .filter((c) => c.type === 'tool_result' && deferred && c.tool_use_id === deferred.id)
  : null;
const hookCalls = existsSync(hookLog)
  ? readFileSync(hookLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];

const summary = {
  claudeVersion: spawnSync('claude', ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? null,
  turn1: {
    exit: first.code,
    terminal_reason: first.result?.terminal_reason ?? null,
    stop_reason: first.result?.stop_reason ?? null,
    deferred_tool_use: deferred,
  },
  turn2: {
    exit: second.code,
    subtype: second.result?.subtype ?? null,
    is_error: second.result?.is_error ?? null,
    terminal_reason: second.result?.terminal_reason ?? null,
    result: second.result?.result ?? null,
  },
  // The answer G-48 needs: re-run (the hook saw the same tool_use_id again), dropped, or an error.
  deferredCallRerunOnResumeWithPrompt: deferred ? hookCalls.filter((c) => c.tool_use_id === deferred.id).length > 1 : null,
  commandExecuted: existsSync(marker),
  toolResultsForDeferredCall: toolResults,
  hookCalls,
  transcript,
  outDir: out,
};
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
