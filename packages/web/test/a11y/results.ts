import type { Animations, ChartInfo, Overflow, Owner, PrimaryAction } from './probe';

export type Role = 'approver' | 'builder' | 'requester' | 'anonymous';
export const ROLES: readonly Role[] = ['approver', 'builder', 'requester', 'anonymous'];

export interface Variant {
  id: string;
  width: number;
  height: number;
  scheme: 'light' | 'dark';
}

export const VARIANTS: readonly Variant[] = [
  { id: '1440 light', width: 1440, height: 900, scheme: 'light' },
  { id: '1440 dark', width: 1440, height: 900, scheme: 'dark' },
  { id: '360 light', width: 360, height: 740, scheme: 'light' },
  { id: '360 dark', width: 360, height: 740, scheme: 'dark' },
];

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  nodes: { target: string; summary: string; owner: Owner }[];
}

export interface FocusStop {
  selector: string;
  owner: Owner;
}

export interface Keyboard {
  primary: PrimaryAction;
  /** Tab presses from page load until the primary action had focus (or the walk ended). */
  tabs: number;
  reached: boolean;
  /** Why the walk stopped without reaching the primary action. */
  ended: 'end of tab order' | 'focus cycled' | 'limit' | null;
  skipLinkFirst: boolean;
  /** Following the skip link puts keyboard focus in its target; null when not applicable or not verifiable. */
  skipLinkWorks: boolean | null;
  /** Focus stops with no visible change when focused. */
  invisible: FocusStop[];
  /** Focus stops whose element is not on screen when focused. */
  offscreen: FocusStop[];
}

export interface PageResult {
  route: string;
  url: string;
  finalPath: string;
  role: Role;
  variant: string;
  file: string | null;
  placeholder: boolean;
  settled: boolean;
  loadMs: number;
  axe: AxeViolation[];
  overflow: Overflow | null;
  animations: Animations | null;
  charts: ChartInfo[];
  keyboard: Keyboard | null;
  consoleErrors: string[];
  failedRequests: string[];
  expectedFailures: string[];
  error: string | null;
}

export interface RoutingCheck {
  role: Role;
  path: string;
  expected: string;
  actual: string;
  ok: boolean;
}

export interface RunResult {
  startedAt: string;
  finishedAt: string;
  commit: string;
  branch: string;
  axeVersion: string;
  browser: string;
  dataDir: string;
  pages: PageResult[];
  routing: RoutingCheck[];
  notes: string[];
}

export type Gate = 'axe' | 'scroll' | 'motion' | 'charts' | 'keyboard' | 'console' | 'requests' | 'harness';

export interface Issue {
  gate: Gate;
  severity: 'fail' | 'warn';
  /** Stable across variants, so one finding is listed once with the variants it occurs in. */
  key: string;
  text: string;
  /** `page`, `shell`, or the shared component block (`aoc-stacked`) that renders the offending node. */
  owner: Owner;
}

const SERIOUS = new Set(['serious', 'critical']);
const code = (s: string) => `\`${s.replace(/`/g, "'").replace(/\|/g, '\\|')}\``;

/** Every gate's verdict for one page visit. */
export function issuesOf(p: PageResult): Issue[] {
  const out: Issue[] = [];
  const add = (gate: Gate, severity: Issue['severity'], key: string, text: string, owner: Owner = 'page') =>
    out.push({ gate, severity, key, text, owner });

  if (p.error) add('harness', 'fail', 'error', `could not be checked: ${p.error}`);
  if (!p.settled) add('harness', 'warn', 'settle', 'still loading 10 s after navigation');

  for (const v of p.axe) {
    const byOwner = new Map<Owner, AxeViolation['nodes']>();
    for (const n of v.nodes) byOwner.set(n.owner, [...(byOwner.get(n.owner) ?? []), n]);
    for (const [owner, nodes] of byOwner) {
      const first = nodes[0]!;
      add(
        'axe',
        SERIOUS.has(v.impact ?? '') ? 'fail' : 'warn',
        `axe:${v.id}:${owner}`,
        `axe ${code(v.id)} (${v.impact ?? 'n/a'}, ${nodes.length} node${nodes.length === 1 ? '' : 's'}): ${v.help} — e.g. ${code(first.target)}: ${first.summary} ([rule](${v.helpUrl}))`,
        owner,
      );
    }
  }

  if (p.overflow?.overflows && p.variant.startsWith('360')) {
    const offenders = p.overflow.offenders;
    const who = offenders.map((o) => `${code(o.selector)} (right edge ${o.right}px)`).join(', ');
    add(
      'scroll',
      'fail',
      'scroll',
      `horizontal page scroll at 360 px: content is ${p.overflow.scrollWidth}px wide${who ? `; sticks out: ${who}` : ''}`,
      offenders[0]?.owner ?? 'page',
    );
  }

  for (const a of p.animations?.infinite ?? [])
    add('motion', 'fail', `infinite:${a.selector}:${a.name}`, `infinite animation ${code(a.name)} on ${code(a.selector)} (no idle animation, §12)`, a.owner);
  for (const a of p.animations?.running ?? [])
    add('motion', 'warn', `running:${a.selector}:${a.name}`, `still animating at rest: ${code(a.name)} on ${code(a.selector)}`, a.owner);

  for (const c of p.charts) {
    if (c.problem)
      add('charts', 'fail', `chart:${c.selector}`, `chart ${code(c.selector)} (${c.size}) has no text equivalent: ${c.problem}`, c.owner);
    for (const m of c.lowContrastMarks)
      add(
        'charts',
        'warn',
        `mark:${c.selector}:${m.token}`,
        `chart ${code(c.selector)}: ${code(m.token)} marks are ${m.ratio}:1 on ${m.background} (needs 3:1)`,
        c.owner,
      );
  }

  const k = p.keyboard;
  if (k) {
    if (k.primary.kind !== 'none' && !k.reached) {
      const what = k.primary.kind === 'primary' ? 'primary action' : 'first control in main';
      add('keyboard', 'fail', 'unreached', `Tab never reached the ${what} ${code(k.primary.label || k.primary.selector || '')} (${k.ended ?? 'stopped'} after ${k.tabs} stops)`);
    }
    for (const s of k.invisible)
      add('keyboard', 'fail', `invisible:${s.selector}`, `no visible focus indicator on ${code(s.selector)}`, s.owner);
    for (const s of k.offscreen)
      add('keyboard', 'warn', `offscreen:${s.selector}`, `focused element is off screen: ${code(s.selector)}`, s.owner);
    if (k.skipLinkWorks === false) add('keyboard', 'fail', 'skip', 'following the skip link does not put focus in its target', 'shell');
  }

  for (const e of new Set(p.consoleErrors)) add('console', 'fail', `console:${e.slice(0, 80)}`, `console error: ${code(e.slice(0, 300))}`);
  for (const r of new Set(p.failedRequests)) add('requests', 'fail', `request:${r}`, `failed request: ${code(r)}`);
  return out;
}
