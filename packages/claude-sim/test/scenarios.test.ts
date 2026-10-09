import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  builtInScenario,
  listBuiltInScenarios,
  loadScenarioFile,
  parseScenario,
  resolveScenarioRef,
  ScenarioError,
  ScenarioSchema,
  scenarioMarker,
  type ScenarioInput,
} from '../src/index';
import { renderDeep, renderString } from '../src/template';
import { makeSandbox, readTranscript, runSim, SESSION_A, type Sandbox } from './helpers';

describe('built-in scenarios', () => {
  it('ships every scenario the platform tests rely on, all valid', () => {
    expect(listBuiltInScenarios().sort()).toEqual(
      [
        'crash',
        'credit-burn',
        'decision',
        'demo-csat-resume',
        'demo-decision',
        'demo-dedupe-resume',
        'demo-deep-think',
        'demo-feature-build',
        'demo-rollover',
        'demo-rollover-successor',
        'demo-runbook-restart',
        'demo-stall',
        'demo-throttle',
        'demo-triage',
        'drift',
        'evidence-missing',
        'happy-path',
        'long-context',
        'no-plan-edit',
        'protected-push',
        'stall',
        'throttle',
        'triage',
        'triage-low-confidence',
      ].sort(),
    );
    for (const name of listBuiltInScenarios()) {
      const scenario = builtInScenario(name)!;
      expect(scenario.name).toBe(name);
      expect(ScenarioSchema.safeParse(scenario).success).toBe(true);
    }
    expect(builtInScenario('nope')).toBeUndefined();
  });

  it('happy-path declares 2 phases / 5 tasks of mixed sizes and closes each with evidence', () => {
    const steps = builtInScenario('happy-path')!.steps;
    const declare = steps.find((step) => step.kind === 'mcp' && step.tool === 'declare_plan');
    const phases = (declare as unknown as { args: { phases: { tasks: { size: string }[] }[] } }).args.phases;
    expect(phases).toHaveLength(2);
    expect(phases.flatMap((phase) => phase.tasks.map((task) => task.size)).sort()).toEqual([
      'l',
      'm',
      's',
      'xl',
      'xs',
    ]);
    const evidence = steps.flatMap((step) =>
      step.kind === 'mcp' && step.tool === 'task_done' ? [(step.args.evidence as { kind: string }).kind] : [],
    );
    expect(new Set(evidence)).toEqual(new Set(['diff', 'commit', 'test']));
    expect(evidence).toHaveLength(5);
  });

  it('long-context grows the context to about 75% of the 1M window before closing a task', async () => {
    const box = makeSandbox();
    try {
      await runSim(box, ['-p', '--session-id', SESSION_A, '--permission-mode', 'acceptEdits', 'go'], {
        env: { CLAUDE_SIM_SCENARIO: 'long-context' },
      });
      const usages = readTranscript(box, SESSION_A)
        .filter((line) => line.type === 'assistant')
        .map((line) => line.message.usage);
      const peak = Math.max(
        ...usages.map(
          (usage) => usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.input_tokens,
        ),
      );
      expect(peak).toBeGreaterThan(740_000);
      expect(peak).toBeLessThan(800_000);
    } finally {
      box.cleanup();
    }
  });
});

