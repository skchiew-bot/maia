/**
 * In-page probes for the a11y harness. This module runs inside the browser: check.ts bundles it to an IIFE
 * (global `__aocProbe`) and calls its exports with page.evaluate. DOM APIs only.
 */

/**
 * Who fixes a node: `shell` (outside <main>: top bar, nav, skip link, portal header), a shared component
 * block such as `aoc-stacked` (src/components, src/charts), or `page` (code under src/pages).
 */
export type Owner = string;

export interface Overflow {
  width: number;
  scrollWidth: number;
  overflows: boolean;
  offenders: { selector: string; right: number; owner: Owner }[];
}

export interface AnimationInfo {
  selector: string;
  name: string;
  owner: Owner;
}

export interface Animations {
  infinite: AnimationInfo[];
  running: AnimationInfo[];
}

export interface ChartInfo {
  selector: string;
  owner: Owner;
  size: string;
  role: string | null;
  name: string;
  hidden: boolean;
  nameHasNumber: boolean;
  adjacentNumbers: boolean;
  /** Why this chart has no text equivalent; null when it has one. */
  problem: string | null;
  /** Data colours that fall below 3:1 against the surface behind the chart. */
  lowContrastMarks: { token: string; ratio: number; background: string }[];
}

export interface FocusInfo {
  selector: string;
  label: string;
  owner: Owner;
  isPrimary: boolean;
  isSkipLink: boolean;
  /** Focus came back to an element visited earlier in this walk. */
  revisit: boolean;
  /** The focus style recognised from computed styles, or null (the caller then compares pixels). */
  indicator: 'outline' | 'ring' | null;
  rect: { x: number; y: number; width: number; height: number };
}

export interface PrimaryAction {
  kind: 'primary' | 'first' | 'none';
  selector?: string;
  label?: string;
}

const FOCUSABLE =
  'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

const DATA_TOKENS = [
  '--series-1',
  '--series-2',
  '--series-3',
  '--series-4',
  '--series-5',
  '--series-6',
  '--mark-decision',
  '--mark-drift',
  '--mark-rollback',
  '--mark-enhancement',
  '--mark-tool',
  '--live-working',
  '--live-thinking',
  '--live-stalled',
  '--live-dead',
  '--live-throttled',
  '--live-waiting',
  '--ok',
  '--warn',
  '--danger',
  '--info',
  '--accent',
];

/** Utility classes say nothing about who rendered a node. */
const UTILITY = /^aoc-(num|sr-only|icon|tone|tone-text|loading|link-button)(\b|-|$)/;
/** Shared containers whose contents come from the page. */
const CONTAINER =
  /^aoc-(main|app|portal|standalone|resource|stack|wgrid|widget__body|widget__footer|widget__actions|dt__td|tabs__panel|dialog__body|dialog__footer|drawer__body|drawer__footer|page-header__actions|page-header__meta|empty__action|filterbar)(\b|$)/;

export function ownerOf(el: Element): Owner {
  if (!el.closest('main')) return 'shell';
  for (let n: Element | null = el; n && n.tagName.toLowerCase() !== 'main'; n = n.parentElement) {
    const classes = [...n.classList].filter(
      (c) => !c.startsWith('is-') && !c.startsWith('has-') && !UTILITY.test(c),
    );
    if (classes.length === 0) continue;
    if (classes.some((c) => CONTAINER.test(c)) || classes.some((c) => !c.startsWith('aoc-'))) return 'page';
    return classes[0]!.replace(/(__|--).*$/, '');
  }
  return 'page';
}

export function selectorOf(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && depth < 4 && node !== document.body; depth++) {
    let part = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`${part}#${node.id}`);
      break;
    }
    const classes = [...node.classList]
      .filter((c) => !c.startsWith('is-') && !c.startsWith('has-'))
      .slice(0, 2);
    if (classes.length) part += `.${classes.join('.')}`;
    parts.unshift(part);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

function labelOf(el: Element): string {
  const text = el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? el.textContent ?? '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 60);
}

