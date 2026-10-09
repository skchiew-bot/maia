import type { StepOf } from './scenario-schema';

export type RateLimitType = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet';

export interface RateLimitNotice {
  /** Reset time, unix epoch seconds (whole minutes). */
  resetsAt: number;
  rateLimitType: RateLimitType;
  /** The message the session ends with, in the form the step selected. */
  text: string;
}

const LIMITS = {
  session: { type: 'five_hour', name: 'session limit', classic: '5-hour limit reached' },
  weekly: { type: 'seven_day', name: 'weekly limit', classic: 'Weekly limit reached' },
  opus: { type: 'seven_day_opus', name: 'Opus limit', classic: 'Opus weekly limit reached' },
  sonnet: { type: 'seven_day_sonnet', name: 'Sonnet limit', classic: 'Sonnet weekly limit reached' },
} as const;

/** `timeZone` when the runtime knows it, else the system zone. */
export function effectiveTimeZone(timeZone?: string): string {
  if (timeZone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
      return timeZone;
    } catch {
      // unknown zone: fall back to the system one
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function parts(date: Date, timeZone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  return Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
}

/** "3pm", "3:30pm", or "Oct 9, 3pm" when the reset falls on another calendar day in `timeZone`. */
export function formatResetTime(resetMs: number, nowMs: number, timeZone: string): string {
  const reset = new Date(resetMs);
  const time = parts(reset, timeZone, { hour: 'numeric', minute: '2-digit', hour12: true });
  const clock = `${time.hour}${time.minute === '00' ? '' : `:${time.minute}`}${(time.dayPeriod ?? '').toLowerCase()}`;
  const day = (date: Date) => {
    const p = parts(date, timeZone, { year: 'numeric', month: 'short', day: 'numeric' });
    return { key: `${p.year}-${p.month}-${p.day}`, label: `${p.month} ${p.day}` };
  };
  const resetDay = day(reset);
  return resetDay.key === day(new Date(nowMs)).key ? clock : `${resetDay.label}, ${clock}`;
}

/**
 * Claude Code 2.1.x prints `You've hit your session limit · resets 3pm (Asia/Kuala_Lumpur)`. Older
 * releases printed `Claude AI usage limit reached|<epoch seconds>` (form "legacy") and later
 * `5-hour limit reached ∙ resets 3pm` (form "classic"); both stay available for parser tests.
 */
export function rateLimitNotice(
  step: StepOf<'rateLimit'>,
  nowMs: number,
  timeZone?: string,
): RateLimitNotice {
  const limit = LIMITS[step.limit ?? 'session'];
  const zone = effectiveTimeZone(timeZone);
  const resetsAt = Math.ceil((nowMs + step.resetsInMinutes * 60_000) / 60_000) * 60;
  const when = formatResetTime(resetsAt * 1000, nowMs, zone);
  const form = step.form ?? 'current';
  const text =
    form === 'legacy'
      ? `Claude AI usage limit reached|${resetsAt}`
      : form === 'classic'
        ? `${limit.classic} ∙ resets ${when}`
        : `You've hit your ${limit.name} · resets ${when} (${zone})`;
  return { resetsAt, rateLimitType: limit.type, text };
}
