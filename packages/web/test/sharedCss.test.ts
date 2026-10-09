import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * jsdom does no layout or painting, so these pin the shared stylesheets themselves where a change cannot be seen
 * from a render: the a11y gate's captures show the result in a real browser. Token contrast for the colours used
 * here is asserted in tokenContrast.test.ts.
 */
const read = (file: string) => readFileSync(resolve(__dirname, '../src', file), 'utf8');
const SHELL = read('shell/shell.css');
const BASE = read('styles/base.css');
const SURFACES = read('components/styles/surfaces.css');
const TABLE = read('components/styles/table.css');
const CONTROLS = read('components/styles/controls.css');

/** Declarations of a top-level (unindented) rule; a selector list or a nested rule is not matched. */
function rule(css: string, selector: string): string {
  const escaped = selector.replace(/[.>:[\]=']/g, '\\$&');
  const m = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  if (!m) throw new Error(`no top-level rule for ${selector}`);
  return m[1]!;
}

describe('operator shell: side nav column', () => {
  it('lets the aside fill the page height, with the background and rule on it', () => {
    const aside = rule(SHELL, '.aoc-sidebar');
    expect(aside).not.toMatch(/(^|[;\s])height\s*:/);
    expect(aside).not.toMatch(/position\s*:/);
    expect(aside).toMatch(/grid-area\s*:\s*nav/);
    expect(aside).toMatch(/border-right\s*:\s*1px solid var\(--border\)/);
    expect(aside).toMatch(/background\s*:\s*var\(--surface\)/);
  });

  it('sticks only the nav, at viewport height under the top bar', () => {
    const nav = rule(SHELL, '.aoc-sidebar > .aoc-nav');
    expect(nav).toMatch(/position\s*:\s*sticky/);
    expect(nav).toMatch(/top\s*:\s*var\(--topbar-h\)/);
    expect(nav).toMatch(/height\s*:\s*calc\(100dvh - var\(--topbar-h\)\)/);
  });
});

describe('busy state', () => {
  it('never dims the content it covers: text keeps its contrast', () => {
    expect(BASE).not.toMatch(/\.is-busy\s*\{[^}]*opacity/);
    expect(BASE).not.toMatch(/\.is-busy[^{]*\{[^}]*opacity/);
  });

  it('shows a 2px accent hairline along the top edge instead', () => {
    const line = rule(BASE, '.is-busy::before');
    expect(line).toMatch(/position\s*:\s*absolute/);
    expect(line).toMatch(/inset\s*:\s*0 0 auto/);
    expect(line).toMatch(/height\s*:\s*2px/);
    expect(line).toMatch(/background\s*:\s*var\(--accent\)/);
    // A static line: nothing moves at rest (§12).
    expect(line).not.toMatch(/animation|transition/);
  });

  it('is drawn on positioned containers, so the line sits on the element and never shifts when it toggles', () => {
    expect(rule(TABLE, '.aoc-dt')).toMatch(/position\s*:\s*relative/);
    expect(rule(SURFACES, '.aoc-resource')).toMatch(/position\s*:\s*relative/);
    expect(rule(SURFACES, '.aoc-widget__body')).toMatch(/position\s*:\s*relative/);
  });
});

describe('segmented control', () => {
  it('reserves a boundary on every option so selecting one never moves the others', () => {
    expect(rule(CONTROLS, '.aoc-seg__option')).toMatch(/border\s*:\s*1px solid transparent/);
  });

  it('gives the selected option a --text-3 boundary instead of resting on the 1.1:1 tint', () => {
    const selected = rule(CONTROLS, '.aoc-seg__option.is-selected');
    expect(selected).toMatch(/border-color\s*:\s*var\(--text-3\)/);
    expect(selected).toMatch(/background\s*:\s*var\(--surface\)/);
  });
});
