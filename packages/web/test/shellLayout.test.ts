import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * jsdom does no layout, so the side nav's geometry is pinned on the stylesheet itself; the a11y gate's screenshots
 * show the result in a real browser. What matters: the nav column is as tall as the page (background and rule
 * included) while only the nav inside it sticks, at viewport height under the top bar.
 */
const css = readFileSync(resolve(__dirname, '../src/shell/shell.css'), 'utf8');

/** Declarations of a top-level (unindented) rule. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.>]/g, '\\$&');
  const m = new RegExp(`^${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css);
  if (!m) throw new Error(`no top-level rule for ${selector}`);
  return m[1]!;
}

describe('operator shell: side nav column', () => {
  it('lets the aside fill the page height, with the background and rule on it', () => {
    const aside = rule('.aoc-sidebar');
    expect(aside).not.toMatch(/(^|[;\s])height\s*:/);
    expect(aside).not.toMatch(/position\s*:/);
    expect(aside).toMatch(/grid-area\s*:\s*nav/);
    expect(aside).toMatch(/border-right\s*:\s*1px solid var\(--border\)/);
    expect(aside).toMatch(/background\s*:\s*var\(--surface\)/);
  });

  it('sticks only the nav, at viewport height under the top bar', () => {
    const nav = rule('.aoc-sidebar > .aoc-nav');
    expect(nav).toMatch(/position\s*:\s*sticky/);
    expect(nav).toMatch(/top\s*:\s*var\(--topbar-h\)/);
    expect(nav).toMatch(/height\s*:\s*calc\(100dvh - var\(--topbar-h\)\)/);
  });
});
