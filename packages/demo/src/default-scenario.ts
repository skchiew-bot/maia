/**
 * The demo's default claude-sim scenario (CLAUDE_SIM_SCENARIO): what a managed session runs when its prompt has no
 * `[[scenario:…]]` marker. Such prompts come from the platform itself (intake triage and build sessions, rollover
 * successors), and the text a requester wrote is part of them, so the scenario is chosen from what the platform wrote
 * around it, never from a marker a requester could see: it dispatches on the prompt (`diagnosing customer ticket
 * <id> `, `fix plan for ticket <id>.`). It is generated per demo directory because a build must commit to its
 * ticket's UAT branch, `uat/<ticketId>`, which mod-intake and mod-change resolve, and because the scripted tickets
 * are the ones the seeder filed.
 */
import { builtInScenario, parseScenario, type ScenarioInput } from '@aoc/claude-sim';
import { DIAGNOSES } from './seed/content';

type Step = Record<string, unknown>;
const think = (ms: number, extra: Step = {}): Step => ({ kind: 'think', ms, outputTokens: Math.max(60, Math.round(ms / 6)), ...extra });
const text = (t: string, extra: Step = {}): Step => ({ kind: 'text', text: t, ...extra });
const tool = (name: string, input: Step, extra: Step = {}): Step => ({ kind: 'tool', name, input, ...extra });
const read = (file: string, extra: Step = {}) => tool('Read', { file_path: file }, extra);
const write = (file: string, content: string) => tool('Write', { file_path: file, content });
const mcp = (name: string, args: Step): Step => ({ kind: 'mcp', server: 'aoc', tool: name, args });
const done = (taskId: string, kind: string, ref: string, detail?: string) => mcp('task_done', { task_id: taskId, evidence: { kind, ref, ...(detail ? { detail } : {}) } });
const plan = (summary: string, tasks: [string, string, string][]) =>
  mcp('declare_plan', { summary, phases: [{ id: 'work', name: 'Work', tasks: tasks.map(([id, title, size]) => ({ id, title, size })) }] });
/** Runs for real (CLAUDE_SIM_EXEC=1); without it the scripted stdout stands in and the evidence stays unverified. */
const git = (command: string, extra: Step = {}): Step => ({ kind: 'bash', command, exec: true, ...extra });
const end: Step = { kind: 'endTurn', final: true };

/** The seeded tickets whose triage or build runs live on claude-sim. */
export interface ScriptedTickets {
  /** Fix plan awaiting the Approver: approving it starts the build below. */
  receipts: string;
  /** Filed minutes before the seed ended: its triage starts when aocd boots. */
  transferBlank: string;
}

