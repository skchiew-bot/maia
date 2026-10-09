import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  contextWindowFor,
  evenSampleIndices,
  isPlaceholderRef,
  isPlausibleTestId,
  matchPlaybookStep,
  phaseTagName,
  sizeOfWeight,
  slugify,
  testFileOf,
} from '../src/rules';

describe('naming rules', () => {
  it('slugifies project names', () => {
    expect(slugify('Widget Store!')).toBe('widget-store');
    expect(slugify('  Café — Ledger v2  ')).toBe('cafe-ledger-v2');
    expect(slugify('???')).toBe('project');
    expect(slugify('x'.repeat(60))).toHaveLength(40);
  });

  it('builds valid git tag names from any phase id the MCP schema allows', () => {
    for (const phaseId of ['P1', 'phase:1', '..x', 'a.lock', '-p', 'v1.2', 'x..y', 'end.']) {
      const tag = phaseTagName('widget-store', phaseId, 42);
      expect(tag).toMatch(/^aoc\/widget-store\/[^/]+\/42$/);
      expect(spawnSync('git', ['check-ref-format', `refs/tags/${tag}`]).status, tag).toBe(0);
    }
    expect(phaseTagName('widget-store', 'phase:1', 7)).toBe('aoc/widget-store/phase-1/7');
  });
});

describe('evidence plausibility', () => {
  it('accepts structured test ids and rejects prose or placeholders', () => {
    for (const ok of [
      'test/widget.test.ts > works',
      'pkg/store::saves_widgets',
      'WidgetSuite#savesWidgets',
      'tests.auth.test_login',
      'widget_test.go',
      '|mod-ledger| test/a.spec.tsx > b',
    ]) {
      expect(isPlausibleTestId(ok), ok).toBe(true);
    }
    for (const bad of ['all tests pass', 'n/a', 'tests', 'ok', '---', 'TestLogin', 'it works fine']) {
      expect(isPlausibleTestId(bad), bad).toBe(false);
    }
    expect(isPlaceholderRef('TBD')).toBe(true);
    expect(isPlaceholderRef('src/store.ts')).toBe(false);
  });

  it('extracts the named test file', () => {
    expect(testFileOf('test/widget.test.ts > works > fast')).toBe('test/widget.test.ts');
    expect(testFileOf('./pkg/foo_test.go:12')).toBe('pkg/foo_test.go');
    expect(testFileOf('tests/test_api.py::test_get')).toBe('tests/test_api.py');
    expect(testFileOf('|web| src/App.spec.tsx > renders')).toBe('src/App.spec.tsx');
    expect(testFileOf('pkg/store::saves_widgets')).toBeNull();
  });
});

describe('misc rules', () => {
  it('samples evenly, keeping first and last', () => {
    expect(evenSampleIndices(3, 5)).toEqual([0, 1, 2]);
    const s = evenSampleIndices(1000, 300);
    expect(s).toHaveLength(300);
    expect(s[0]).toBe(0);
    expect(s.at(-1)).toBe(999);
    expect(new Set(s).size).toBe(300);
  });

  it('maps models to context windows and weights back to sizes', () => {
    expect(contextWindowFor('claude-opus-5-5')).toBe(1_000_000);
    expect(contextWindowFor('some-other-model')).toBe(200_000);
    expect(contextWindowFor(null)).toBe(200_000);
    expect([1, 2, 3, 5, 8].map(sizeOfWeight)).toEqual(['xs', 's', 'm', 'l', 'xl']);
  });

  it('matches playbook steps by id or title', () => {
    const pb = {
      playbookId: 'p',
      processType: 't',
      version: 1,
      title: 'T',
      status: 'approved' as const,
      steps: [
        { id: 'design', title: 'Write the  design note' },
        { id: 'build', title: 'Build' },
      ],
    };
    expect(matchPlaybookStep(pb, ' BUILD ')).toEqual({ id: 'build', index: 1 });
    expect(matchPlaybookStep(pb, 'write the design note')).toEqual({ id: 'design', index: 0 });
    expect(matchPlaybookStep(pb, 'deploy')).toBeNull();
  });
});
