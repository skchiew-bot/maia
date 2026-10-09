import type { StreamMessage } from '../../api/stream';

/**
 * True for committed events whose type equals one of `types`, or starts with an entry ending in `.`
 * (`'playbook.'` matches every playbook event). Shared by the FinOps pages' `refreshOn` predicates.
 */
export function isEvent(m: StreamMessage, types: readonly string[]): boolean {
  if (m.kind !== 'aoc') return false;
  const t = m.event.type;
  return types.some((p) => (p.endsWith('.') ? t.startsWith(p) : t === p));
}
