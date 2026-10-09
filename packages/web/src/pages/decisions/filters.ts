import type { DecisionCardView, DecisionKind } from '@aoc/contracts';
import { KIND_LABEL, agingOf, type AgingState } from './model';

export type DecisionsTab = 'open' | 'resolved';

/** Filter state carried in the URL so every view (and every KPI link) is shareable. */
export interface DecisionFilters {
  tab: DecisionsTab;
  kinds: ReadonlySet<DecisionKind>;
  /** Only cards in this SLA state (open tab). */
  aging: Extract<AgingState, 'over' | 'due_soon'> | null;
  /** Only passkey-gated cards. */
  passkey: boolean;
  /** Only cards the viewer can resolve now. */
  mine: boolean;
  /** Selected decision (deep links from the Control Tower use `?focus=<decisionId>`). */
  focus: string | null;
}

const isKind = (v: string): v is DecisionKind => Object.prototype.hasOwnProperty.call(KIND_LABEL, v);

export function parseFilters(params: URLSearchParams): DecisionFilters {
  const aging = params.get('aging');
  return {
    tab: params.get('tab') === 'resolved' ? 'resolved' : 'open',
    kinds: new Set((params.get('kind') ?? '').split(',').filter(isKind)),
    aging: aging === 'over' || aging === 'due_soon' ? aging : null,
    passkey: params.get('passkey') === '1',
    mine: params.get('scope') === 'mine',
    focus: params.get('focus') || null,
  };
}

/** Query string for a filter state; defaults are omitted so plain `/decisions` stays plain. */
export function filtersToParams(f: DecisionFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.tab === 'resolved') p.set('tab', 'resolved');
  if (f.kinds.size) p.set('kind', [...f.kinds].sort().join(','));
  if (f.aging) p.set('aging', f.aging);
  if (f.passkey) p.set('passkey', '1');
  if (f.mine) p.set('scope', 'mine');
  if (f.focus) p.set('focus', f.focus);
  return p;
}

/** Applies the filters that narrow the list (not the tab or the selection). */
export function applyFilters(
  cards: readonly DecisionCardView[],
  f: DecisionFilters,
  now: number,
): DecisionCardView[] {
  return cards.filter(
    (c) =>
      (!f.kinds.size || f.kinds.has(c.kind)) &&
      (!f.passkey || c.requiresPasskey) &&
      (!f.mine || c.viewer.canResolve) &&
      (!f.aging || (c.status === 'open' && agingOf(c, now).state === f.aging)),
  );
}

/** Open cards per kind, for the filter chips (kinds with none are left out). */
export function countByKind(cards: readonly DecisionCardView[]): [DecisionKind, number][] {
  const counts = new Map<DecisionKind, number>();
  for (const c of cards) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || KIND_LABEL[a[0]].localeCompare(KIND_LABEL[b[0]]));
}

export function hasNarrowing(f: DecisionFilters): boolean {
  return f.kinds.size > 0 || f.aging !== null || f.passkey || f.mine;
}
