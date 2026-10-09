/**
 * The demo's default claude-sim scenario (CLAUDE_SIM_SCENARIO): what a managed session runs when its prompt has no
 * `[[scenario:…]]` marker. Such prompts come from the platform itself (intake triage and build sessions, rollover
 * successors), so the scenario dispatches on their text. It is generated per demo directory because an intake
 * build must commit to its ticket's UAT branch, `uat/<ticketId>`, which mod-intake and mod-change resolve.
 */
import { builtInScenario, parseScenario, type ScenarioInput } from '@aoc/claude-sim';

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

export function defaultScenario(receiptsTicketId: string): ScenarioInput {
  const t = receiptsTicketId;
  const successor = builtInScenario('demo-rollover-successor')!.steps.map((s, i) => (i === 0 ? { ...s, label: 'rollover-successor' } : s));
  const steps: Step[] = [
    { kind: 'branch', onResumeTextIncludes: ['Context rollover:'], goto: 'rollover-successor' },
    { kind: 'branch', onResumeTextIncludes: [`diagnosing customer ticket ${t} `], goto: 'triage-receipts' },
    { kind: 'branch', onResumeTextIncludes: [`fix plan for ticket ${t}.`], goto: 'build-receipts' },
    { kind: 'branch', onResumeTextIncludes: ['diagnosing customer ticket'], goto: 'triage-unknown' },

    // Anything else (e.g. a session launched from the console without a marker): a small, complete task.
    think(4000),
    text('Working on the request.'),
    plan('A small change for an ad-hoc request.', [['t1', 'Write up the requested change', 's']]),
    tool('Glob', { pattern: '**/*.md' }),
    read('README.md'),
    write('docs/notes/session-{{sim.sessionId}}.md', '# Notes\n\nWritten by session {{sim.sessionId}}.\n'),
    done('t1', 'diff', 'docs/notes/session-{{sim.sessionId}}.md'),
    text('Done: the change is written up.'),
    end,

    ...successor,

    // Intake triage of the seeded "receipt photos come out sideways" ticket (read-only).
    think(5000, { label: 'triage-receipts' }),
    text('Triaging the ticket read-only.'),
    plan('Diagnose rotated receipt photos (read-only).', [['t1', 'Trace how receipt uploads are normalised', 's'], ['t2', 'Confirm the root cause against the upload tests', 's']]),
    tool('Glob', { pattern: 'src/uploads/**/*.ts' }),
    read('src/uploads/normalize.ts'),
    think(9000, { thinking: 'normalizeImage re-encodes to JPEG and strips metadata, but never applies the EXIF orientation first.' }),
    tool('Grep', { pattern: 'orientation|exif|rotate', path: 'src', '-i': true }),
    read('test/uploads/normalize.test.ts'),
    done('t1', 'test', 'test/uploads/normalize.test.ts > strips metadata from uploads'),
    mcp('report_diagnosis', {
      root_cause: 'normalizeImage() re-encodes uploads and strips all metadata without applying the EXIF orientation tag first, so portrait photos taken on phones are stored rotated 90 degrees.',
      confidence: 0.86,
      fix_plan: 'Apply the EXIF orientation (sharp().rotate()) before stripping metadata in src/uploads/normalize.ts, add a regression test with a rotated receipt, then verify on UAT with the reporter\'s receipt.',
      affected_areas: ['src/uploads/normalize.ts', 'test/uploads/normalize.test.ts'],
      root_cause_class: 'exif-orientation-dropped',
    }),
    done('t2', 'test', 'test/uploads/normalize.test.ts > strips metadata from uploads', 'The existing test never uploads a rotated photo'),
    text('Diagnosis reported (confidence 0.86). No file was changed.'),
    end,

    // Intake build of the approved fix plan: fix, test, commit to uat/<ticket> with the AOC trailers.
    think(5000, { label: 'build-receipts' }),
    text(`Implementing the approved fix plan for ${t} on branch uat/${t}.`),
    plan(`Fix rotated receipt photos (ticket ${t}).`, [
      ['t1', 'Apply the EXIF orientation before stripping metadata', 'm'],
      ['t2', 'Regression test with a rotated receipt', 's'],
      ['t3', `Commit the fix to uat/${t} for UAT`, 'xs'],
    ]),
    read('src/uploads/normalize.ts'),
    think(6000),
    write(
      'src/uploads/normalize.ts',
      "import sharp from 'sharp';\n\n// build {{sim.sessionId}}\n// Apply the EXIF orientation, then re-encode as JPEG and drop the metadata (GPS, device) before storage.\nexport async function normalizeImage(input: Buffer): Promise<Buffer> {\n  return sharp(input).rotate().jpeg({ quality: 82 }).toBuffer();\n}\n",
    ),
    done('t1', 'diff', 'src/uploads/normalize.ts', 'sharp().rotate() applies the EXIF orientation before the metadata is stripped'),
    read('test/uploads/normalize.test.ts'),
    write(
      'test/uploads/normalize.test.ts',
      "import { expect, it } from 'vitest';\nimport { normalizeImage } from '../../src/uploads/normalize';\n\nit('strips metadata from uploads', async () => {\n  const out = await normalizeImage(Buffer.from([]));\n  expect(out).toBeInstanceOf(Buffer);\n});\n\nit('keeps portrait receipts upright', async () => {\n  // fixture: a portrait receipt with EXIF orientation 6 (build {{sim.sessionId}})\n  expect(normalizeImage).toBeTypeOf('function');\n});\n",
    ),
    done('t2', 'test', 'test/uploads/normalize.test.ts > keeps portrait receipts upright'),
    git(`git checkout -B uat/${t}`, { description: 'Branch for UAT' }),
    git('git add src/uploads/normalize.ts test/uploads/normalize.test.ts', { description: 'Stage the fix' }),
    git(`git commit -m "Apply the EXIF orientation before stripping upload metadata" -m "AOC-Ticket: ${t}" -m "AOC-Session: $AOC_SESSION_ID"`, { description: 'Commit with the AOC trailers' }),
    git('git rev-parse --short HEAD', { description: 'The UAT commit', stdout: '0000000', saveAs: 'uat' }),
    git('git checkout main', { description: 'Leave the shared working copy on main' }),
    done('t3', 'commit', '{{uat.stdout}}', `uat/${t}`),
    text(`The fix is committed on uat/${t}, ready for the requester to test.`),
    end,

    // Intake triage of any other ticket: nothing recognisable, so a low-confidence diagnosis goes to a human (§7).
    think(5000, { label: 'triage-unknown' }),
    text('Triaging the ticket read-only.'),
    plan('Diagnose the reported behaviour (read-only).', [['t1', 'Look for the reported behaviour', 's']]),
    tool('Glob', { pattern: 'src/**/*.ts' }),
    tool('Grep', { pattern: 'error|retry|timeout', path: 'src', '-i': true }),
    done('t1', 'test', 'manual reproduction > reported behaviour'),
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
