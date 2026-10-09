/**
 * WCAG 2.x contrast for the design tokens, read straight from tokens.css (no browser). Resolves var(),
 * hex, rgb() and `color-mix(in srgb, …)` the way the browser does for these tokens, so a pair can be written
 * exactly as the stylesheet writes it.
 */
export type Theme = 'light' | 'dark';
export const THEMES: readonly Theme[] = ['light', 'dark'];

/** sRGB channels in 0..1 (gamma-encoded) plus alpha. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type TokenMap = ReadonlyMap<string, string>;

interface CssRule {
  prelude: string;
  body: string;
  media: string | null;
}

function cssRules(css: string, media: string | null = null): CssRule[] {
  const out: CssRule[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const prelude = css.slice(i, open).trim();
    const body = css.slice(open + 1, j - 1);
    if (prelude.startsWith('@media')) out.push(...cssRules(body, prelude.slice('@media'.length).trim()));
    else out.push({ prelude, body, media });
    i = j;
  }
  return out;
}

/**
 * Custom properties declared on `:root` per theme, in cascade order: unconditional blocks apply to both
 * themes, `prefers-color-scheme: dark` blocks to dark only; other media blocks (reduced motion) are ignored.
 */
export function parseTokenSheet(css: string): Record<Theme, Map<string, string>> {
  const themes: Record<Theme, Map<string, string>> = { light: new Map(), dark: new Map() };
  for (const rule of cssRules(css.replace(/\/\*[\s\S]*?\*\//g, ''))) {
    if (rule.prelude !== ':root') continue;
    const dark = rule.media !== null && /prefers-color-scheme:\s*dark/.test(rule.media);
    if (rule.media !== null && !dark) continue;
    for (const decl of rule.body.split(';')) {
      const m = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(decl);
      if (!m) continue;
      if (!dark) themes.light.set(m[1]!, m[2]!);
      themes.dark.set(m[1]!, m[2]!);
    }
  }
  return themes;
}

/** Splits on commas that are not inside parentheses. */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(s.slice(start).trim());
  return parts;
}

/** The argument list of `name(...)` when `expr` is exactly one such call. */
function callArgs(expr: string, name: string): string | null {
  if (!expr.startsWith(`${name}(`) || !expr.endsWith(')')) return null;
  return expr.slice(name.length + 1, -1);
}

function parseHex(hex: string): Rgba {
  let h = hex.slice(1);
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) throw new Error(`bad hex colour ${hex}`);
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
}

/** rgb(r g b), rgb(r g b / a), rgb(r, g, b) and rgba(r, g, b, a); channels 0–255, alpha number or %. */
function parseRgbFunction(args: string): Rgba {
  let channels = args;
  let alpha: string | undefined;
  if (args.includes('/')) [channels, alpha] = args.split('/') as [string, string];
  else {
    const parts = args.split(',');
    if (parts.length === 4) {
      channels = parts.slice(0, 3).join(' ');
      alpha = parts[3];
    }
  }
  const ch = channels.replace(/,/g, ' ').trim().split(/\s+/).map(Number);
  if (ch.length !== 3 || ch.some((v) => Number.isNaN(v))) throw new Error(`bad rgb(${args})`);
  const a =
    alpha === undefined ? 1 : alpha.trim().endsWith('%') ? parseFloat(alpha) / 100 : parseFloat(alpha);
  return { r: ch[0]! / 255, g: ch[1]! / 255, b: ch[2]! / 255, a };
}

/** CSS Color 5 color-mix in srgb: premultiplied alpha, percentages normalised, a sum under 100% lowers alpha. */
function colorMix(args: string, tokens: TokenMap, seen: Set<string>): Rgba {
  const [space, ...colours] = splitTopLevel(args);
  if (space !== 'in srgb' || colours.length !== 2) throw new Error(`unsupported color-mix(${args})`);
  const parsed = colours.map((part) => {
    const m = /^([\s\S]+?)\s+(\d+(?:\.\d+)?)%$/.exec(part);
    return m ? { colour: m[1]!, pct: Number(m[2]) / 100 } : { colour: part, pct: undefined };
  });
  let p1 = parsed[0]!.pct;
  let p2 = parsed[1]!.pct;
  if (p1 === undefined && p2 === undefined) p1 = p2 = 0.5;
  else if (p1 === undefined) p1 = 1 - p2!;
  else if (p2 === undefined) p2 = 1 - p1;
  const sum = p1 + p2!;
  const alphaScale = sum < 1 ? sum : 1;
  p1 /= sum;
  p2 = p2! / sum;
  const c1 = resolveColour(parsed[0]!.colour, tokens, seen);
  const c2 = resolveColour(parsed[1]!.colour, tokens, seen);
  const a = c1.a * p1 + c2.a * p2;
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (k: 'r' | 'g' | 'b') => (c1[k] * c1.a * p1 + c2[k] * c2.a * p2) / a;
  return { r: mix('r'), g: mix('g'), b: mix('b'), a: a * alphaScale };
}

/** Resolves a colour expression (`--token`, `var(--token)`, hex, rgb(), color-mix(), transparent) in a theme. */
export function resolveColour(expr: string, tokens: TokenMap, seen: Set<string> = new Set()): Rgba {
  const e = expr.trim();
  if (e.startsWith('--')) return resolveColour(`var(${e})`, tokens, seen);
  const v = callArgs(e, 'var');
  if (v !== null) {
    const [name, fallback] = splitTopLevel(v);
    const value = tokens.get(name!);
    if (value === undefined) {
      if (fallback !== undefined) return resolveColour(fallback, tokens, seen);
      throw new Error(`unknown token ${name}`);
    }
    if (seen.has(name!)) throw new Error(`token cycle at ${name}`);
    return resolveColour(value, tokens, new Set([...seen, name!]));
  }
  if (e === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (e === 'white') return { r: 1, g: 1, b: 1, a: 1 };
  if (e === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  if (e.startsWith('#')) return parseHex(e);
  const rgb = callArgs(e, 'rgb') ?? callArgs(e, 'rgba');
  if (rgb !== null) return parseRgbFunction(rgb);
  const mix = callArgs(e, 'color-mix');
  if (mix !== null) return colorMix(mix, tokens, seen);
  throw new Error(`unsupported colour expression: ${expr}`);
}

/** Source-over compositing in sRGB, as browsers paint. */
export function composite(top: Rgba, under: Rgba): Rgba {
  const a = top.a + under.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const ch = (k: 'r' | 'g' | 'b') => (top[k] * top.a + under[k] * under.a * (1 - top.a)) / a;
  return { r: ch('r'), g: ch('g'), b: ch('b'), a };
}

/** Flattens background layers (bottom first) to the opaque colour a reader sees. */
export function flatten(layers: readonly Rgba[]): Rgba {
  const [base, ...rest] = layers;
  if (!base) throw new Error('no background layers');
  if (base.a < 1) throw new Error('the bottom background layer must be opaque');
  return rest.reduce((acc, layer) => composite(layer, acc), base);
}

function channel(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of an opaque colour. */
export function luminance(c: Rgba): number {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/** WCAG 2.x contrast ratio; a translucent foreground is composited over the background first. */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const top = fg.a < 1 ? composite(fg, bg) : fg;
  const l1 = luminance(top);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function toHex(c: Rgba): string {
  const h = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${c.a < 1 ? h(c.a) : ''}`;
}
