import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  flatten,
  parseTokenSheet,
  resolveColour,
  THEMES,
  toHex,
  type Theme,
} from './contrast';

/**
 * WCAG 2.x AA for the token set (G-32, §12): every text/background and mark/background pair the design uses,
 * in both themes. Pairs are written exactly as the stylesheets write them (a token, or the color-mix the CSS
 * uses), with a background stack when a translucent layer sits on a surface. Where a pair comes from:
 * packages/web/src/{styles,components,charts,shell}/**.css and the approved mock (mocks/aoc-mock.html).
 */

const WEB = resolve(__dirname, '..');
const sheet = parseTokenSheet(readFileSync(join(WEB, 'src/design/tokens.css'), 'utf8'));

/** 1.4.3 normal text. */
const TEXT = 4.5;
/** 1.4.11 icons, marks, component boundaries and focus indicators. */
const UI = 3;

interface Pair {
  fg: string;
  /** One surface, or layers bottom-first (a translucent hover/overlay on a surface). */
  bg: string | readonly string[];
  min: number;
  use: string;
}

const ink = (token: string) => `color-mix(in srgb, var(${token}) 75%, var(--text))`;
const on = (
  fgs: readonly string[],
  bgs: readonly (string | readonly string[])[],
  min: number,
  use: string,
): Pair[] => fgs.flatMap((fg) => bgs.map((bg) => ({ fg, bg, min, use })));

const NEUTRAL = ['--bg', '--surface', '--surface-2', '--surface-3'] as const;
const LIVE = ['working', 'thinking', 'stalled', 'dead', 'throttled', 'waiting'] as const;
const ATTENTION = ['waiting', 'throttled', 'dead', 'stalled'] as const;
const SOFT = ['working', 'thinking'] as const;
const STATUS = ['ok', 'warn', 'danger', 'info'] as const;
const HOVER_10 = ['--surface', 'color-mix(in srgb, var(--text) 10%, transparent)'] as const;
const HOVER_7 = ['--surface', 'color-mix(in srgb, var(--text) 7%, transparent)'] as const;