function isVisible(el: Element): boolean {
  if (el.getClientRects().length === 0) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

/** Horizontal page scroll and the outermost elements that stick out past the viewport. */
export function overflow(): Overflow {
  const doc = document.documentElement;
  const width = doc.clientWidth;
  const scrollWidth = Math.max(doc.scrollWidth, document.body.scrollWidth);
  const found: Element[] = [];
  if (scrollWidth > width + 1) {
    for (const el of document.body.querySelectorAll('*')) {
      if (found.length >= 8) break;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= width + 1) continue;
      if (getComputedStyle(el).position === 'fixed') continue;
      if (found.some((o) => o.contains(el))) continue;
      if (clippedByAncestor(el)) continue;
      found.push(el);
    }
  }
  return {
    width,
    scrollWidth,
    overflows: scrollWidth > width + 1,
    offenders: found.map((el) => ({
      selector: selectorOf(el),
      right: Math.round(el.getBoundingClientRect().right),
      owner: ownerOf(el),
    })),
  };
}

function clippedByAncestor(el: Element): boolean {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const cs = getComputedStyle(p);
    if (cs.position === 'fixed') return true;
    if (['hidden', 'auto', 'scroll', 'clip'].includes(cs.overflowX)) return true;
  }
  return false;
}

/** Infinite animations (never allowed, §12) and anything still moving at rest (reported). */
export function animations(): Animations {
  const infinite: AnimationInfo[] = [];
  const running: AnimationInfo[] = [];
  for (const a of document.getAnimations()) {
    const effect = a.effect as KeyframeEffect | null;
    const target = effect?.target ?? null;
    const name =
      (a as CSSAnimation).animationName ?? (a as CSSTransition).transitionProperty ?? (a.id || 'animation');
    const entry = {
      selector: target ? selectorOf(target) : '(detached)',
      name,
      owner: target ? ownerOf(target) : 'page',
    };
    if (effect?.getComputedTiming().iterations === Infinity) infinite.push(entry);
    else if (a.playState === 'running') running.push(entry);
  }
  for (const el of document.querySelectorAll('animate, animateTransform, animateMotion, set')) {
    if (el.getAttribute('repeatCount') === 'indefinite' || el.getAttribute('repeatDur') === 'indefinite')
      infinite.push({ selector: selectorOf(el), name: `SMIL <${el.tagName}>`, owner: ownerOf(el) });
  }
  return { infinite, running };
}

type Rgb = [number, number, number, number];

function parseRgb(value: string): Rgb | null {
  const m = /rgba?\(([^)]+)\)/.exec(value);
  if (!m) return null;
  const [r, g, b, a] = m[1]!
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  return [r! / 255, g! / 255, b! / 255, a === undefined || Number.isNaN(a) ? 1 : a];
}

