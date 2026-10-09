import { useState } from 'react';
import { useEventStream } from '../../api/stream';

/** Events that mean a session did something (tool calls, model output, plan work). Heartbeats never count. */
export const ACTIVITY_EVENT_TYPES: ReadonlySet<string> = new Set([
  'tool.used',
  'tool.denied',
  'usage.recorded',
  'task.done',
  'plan.declared',
  'plan.amended',
  'prompt.submitted',
]);

/**
 * Latest activity event seq per session, from the live stream. Each change plays exactly one pulse on that
 * session's alive indicator (§12: pulse on activity only, never a steady pulse).
 */
export function useActivitySeqs(): ReadonlyMap<string, number> {
  const [seqs, setSeqs] = useState<ReadonlyMap<string, number>>(() => new Map());
  useEventStream((msg) => {
    if (msg.kind !== 'aoc' || !ACTIVITY_EVENT_TYPES.has(msg.event.type)) return;
    const sessionId = msg.event.scope.sessionId;
    if (!sessionId) return;
    setSeqs((prev) => {
      if ((prev.get(sessionId) ?? 0) >= msg.event.seq) return prev;
      const next = new Map(prev);
      next.set(sessionId, msg.event.seq);
      return next;
    });
  });
  return seqs;
}