const GROUPS: Record<string, Pair[]> = {
  'text on neutral surfaces': [
    ...on(
      ['--text', '--text-2', '--text-3'],
      NEUTRAL,
      TEXT,
      'body / secondary / muted text on page, card, well and track',
    ),
    ...on(
      ['--text', '--text-2'],
      [HOVER_10, HOVER_7],
      TEXT,
      'text over hover washes (chip remove, chart hit targets)',
    ),
    { fg: '--surface', bg: '--text', min: TEXT, use: 'tooltip (.aoc-tooltip) and mock timeline tooltip' },
    { fg: '--text', bg: '--border-strong', min: TEXT, use: 'mock current phase band (.band--current)' },
  ],

  'text on tinted surfaces': [
    ...on(
      ['--text', '--text-2'],
      ['--accent-soft', ...LIVE.map((l) => `--live-${l}-soft`)],
      TEXT,
      'nav/row/portal active state, recommendation box, liveness badges, alerts, mock verify box',
    ),
    ...on(
      ['--text-3'],
      ['--accent-soft', '--warn-soft'],
      TEXT,
      'muted text in an active row and in the funnel bottleneck stage',
    ),
    ...on(
      ['--text', '--text-2'],
      ['color-mix(in srgb, var(--accent) 20%, var(--surface))'],
      TEXT,
      'timeline active phase band label',
    ),
  ],

  'liveness badges and marks': [
    // Solid badges for the four states that need a human (liveness.css, approved mock decision 5).
    ...ATTENTION.map((l) => ({
      fg: '--text-inverse',
      bg: `--live-${l}`,
      min: TEXT,
      use: `${l} solid badge icon, word and detail (.aoc-liveness[data-tone=${l}])`,
    })),
    // Soft badges (Working, Thinking): coloured icon on the tint; word and detail in ink.
    ...SOFT.flatMap((l) => [
      {
        fg: `--live-${l}`,
        bg: `--live-${l}-soft`,
        min: UI,
        use: `${l} soft badge icon (.aoc-liveness__icon)`,
      },
      { fg: '--text', bg: `--live-${l}-soft`, min: TEXT, use: `${l} soft badge word` },
      { fg: '--text-2', bg: `--live-${l}-soft`, min: TEXT, use: `${l} soft badge detail` },
    ]),
    ...LIVE.flatMap((l) => [
      { fg: `--live-${l}`, bg: '--surface', min: UI, use: `${l} icon / alive dot / mix legend on a card` },
      { fg: `--live-${l}`, bg: '--bg', min: UI, use: `${l} icon on the page background` },
      {
        fg: '--text-inverse',
        bg: `--live-${l}`,
        min: TEXT,
        use: `${l} liveness-mix segment count (mock .mix__seg--${l})`,
      },
    ]),
    { fg: '--text-3', bg: '--surface-2', min: UI, use: 'ended / retired badge icon (neutral tone)' },
    { fg: '--text', bg: '--surface-2', min: TEXT, use: 'ended / retired badge word' },
    {
      fg: '--text-inverse',
      bg: '--live-waiting',
      min: TEXT,
      use: 'needs-you count on the Tower tab (mock .tab__count)',
    },
  ],

  'status tones': [
    ...STATUS.flatMap((s) => [
      {
        fg: ink(`--${s}`),
        bg: `--${s}-soft`,
        min: TEXT,
        use: `${s} soft badge / chip / recurrence stage text (--tone-ink)`,
      },
      { fg: ink(`--${s}`), bg: '--surface', min: TEXT, use: `${s} outline badge text on a card` },
      { fg: `--${s}`, bg: `--${s}-soft`, min: UI, use: `${s} alert / badge icon and meter fill on its tint` },
      { fg: '--text-inverse', bg: `--${s}`, min: TEXT, use: `${s} solid badge text (--tone-solid-fg)` },
      ...on(
        [`--${s}`],
        ['--bg', '--surface', '--surface-2'],
        TEXT,
        `${s} as text: KPI / trend delta (.aoc-tone-text--${s}), also on a hovered table row`,
      ),
    ]),
    { fg: ink('--accent'), bg: '--accent-soft', min: TEXT, use: 'accent soft badge, selected toggle chip' },
    { fg: ink('--text-2'), bg: '--surface-2', min: TEXT, use: 'neutral soft badge / chip' },
    { fg: '--surface', bg: '--text-2', min: TEXT, use: 'neutral solid badge' },
    { fg: '--danger', bg: HOVER_10, min: TEXT, use: 'danger menu item on hover (.aoc-menu__item.is-danger)' },
    ...on(
      ['--danger', '--warn', '--info', '--text-3'],
      ['--surface', '--surface-2'],
      UI,
      'attention-queue severity icon (RankedList SEVERITY_META)',
    ),
    ...on(
      ['--ok', '--warn', '--danger'],
      ['--surface', '--warn-soft', '--danger-soft'],
      UI,
      'connection status dot (.aoc-conn__dot)',
    ),
  ],

  'interactive and brand': [
    ...on(
      ['--accent', '--accent-hover'],
      ['--bg', '--surface', '--surface-2'],
      TEXT,
      'links, link buttons, toast action, active phase name',
    ),
    ...on(
      ['--accent-contrast'],
      ['--accent', '--accent-hover'],
      TEXT,
      'primary button, skip link, count badge, active phase index',
    ),
    ...on(
      ['--text-inverse'],
      ['--danger', 'color-mix(in srgb, var(--danger) 86%, var(--text))'],
      TEXT,
      'danger button and its hover',
    ),
    ...on(
      ['--accent'],
      ['--accent-soft', '--surface'],
      UI,
      'active nav icon and bar, selected chip icon, tab underline',
    ),
    ...on(
      ['--accent'],
      ['--surface', '--surface-2'],
      UI,
      'busy hairline along the top of a refreshing table, widget body or resource (.is-busy::before)',
    ),
    ...on(
      ['--text-3'],
      ['--surface', '--surface-2'],
      UI,
      'selected segment boundary against its thumb and its track (.aoc-seg__option.is-selected)',
    ),
    {
      fg: '--brand-red-contrast',
      bg: '--brand-red',
      min: TEXT,
      use: 'wordmark tile letters (.aoc-mark__tile)',
    },
  ],

  'focus and form boundaries': [
    ...on(
      ['--accent'],
      ['--surface', '--bg', '--surface-2', '--accent-soft'],
      UI,
      'focus ring (--focus: 2px --surface then 2px --accent) against what it sits on',
    ),
    ...on(
      ['color-mix(in srgb, var(--text-3) 80%, var(--surface))'],
      ['--surface', '--bg'],
      UI,
      'text input / select / textarea boundary (.aoc-input)',
    ),
    ...on(
      ['--text-2', '--accent', '--danger'],
      ['--surface'],
      UI,
      'input boundary on hover / focus / invalid',
    ),
  ],

  'chart marks and series': [
    ...on(
      ['--series-1', '--series-2', '--series-3', '--series-4'],
      ['--surface'],
      UI,
      'categorical series and sparkline line on a card (charts/shared.tsx SERIES)',
    ),
    ...on(
      ['--mark-decision', '--mark-drift', '--mark-rollback', '--mark-enhancement', '--mark-tool'],
      ['--surface'],
      UI,
      'timeline marks and tool-call ticks (drawn on --surface only)',
    ),
    ...on(
      ['--live-stalled', '--text-3', '--text-2'],
      ['--surface'],
      UI,
      'flat sparkline segment, muted sparkline, mock neutral bars',
    ),
    {
      fg: '--series-1',
      bg: 'color-mix(in srgb, var(--series-1) 16%, var(--surface))',
      min: UI,
      use: 'phase bar done vs its track',
    },
    {
      fg: '--accent',
      bg: 'color-mix(in srgb, var(--accent) 16%, var(--surface-2))',
      min: UI,
      use: 'progress bar / cost-of-delay fill vs track',
    },
    ...on(
      ['--series-1', '--warn', '--text-2'],
      ['--surface-3'],
      UI,
      'funnel fill / bottleneck fill / mock cost-of-delay bar on a --surface-3 track',
    ),
    {
      fg: '--live-throttled',
      bg: '--surface-2',
      min: UI,
      use: 'throttle span on the mock strip (.tstrip__span)',
    },
    { fg: '--text', bg: '--surface', min: UI, use: 'now line, baseline, hover dot outline' },
  ],

  'chart text': [
    ...on(
      ['--text-2', '--text-3'],
      ['--surface'],
      TEXT,
      'values at bar tips, axis and legend labels on a card',
    ),
    { fg: '--text-2', bg: '--surface-3', min: TEXT, use: 'timeline band label, tab count, phase index' },
  ],
};

