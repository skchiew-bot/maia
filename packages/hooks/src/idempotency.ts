import { createHash } from 'node:crypto';

export interface HookKeyParts {
  aocSessionId: string | null;
  claudeSessionId: string;
  event: string;
  toolUseId?: string | null;
  agentId?: string | null;
  sentAt: string;
  pid: number;
}

/**
 * sha256(session + event + tool_use_id | timestamp). Tool events key on tool_use_id so a duplicate invocation of the
 * same check (e.g. the hook registered twice) collapses at the daemon; other events key on the send time, with the
 * subagent id and pid so parallel SubagentStops in the same millisecond stay distinct. The key is computed once and
 * travels inside a spooled body, so replays reuse it.
 */
export function hookIdempotencyKey(p: HookKeyParts): string {
  const discriminator = p.toolUseId ? `tool:${p.toolUseId}` : `at:${p.sentAt}:${p.agentId ?? ''}:${p.pid}`;
  return sha256([p.aocSessionId ?? '', p.claudeSessionId, p.event, discriminator].join('\n'));
}

/** Content-addressed: the same set of assistant messages always yields the same key, whatever byte range carried it. */
export function usageIdempotencyKey(
  claudeSessionId: string,
  agentId: string | null,
  messageIds: readonly string[],
): string {
  return sha256(['usage', claudeSessionId, agentId ?? '', ...messageIds].join('\n'));
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