function luminance([r, g, b]: Rgb): number {
  const ch = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [l1, l2] = [luminance(a), luminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/** The opaque colour painted behind an element: its ancestors' backgrounds composited bottom-up. */
function backgroundBehind(el: Element): Rgb {
  const layers: Rgb[] = [];
  for (let p = el.parentElement; p; p = p.parentElement) {
    const c = parseRgb(getComputedStyle(p).backgroundColor);
    if (c && c[3] > 0) layers.push(c);
    if (c && c[3] >= 1) break;
  }
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const opaque = layers.length > 0 && layers[layers.length - 1]![3] >= 1;
  let out: Rgb = opaque ? layers.pop()! : dark ? [0, 0, 0, 1] : [1, 1, 1, 1];
  for (const top of layers.reverse()) {
    const a = top[3];
    out = [top[0] * a + out[0] * (1 - a), top[1] * a + out[1] * (1 - a), top[2] * a + out[2] * (1 - a), 1];
  }
  return out;
}

const hex = (c: Rgb) =>
  `#${c
    .slice(0, 3)
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/** Computed `rgb()` string of each data-colour token, as the browser resolves it in the current theme. */
function dataPalette(): Map<string, string> {
  const map = new Map<string, string>();
  const probe = document.createElement('span');
  document.body.appendChild(probe);
  for (const token of DATA_TOKENS) {
    probe.style.color = `var(${token})`;
    const value = getComputedStyle(probe).color;
    if (!map.has(value)) map.set(value, token);
  }
  probe.remove();
  return map;
}

function accessibleName(el: Element): string {
  const ids = el.getAttribute('aria-labelledby');
  if (ids) {
    const text = ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim();
    if (text) return text;
  }
  const label = el.getAttribute('aria-label')?.trim();
  if (label) return label;
  const title = [...el.children].find((c) => c.tagName.toLowerCase() === 'title');
  return title?.textContent?.trim() ?? '';
}

/** Text with a digit that is painted on screen (not visually hidden) under `root`, skipping `skip`. */
function hasVisibleDigits(root: Element, skip: Element | null): boolean {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!/\d/.test(n.textContent ?? '')) continue;
    const parent = n.parentElement;
    if (!parent || (skip && skip.contains(parent))) continue;
    const r = parent.getBoundingClientRect();
    if (r.width > 1 && r.height > 1 && isVisible(parent)) return true;
  }
  return false;
}

/** Numbers printed beside the chart: in its figure, a KPI tile, or within three ancestors of the svg. */
function hasAdjacentNumbers(svg: SVGSVGElement): boolean {
  const near: Element[] = [];
  for (let p = svg.parentElement, depth = 0; p && depth < 3; p = p.parentElement, depth++) {
    if (p.tagName.toLowerCase() === 'main' || p.classList.contains('aoc-widget__body')) break;
    near.push(p);
  }
  const figure = svg.closest('figure, .aoc-kpi');
  if (figure) near.push(figure);
  return near.some((c) => hasVisibleDigits(c, svg));
}

/** Every chart-sized svg: does it carry its numbers as text, and do its data colours clear 3:1? */
export function charts(): ChartInfo[] {
  const palette = dataPalette();
  const out: ChartInfo[] = [];
  for (const svg of document.querySelectorAll('svg')) {
    if (svg.parentElement?.closest('svg')) continue;
    if (!isVisible(svg)) continue;
    const r = svg.getBoundingClientRect();
    if (svg.classList.contains('aoc-icon') || (r.width <= 24 && r.height <= 24)) continue;
    const marks = svg.querySelectorAll('rect, path, circle, line, polyline, polygon, ellipse');
    if (marks.length === 0) continue;

    // A role="img" wrapper (the svg itself or an ancestor) makes everything inside it one named image.
    const image = svg.closest('[role="img"]');
    const role = image ? 'img' : svg.getAttribute('role');
    const hidden = svg.closest('[aria-hidden="true"]') !== null || role === 'presentation' || role === 'none';
    const name = hidden ? '' : accessibleName(image ?? svg);
    const nameHasNumber = /\d/.test(name);
    const adjacentNumbers = hasAdjacentNumbers(svg);
    // §12: the number is rendered as text (phones) and reaches screen readers (the image's name, or the
    // printed text beside it).
    const printed =
      adjacentNumbers || [...svg.querySelectorAll('text')].some((t) => hasVisibleDigits(t, null));
    const spoken = adjacentNumbers || (!hidden && nameHasNumber);
    let problem: string | null = null;
    if (!hidden && !role)
      problem =
        'the svg has no role: give it role="img" and an aria-label that states the numbers, or aria-hidden="true" when the numbers are printed beside it';
    else if (!hidden && !name) problem = `svg role="${role}" has no accessible name`;
    else if (!printed)
      problem = 'no number is printed with it (it must also render its numbers as text, for phones)';
    else if (!spoken)
      problem = hidden
        ? 'it is hidden from assistive tech and its numbers are only drawn inside the svg'
        : 'its accessible name has no numbers and its numbers are only drawn inside the svg';

    const background = backgroundBehind(svg);
    const low = new Map<string, number>();
    for (const mark of marks) {
      const cs = getComputedStyle(mark);
      if (cs.display === 'none' || Number(cs.opacity) < 0.9) continue;
      for (const [paint, alpha] of [
        [cs.fill, Number(cs.fillOpacity)],
        [cs.stroke, Number(cs.strokeOpacity)],
      ] as const) {
        const token = palette.get(paint);
        if (!token || alpha < 0.9) continue;
        const colour = parseRgb(paint);
        if (!colour) continue;
        const ratio = contrast(colour, background);
        if (ratio < 3 && (low.get(token) ?? Infinity) > ratio) low.set(token, ratio);
      }
    }
    out.push({
      selector: selectorOf(svg),
      owner: ownerOf(svg),
      size: `${Math.round(r.width)}×${Math.round(r.height)}`,
      role,
      name: name.slice(0, 140),
      hidden,
      nameHasNumber,
      adjacentNumbers,
      problem,
      lowContrastMarks: [...low].map(([token, ratio]) => ({
        token,
        ratio: Math.round(ratio * 100) / 100,
        background: hex(background),
      })),
    });
  }
  return out;
}

/**
 * Marks the element the keyboard walk should reach: an explicit `[data-primary-action]`, else the first
 * enabled `.aoc-btn--primary` in main, else main's first focusable element.
 */
export function markPrimaryAction(): PrimaryAction {
  for (const old of document.querySelectorAll('[data-a11y-primary]'))
    old.removeAttribute('data-a11y-primary');
  const main = document.querySelector('main') ?? document.body;
  const usable = (el: Element) =>
    isVisible(el) &&
    !(el as HTMLButtonElement).disabled &&
    el.getAttribute('aria-disabled') !== 'true' &&
    !el.closest('[inert], [aria-hidden="true"]');
  let kind: PrimaryAction['kind'] = 'primary';
  let el = [...main.querySelectorAll('[data-primary-action], .aoc-btn--primary')].find(usable);
  if (!el) {
    kind = 'first';
    el = [...main.querySelectorAll(FOCUSABLE)].find((e) => usable(e) && (e as HTMLElement).tabIndex >= 0);
  }
  if (!el) return { kind: 'none' };
  el.setAttribute('data-a11y-primary', '');
  return { kind, selector: selectorOf(el), label: labelOf(el) };
}

let accentRgb: string | null = null;
let stop = 0;

/** The focused element and whether its computed style shows a focus indicator (outline or the token ring). */
export function focusInfo(): FocusInfo | null {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  if (accentRgb === null) {
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.appendChild(probe);
    accentRgb = getComputedStyle(probe).color;
    probe.remove();
  }
  const revisit = el.hasAttribute('data-a11y-stop');
  if (!revisit) el.setAttribute('data-a11y-stop', String(++stop));
  const cs = getComputedStyle(el);
  const outline = parseRgb(cs.outlineColor);
  let indicator: FocusInfo['indicator'] = null;
  if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && outline && outline[3] > 0)
    indicator = 'outline';
  else if (cs.boxShadow.includes(accentRgb)) indicator = 'ring';
  const r = el.getBoundingClientRect();
  return {
    selector: selectorOf(el),
    label: labelOf(el),
    owner: ownerOf(el),
    isPrimary: el.hasAttribute('data-a11y-primary'),
    isSkipLink: el.classList.contains('aoc-skip-link'),
    revisit,
    indicator,
    rect: { x: r.x, y: r.y, width: r.width, height: r.height },
  };
}

/** Moves focus to the skip link, if the page has one. */
export function focusSkipLink(): boolean {
  const link = document.querySelector<HTMLElement>('.aoc-skip-link');
  link?.focus();
  return link !== null && document.activeElement === link;
}

/** After following the skip link: is focus on, or inside, the link's target? */
export function focusInSkipTarget(): boolean {
  const href = document.querySelector('.aoc-skip-link')?.getAttribute('href') ?? '#main';
  const target = document.getElementById(href.replace(/^#/, ''));
  const active = document.activeElement;
  return target !== null && active !== null && target.contains(active);
}

/** True when the skip target holds something Tab can land on. */
export function skipTargetHasFocusable(): boolean {
  const href = document.querySelector('.aoc-skip-link')?.getAttribute('href') ?? '#main';
  const target = document.getElementById(href.replace(/^#/, ''));
  return target !== null && [...target.querySelectorAll(FOCUSABLE)].some((e) => isVisible(e));
}

/** Owner of each axe target (the last selector of each target path). */
export function owners(selectors: string[]): Owner[] {
  return selectors.map((s) => {
    try {
      const el = document.querySelector(s);
      return el ? ownerOf(el) : 'page';
    } catch {
      return 'page';
    }
  });
}
