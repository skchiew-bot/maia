/** `aoc run --follow`: poll the session and its rendered output until it waits on a human or ends. */
import type { SessionDetail, SessionOutputItem } from '@aoc/contracts';
import { listOf, objectOf, type CommandContext } from './context';
import { EXIT } from './errors';
import { livenessBadge, oneLine, sanitize, truncate } from './format';
import { ApiError, type Api } from './http';
import { API_PATHS } from './paths';

export const FOLLOW_INTERVAL_MS = 2000;
const MAX_CONSECUTIVE_NETWORK_FAILURES = 3;

export interface FollowEnd {
  outcome: 'ended' | 'retired' | 'failed' | 'waiting_on_you' | 'throttled' | 'dead';
  exitCode: number;
  message: string;
}

export function renderOutputItem(it: SessionOutputItem): string {
  const text = sanitize(it.text ?? '').trimEnd();
  switch (it.kind) {
    case 'assistant_text':
      return text;
    case 'tool_use':
      return `  → ${oneLine(it.toolName ?? 'tool')} ${truncate(oneLine(text), 120)}`.trimEnd();
    case 'tool_result':
      return `  ← ${truncate(oneLine(text), 120)}`;
    case 'user_prompt':
      return `› ${text}`;
    case 'system':
      return `· ${oneLine(text)}`;
    case 'result':
      return `= ${text}`;
    default:
      return text;
  }
}

/** When to stop following: the session waits on a human, is throttled, died, or ended. */
export function followEnd(s: SessionDetail): FollowEnd | null {
  const id = s.sessionId;
  const state = s.liveness?.state ?? null;
  if (s.lifecycle === 'ended')
    return { outcome: 'ended', exitCode: EXIT.OK, message: `Session ${id} ended.` };
  if (s.lifecycle === 'retired') {
    const next = s.successorSessionId ? ` → continued in ${s.successorSessionId}` : '';
    return { outcome: 'retired', exitCode: EXIT.OK, message: `Session ${id} rolled over${next}.` };
  }
  if (s.lifecycle === 'failed')
    return {
      outcome: 'failed',
      exitCode: EXIT.ERROR,
      message: `Session ${id} failed. Restart it with: aoc restart ${id}`,
    };
  if (state === 'waiting_on_you')
    return { outcome: 'waiting_on_you', exitCode: EXIT.OK, message: waitingHint(s) };
  if (state === 'throttled') {
    const until = s.throttledUntil ? ` until ${s.throttledUntil}` : '';
    return {
      outcome: 'throttled',
      exitCode: EXIT.OK,
      message: `Throttled by the plan limit${until}; the supervisor resumes it automatically.`,
    };
  }
  if (state === 'dead') {
    return {
      outcome: 'dead',
      exitCode: EXIT.ERROR,
      message: `Session ${id} is dead (${oneLine(s.liveness?.reason)}). Restart it with: aoc restart ${id}`,
    };
  }
  return null;
}

function waitingHint(s: SessionDetail): string {
  const id = s.sessionId;
  if (s.openDecision) {
    const d = s.openDecision;
    return `Waiting on you: decision ${d.decisionId} (${oneLine(d.kind)}). Review with \`aoc decisions\`, answer with \`aoc decide ${d.decisionId} --option <optionId>\`.`;
  }
  if (s.lifecycle === 'idle')
    return `Waiting on you: the turn ended with work left. Continue with \`aoc prompt ${id} "<text>"\`.`;
  if (s.lifecycle === 'blocked')
    return `Waiting on you: session ${id} is blocked (${oneLine(s.liveness?.reason)}). See \`aoc session ${id}\`.`;
  return `Waiting on you (${oneLine(s.liveness?.reason)}). See \`aoc session ${id}\`.`;
}

function itemKey(it: SessionOutputItem): string {
  return JSON.stringify([it.at, it.kind, it.toolName ?? null, it.text]);
}

export async function followSession(
  ctx: CommandContext,
  api: Api,
  sessionId: string,
  o: { json: boolean; intervalMs?: number },
): Promise<number> {
  const emit = (event: Record<string, unknown>, human: string | null) => {
    if (o.json) ctx.print(JSON.stringify(event));
    else if (human !== null) ctx.print(human);
  };
  let lastKey: string | null = null;
  let lastState: string | null = null;
  let failures = 0;
  for (;;) {
    let detail: SessionDetail;
    let items: SessionOutputItem[];
    try {
      // Detail before output: once detail says "ended", the output fetched after it is complete.
      detail = objectOf<SessionDetail>(await api.get(API_PATHS.session(sessionId)), 'session', 'session');
      items = listOf<SessionOutputItem>(
        await api.get(API_PATHS.sessionOutput(sessionId)),
        'session output',
        'items',
        'output',
      );
      failures = 0;
    } catch (err) {
      if (err instanceof ApiError && err.status === null && ++failures < MAX_CONSECUTIVE_NETWORK_FAILURES) {
        ctx.warn(`warning: ${err.message}; retrying`);
        await ctx.deps.sleep(o.intervalMs ?? FOLLOW_INTERVAL_MS);
        continue;
      }
      throw err;
    }

    const seenAt = lastKey === null ? -1 : items.map(itemKey).lastIndexOf(lastKey);
    for (const it of items.slice(seenAt + 1)) emit({ event: 'output', item: it }, renderOutputItem(it));
    if (items.length > 0) lastKey = itemKey(items[items.length - 1]!);

    const state = detail.liveness?.state ?? null;
    const stateKey = `${detail.lifecycle}|${state}`;
    if (stateKey !== lastState) {
      lastState = stateKey;
      const reason = detail.liveness?.reason ? ` (${oneLine(detail.liveness.reason)})` : '';
      emit(
        {
          event: 'state',
          lifecycle: detail.lifecycle,
          liveness: state,
          reason: detail.liveness?.reason ?? null,
        },
        `── ${livenessBadge(state, detail.lifecycle)}${reason}`,
      );
    }

    const end = followEnd(detail);
    if (end) {
      emit({ event: 'end', ...end }, end.message);
      return end.exitCode;
    }
    await ctx.deps.sleep(o.intervalMs ?? FOLLOW_INTERVAL_MS);
  }
}