export function defaultScenario(t: ScriptedTickets): ScenarioInput {
  const successor = builtInScenario('demo-rollover-successor')!.steps.map((s, i) => (i === 0 ? { ...s, label: 'rollover-successor' } : s));
  const receiptsDiagnosis = DIAGNOSES.receipts![0]!;
  const transferDiagnosis = DIAGNOSES['transfer-blank']![0]!;
  const steps: Step[] = [
    { kind: 'branch', onResumeTextIncludes: ['Context rollover:'], goto: 'rollover-successor' },
    { kind: 'branch', onResumeTextIncludes: [`diagnosing customer ticket ${t.receipts} `], goto: 'triage-receipts' },
    { kind: 'branch', onResumeTextIncludes: [`diagnosing customer ticket ${t.transferBlank} `], goto: 'triage-transfer' },
    { kind: 'branch', onResumeTextIncludes: [`fix plan for ticket ${t.receipts}.`], goto: 'build-receipts' },
    { kind: 'branch', onResumeTextIncludes: ['diagnosing customer ticket'], goto: 'triage-unknown' },

    // Anything else (e.g. a session launched from the console without a marker): a small, complete task.
    think(4000),
    text('Working on the request.'),
    plan('A small change for an ad-hoc request.', [['adhoc-1', 'Write up the requested change', 's']]),
    tool('Glob', { pattern: '**/*.md' }),
    read('README.md'),
    write('docs/notes/session-{{sim.sessionId}}.md', '# Notes\n\nWritten by session {{sim.sessionId}}.\n'),
    done('adhoc-1', 'diff', 'docs/notes/session-{{sim.sessionId}}.md'),
    text('Done: the change is written up.'),
    end,

    ...successor,

    // Intake triage of the seeded "receipt photos come out sideways" ticket (read-only).
    think(5000, { label: 'triage-receipts' }),
    text('Triaging the ticket read-only.'),
    plan('Diagnose rotated receipt photos (read-only).', [['tr-receipts-1', 'Trace how receipt uploads are normalised', 's'], ['tr-receipts-2', 'Confirm the root cause against the upload tests', 's']]),
    tool('Glob', { pattern: 'src/uploads/**/*.ts' }),
    read('src/uploads/normalize.ts'),
    think(9000, { thinking: 'normalizeImage re-encodes to JPEG and strips metadata, but never applies the EXIF orientation first.' }),
    tool('Grep', { pattern: 'orientation|exif|rotate', path: 'src', '-i': true }),
    read('test/uploads/normalize.test.ts'),
    done('tr-receipts-1', 'test', 'test/uploads/normalize.test.ts > strips metadata from uploads'),
    mcp('report_diagnosis', {
      root_cause: receiptsDiagnosis.rootCause,
      confidence: receiptsDiagnosis.confidence,
      fix_plan: receiptsDiagnosis.fixPlan,
      affected_areas: receiptsDiagnosis.affectedAreas,
      root_cause_class: receiptsDiagnosis.rootCauseClass,
    }),
    done('tr-receipts-2', 'test', 'test/uploads/normalize.test.ts > strips metadata from uploads', 'The existing test never uploads a rotated photo'),
    text(`Diagnosis reported (confidence ${receiptsDiagnosis.confidence}). No file was changed.`),
    end,

    // Intake build of the approved fix plan: fix, test, commit to uat/<ticket> with the AOC trailers. Git is the scoped
    // set the process type grants (config/process-types.json): branch, add, commit, rev-parse, back; never main, never push.
    think(5000, { label: 'build-receipts' }),
    text(`Implementing the approved fix plan for ${t.receipts} on branch uat/${t.receipts}.`),
    plan(`Fix rotated receipt photos (ticket ${t.receipts}).`, [
      ['bd-receipts-1', 'Apply the EXIF orientation before stripping metadata', 'm'],
      ['bd-receipts-2', 'Regression test with a rotated receipt', 's'],
      ['bd-receipts-3', `Commit the fix to uat/${t.receipts} for UAT`, 'xs'],
    ]),
    git(`git switch -c uat/${t.receipts} || git switch uat/${t.receipts}`, { description: 'Branch for UAT' }),
    read('src/uploads/normalize.ts'),
    think(6000),
    write(
      'src/uploads/normalize.ts',
      "import sharp from 'sharp';\n\n// build {{sim.sessionId}}\n// Apply the EXIF orientation, then re-encode as JPEG and drop the metadata (GPS, device) before storage.\nexport async function normalizeImage(input: Buffer): Promise<Buffer> {\n  return sharp(input).rotate().jpeg({ quality: 82 }).toBuffer();\n}\n",
    ),
    done('bd-receipts-1', 'diff', 'src/uploads/normalize.ts', 'sharp().rotate() applies the EXIF orientation before the metadata is stripped'),
    read('test/uploads/normalize.test.ts'),
    write(
      'test/uploads/normalize.test.ts',
      "import { expect, it } from 'vitest';\nimport { normalizeImage } from '../../src/uploads/normalize';\n\nit('strips metadata from uploads', async () => {\n  const out = await normalizeImage(Buffer.from([]));\n  expect(out).toBeInstanceOf(Buffer);\n});\n\nit('keeps portrait receipts upright', async () => {\n  // fixture: a portrait receipt with EXIF orientation 6 (build {{sim.sessionId}})\n  expect(normalizeImage).toBeTypeOf('function');\n});\n",
    ),
    done('bd-receipts-2', 'test', 'test/uploads/normalize.test.ts > keeps portrait receipts upright'),
    git('git add src/uploads/normalize.ts test/uploads/normalize.test.ts', { description: 'Stage the fix' }),
    git(`git commit -m "Apply the EXIF orientation before stripping upload metadata" -m "AOC-Ticket: ${t.receipts}" -m "AOC-Session: $AOC_SESSION_ID"`, { description: 'Commit with the AOC trailers' }),
    git('git rev-parse --short HEAD', { description: 'The UAT commit', stdout: '0000000', saveAs: 'uat' }),
    git('git switch -', { description: 'Leave the shared working copy where it was' }),
    done('bd-receipts-3', 'commit', '{{uat.stdout}}', `uat/${t.receipts}`),
    text(`The fix is committed on uat/${t.receipts}, ready for the requester to test.`),
    end,

    // Intake triage of the ticket filed minutes before the seed ended: a careful, slow read-only diagnosis (minutes of
    // thinking between a few reads), so "in triage" is on the funnel for a while after aocd starts.
    think(20_000, { label: 'triage-transfer' }),
    text('Triaging the ticket read-only.'),
    plan('Diagnose the blank customer panel after two transfers (read-only).', [['tr-transfer-1', 'Trace the panel state through a double transfer', 's'], ['tr-transfer-2', 'Confirm the root cause against the desktop tests', 's']]),
    tool('Glob', { pattern: 'src/desktop/**/*.ts' }),
    read('src/desktop/panel.ts'),
    think(150_000, { thinking: 'renderPanel keeps one entry per call leg. After the second transfer the first leg is disposed, so the lookup finds nothing to render.' }),
    tool('Grep', { pattern: 'transfer|dispose|leg', path: 'src', '-i': true }),
    read('src/desktop/intent.ts'),
    think(120_000, { thinking: 'Nothing re-creates the panel state when a leg comes back. The suggestion service is not involved: the panel is empty before it runs.' }),
    read('test/desktop/whisper.test.ts'),
    done('tr-transfer-1', 'test', 'test/desktop/whisper.test.ts > rankSuggestions ranks suggestions by intent confidence'),
    think(60_000),
    mcp('report_diagnosis', {
      root_cause: transferDiagnosis.rootCause,
      confidence: transferDiagnosis.confidence,
      fix_plan: transferDiagnosis.fixPlan,
      affected_areas: transferDiagnosis.affectedAreas,
      root_cause_class: transferDiagnosis.rootCauseClass,
    }),
    done('tr-transfer-2', 'test', 'test/desktop/whisper.test.ts > rankSuggestions ranks suggestions by intent confidence', 'No test transfers a call twice'),
    text(`Diagnosis reported (confidence ${transferDiagnosis.confidence}). No file was changed.`),
    end,

    // Intake triage of any other ticket: nothing recognisable, so a low-confidence diagnosis goes to a human (§7).
    think(5000, { label: 'triage-unknown' }),
    text('Triaging the ticket read-only.'),
    plan('Diagnose the reported behaviour (read-only).', [['tr-unknown-1', 'Look for the reported behaviour', 's']]),
    tool('Glob', { pattern: 'src/**/*.ts' }),
    tool('Grep', { pattern: 'error|retry|timeout', path: 'src', '-i': true }),
    done('tr-unknown-1', 'test', 'manual reproduction > reported behaviour'),
    mcp('report_diagnosis', {
      root_cause: 'The report could not be matched to a code path in a read-only inspection; the behaviour may depend on data or configuration that is not visible here.',
      confidence: 0.4,
      fix_plan: 'Ask the requester for exact steps and a timestamp, reproduce on UAT with request logging, then triage again.',
      root_cause_class: 'unknown',
    }),
    text('Diagnosis reported with low confidence (0.40); a human needs to decide.'),
    end,
  ];
  const scenario: ScenarioInput = {
    name: 'demo-default',
    description: 'Default scenario of a demo directory: intake triage and builds of the seeded tickets, rollover successors, small ad-hoc tasks.',
    steps: steps as ScenarioInput['steps'],
  };
  parseScenario(scenario, 'the demo default scenario');
  return scenario;
}