/**
 * Measured but not asserted, and why. A pair may only live here if the design keeps it out of the situation
 * that would need AA (decorative, inactive, or never placed on that surface).
 */
const EXCEPTIONS: ReadonlyArray<{ fg: string; bg: string; why: string }> = [
  { fg: '--border', bg: '--surface', why: 'decorative hairline; never the only boundary of a control' },
  {
    fg: '--border-strong',
    bg: '--surface',
    why: 'decorative; buttons and chips are identified by their label',
  },
  { fg: '--grid', bg: '--surface', why: 'gridlines are recessive; every chart prints its values' },
  {
    fg: '--mark-drift',
    bg: '--surface-2',
    why: 'light 2.84:1; drift marks are drawn on --surface only (mocks/README.md)',
  },
  { fg: '--mark-tool', bg: '--bg', why: 'light 2.84:1; tool ticks sit inside chart cards (--surface)' },
  {
    fg: 'color-mix(in srgb, var(--series-1) 35%, var(--surface))',
    bg: '--surface',
    why: 'latency p50–p90 range tint; p50 and p90 are printed as text beside every row',
  },
  {
    fg: 'color-mix(in srgb, var(--danger) 45%, var(--surface))',
    bg: '--surface',
    why: 'over-SLA tint; the breach is also a word and an icon beside the row',
  },
];

function measure(theme: Theme, pair: Pick<Pair, 'fg' | 'bg'>): { ratio: number; label: string } {
  const tokens = sheet[theme];
  const layers = typeof pair.bg === 'string' ? [pair.bg] : pair.bg;
  const bg = flatten(layers.map((l) => resolveColour(l, tokens)));
  const fg = resolveColour(pair.fg, tokens);
  return {
    ratio: contrastRatio(fg, bg),
    label: `${pair.fg} (${toHex(fg)}) on ${layers.join(' + ')} (${toHex(bg)})`,
  };
}

