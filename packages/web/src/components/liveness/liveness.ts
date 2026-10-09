import type { IconName } from '../Icon';

/**
 * Session liveness as derived by the daemon from instrumented events (§4) — the UI never infers it.
 * `ended` and `retired` are terminal, neutral states (retired = superseded by a context rollover, §5).
 */
export type LivenessState =
  'working' | 'thinking' | 'stalled' | 'dead' | 'throttled' | 'waiting_on_you' | 'ended' | 'retired';

export const LIVENESS_STATES: readonly LivenessState[] = [
  'working',
  'thinking',
  'stalled',
  'dead',
  'throttled',
  'waiting_on_you',
  'ended',
  'retired',
];

/** §4 precedence, highest first: Waiting on you > Throttled > Dead > Stalled > Thinking > Working. */
export const LIVENESS_PRECEDENCE: readonly LivenessState[] = [
  'waiting_on_you',
  'throttled',
  'dead',
  'stalled',
  'thinking',
  'working',
];

/** Colour family; maps to `--live-<tone>` / `--live-<tone>-soft`. Thinking is deliberately neutral grey. */
export type LivenessTone = 'working' | 'thinking' | 'stalled' | 'dead' | 'throttled' | 'waiting' | 'neutral';

export interface LivenessMeta {
  /** The word shown in every badge. */
  word: string;
  icon: IconName;
  tone: LivenessTone;
  /** One-line definition (gallery, tooltips, help). */
  description: string;
}

export const LIVENESS_META: Record<LivenessState, LivenessMeta> = {
  working: {
    word: 'Working',
    icon: 'working',
    tone: 'working',
    description: 'Tool calls are flowing.',
  },
  thinking: {
    word: 'Thinking',
    icon: 'thinking',
    tone: 'thinking',
    description: 'The model is generating; the sidecar heartbeat is alive. Normal, not a warning.',
  },
  stalled: {
    word: 'Stalled',
    icon: 'stalled',
    tone: 'stalled',
    description: 'Heartbeat alive but no progress for longer than the stall threshold.',
  },
  dead: {
    word: 'Dead',
    icon: 'dead',
    tone: 'dead',
    description: 'The process or heartbeat is gone. Restart from the supervisor.',
  },
  throttled: {
    word: 'Throttled',
    icon: 'throttled',
    tone: 'throttled',
    description: 'Plan limit hit; resumes automatically at the reset time.',
  },
  waiting_on_you: {
    word: 'Waiting on you',
    icon: 'waiting',
    tone: 'waiting',
    description:
      'A human-required decision is open; the session ended its turn and costs nothing while waiting.',
  },
  ended: {
    word: 'Ended',
    icon: 'ended',
    tone: 'neutral',
    description: 'The session finished.',
  },
  retired: {
    word: 'Retired',
    icon: 'retired',
    tone: 'neutral',
    description: 'Superseded by a fresh session after a context rollover.',
  },
};

/** CSS custom properties a liveness tone paints with (foreground mark colour, soft background). */
export function livenessColors(tone: LivenessTone): { fg: string; bg: string } {
  if (tone === 'neutral') return { fg: 'var(--text-3)', bg: 'var(--surface-2)' };
  return { fg: `var(--live-${tone})`, bg: `var(--live-${tone}-soft)` };
}

/**
 * States in which a session should be producing tool activity, so a flat activity line is a stall signal.
 * Thinking is excluded on purpose: generating without tool calls is normal and must never read as a warning;
 * waiting, throttled, dead and terminal states explain their own flat line.
 */
export function expectsActivity(state: LivenessState): boolean {
  return state === 'working' || state === 'stalled';
}

export function isLivenessState(value: unknown): value is LivenessState {
  return typeof value === 'string' && (LIVENESS_STATES as readonly string[]).includes(value);
}

/**
 * The state that wins when several apply (e.g. a project summarising its sessions), per §4 precedence.
 * Terminal states only win when nothing is live.
 */
export function dominantLiveness(states: Iterable<LivenessState>): LivenessState | undefined {
  let best: LivenessState | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  let terminal: LivenessState | undefined;
  for (const s of states) {
    const rank = LIVENESS_PRECEDENCE.indexOf(s);
    if (rank === -1) {
      terminal ??= s;
      continue;
    }
    if (rank < bestRank) {
      best = s;
      bestRank = rank;
    }
  }
  return best ?? terminal;
}