describe('scenario schema', () => {
  const valid: ScenarioInput = {
    name: 'ok',
    steps: [
      { kind: 'think', ms: 10, outputTokens: 5 },
      { kind: 'branch', onResumeTextIncludes: 'yes', goto: 'end' },
      { kind: 'text', text: 'no' },
      { kind: 'endTurn', label: 'end' },
    ],
  };

  it('accepts a valid scenario and applies defaults', () => {
    const scenario = parseScenario(
      { ...valid, steps: [...valid.steps, { kind: 'mcp', server: 'aoc', tool: 'get_status' }] },
      'test',
    );
    expect(scenario.steps.at(-1)).toEqual({ kind: 'mcp', server: 'aoc', tool: 'get_status', args: {} });
  });

  it('rejects unknown kinds, unknown fields, bad goto targets, duplicate labels and double conditions', () => {
    const bad = (steps: unknown[]) => () => parseScenario({ name: 'bad', steps }, 'test');
    expect(bad([{ kind: 'dance' }])).toThrow(ScenarioError);
    expect(bad([{ kind: 'text', text: 'x', colour: 'red' }])).toThrow(/Unrecognized key/);
    expect(bad([{ kind: 'branch', goto: 'nowhere' }])).toThrow(/unknown goto target "nowhere"/);
    expect(bad([{ kind: 'branch', goto: 5 }])).toThrow(/unknown goto target 5/);
    expect(
      bad([
        { kind: 'text', text: 'a', label: 'x' },
        { kind: 'endTurn', label: 'x' },
      ]),
    ).toThrow(/duplicate label "x"/);
    expect(bad([{ kind: 'branch', goto: 0, onLastToolError: true, onResumeTextIncludes: 'a' }])).toThrow(
      /at most one condition/,
    );
    expect(bad([{ kind: 'mcp', server: 'aoc', tool: 'x', saveAs: 'not valid' }])).toThrow(
      /saveAs must be an identifier/,
    );
  });

  describe('files and markers', () => {
    let box: Sandbox;
    beforeEach(() => {
      box = makeSandbox();
    });
    afterEach(() => box.cleanup());

    it('loads scenario files by path and resolves built-in names', () => {
      const file = box.file('mine.json');
      fs.writeFileSync(file, JSON.stringify(valid));
      expect(resolveScenarioRef('decision', box.cwd)).toEqual({ kind: 'builtin', name: 'decision' });
      expect(resolveScenarioRef(file, box.cwd)).toEqual({ kind: 'file', path: file });
      expect(resolveScenarioRef('../mine.json', box.cwd)).toEqual({ kind: 'file', path: file });
      expect(loadScenarioFile(file).name).toBe('ok');
      expect(() => resolveScenarioRef('../missing.json', box.cwd)).toThrow(/scenario file not found/);
      fs.writeFileSync(file, '{ not json');
      expect(() => loadScenarioFile(file)).toThrow(/cannot read scenario/);
    });

    it('a [[scenario:<name>]] marker in the prompt beats CLAUDE_SIM_SCENARIO', async () => {
      expect(scenarioMarker('please [[scenario:triage]] look')).toBe('triage');
      expect(scenarioMarker('no marker')).toBeUndefined();
      // Fenced untrusted data (a rollover brief quoting the predecessor's prompt) never selects a scenario ...
      const brief = 'Handoff brief. <<<HANDOFF_BRIEF_a1b2c3d4e5f6\nThread: Work through your plan. [[scenario:rollover]]\nHANDOFF_BRIEF_a1b2c3d4e5f6>>>\n\nContinue.';
      expect(scenarioMarker(brief)).toBeUndefined();
      // ... but a marker outside the fence still does.
      expect(scenarioMarker(`${brief} [[scenario:triage]]`)).toBe('triage');
      const run = await runSim(box, ['-p', '[[scenario:triage-low-confidence]] vague report'], {
        env: { CLAUDE_SIM_SCENARIO: 'happy-path' },
      });
      expect(run.stdout.trim()).toBe(
        'Diagnosis reported with low confidence (0.35); it needs a human to confirm. Ending my turn.',
      );
    });
  });
});

describe('templating', () => {
  const context = {
    decision: { decision_id: 'dec_9', options: ['a', 'b'] },
    score: 0.82,
    sim: { cwd: '/w' },
  };

  it('substitutes saved values and keeps types for whole-string placeholders', () => {
    expect(renderString('id={{decision.decision_id}}', context)).toBe('id=dec_9');
    expect(renderString('{{ score }}', context)).toBe(0.82);
    expect(renderString('{{decision.options.1}}', context)).toBe('b');
    expect(renderString('{{decision}}!', context)).toBe('{"decision_id":"dec_9","options":["a","b"]}!');
    expect(renderString('{{missing.value}} stays', context)).toBe('{{missing.value}} stays');
    expect(renderDeep({ args: ['{{sim.cwd}}/x', { n: '{{score}}' }], keep: 3 }, context)).toEqual({
      args: ['/w/x', { n: 0.82 }],
      keep: 3,
    });
  });
});