describe('design token contrast (WCAG 2.x AA)', () => {
  it('parses both themes from tokens.css', () => {
    expect(sheet.light.get('--surface')).toBe('#ffffff');
    expect(sheet.dark.get('--surface')).not.toBe(sheet.light.get('--surface'));
    // the extension block (aliases) applies to both themes
    expect(sheet.dark.get('--ok-soft')).toBe('var(--live-working-soft)');
  });

  for (const theme of THEMES) {
    describe(theme, () => {
      it.each(Object.entries(GROUPS))('%s', (_group, pairs) => {
        const failures = pairs.flatMap((p) => {
          const m = measure(theme, p);
          return m.ratio < p.min ? [`${m.ratio.toFixed(2)}:1 < ${p.min}:1  ${m.label}  [${p.use}]`] : [];
        });
        expect(failures).toEqual([]);
      });
    });
  }

  it('keeps each documented exception below 3:1 (a passing one belongs in GROUPS)', () => {
    for (const ex of EXCEPTIONS) {
      const worst = Math.min(...THEMES.map((t) => measure(t, ex).ratio));
      expect(worst, `${ex.fg} on ${ex.bg} now passes 3:1; move it into GROUPS`).toBeLessThan(UI);
    }
  });
});

/**
 * Coverage: a colour the shared layer paints text or marks with must be in a pair above, so a new usage cannot
 * dodge this test. Component-scoped variables (--tone-ink, --lv-fg, ...) are covered through the tokens they
 * resolve to; keywords (inherit, currentColor) carry no colour of their own.
 */
const SHARED_DIRS = ['src/styles', 'src/components', 'src/charts', 'src/shell'];

function filesUnder(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && ext.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

const normalise = (expr: string) => {
  const e = expr.replace(/\s+/g, ' ').trim();
  const single = /^var\((--[\w-]+)\)$/.exec(e);
  return single ? single[1]! : e;
};

const COVERED_FG = new Set(Object.values(GROUPS).flatMap((ps) => ps.map((p) => normalise(p.fg))));
const COVERED_ANY = new Set([
  ...COVERED_FG,
  ...Object.values(GROUPS).flatMap((ps) =>
    ps.flatMap((p) => (typeof p.bg === 'string' ? [p.bg] : p.bg).map(normalise)),
  ),
  ...EXCEPTIONS.flatMap((e) => [normalise(e.fg), normalise(e.bg)]),
]);

/** True when every var() in the expression is a design token (not a component-scoped variable). */
const usesOnlyTokens = (expr: string) => {
  const names = [...expr.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!);
  return names.length > 0 && names.every((n) => sheet.light.has(n));
};

describe('contrast pair coverage of the shared layer', () => {
  const cssFiles = SHARED_DIRS.flatMap((d) => filesUnder(join(WEB, d), /\.css$/));
  const tsxFiles = SHARED_DIRS.flatMap((d) => filesUnder(join(WEB, d), /\.tsx?$/));

  it('finds the shared stylesheets', () => {
    expect(cssFiles.length).toBeGreaterThan(5);
  });

  it('measures the input boundary controls.css actually paints', () => {
    const css = readFileSync(join(WEB, 'src/components/styles/controls.css'), 'utf8');
    const border = /\.aoc-input \{[^}]*?border: 1px solid ([^;]+);/.exec(css)?.[1];
    expect(border).toBeDefined();
    expect(COVERED_FG.has(normalise(border!))).toBe(true);
  });

  it('pairs every token used as a text or icon colour (`color:`)', () => {
    const missing: string[] = [];
    for (const file of cssFiles) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/(?:^|[\s;{])color:\s*([^;}]+)/g)) {
        const expr = m[1]!;
        if (!usesOnlyTokens(expr)) continue;
        if (!COVERED_FG.has(normalise(expr)))
          missing.push(`${relative(WEB, file)}: color: ${normalise(expr)}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });

  it('pairs every token used as an SVG fill / stroke or inline colour', () => {
    const missing: string[] = [];
    for (const file of cssFiles) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/(?:^|[\s;{])(?:fill|stroke):\s*([^;}]+)/g)) {
        const expr = m[1]!;
        if (!usesOnlyTokens(expr)) continue;
        if (!COVERED_ANY.has(normalise(expr))) missing.push(`${relative(WEB, file)}: ${normalise(expr)}`);
      }
    }
    for (const file of tsxFiles) {
      for (const m of readFileSync(file, 'utf8').matchAll(/'var\((--[\w-]+)\)'/g)) {
        const token = m[1]!;
        if (sheet.light.has(token) && !COVERED_ANY.has(token))
          missing.push(`${relative(WEB, file)}: ${token}`);
      }
    }
    expect([...new Set(missing)]).toEqual([]);
  });
});
