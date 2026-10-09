/**
 * Semantic tones. Colour carries meaning only: `ok`/`warn`/`danger`/`info` are reserved for state and always
 * travel with an icon or a word; `accent` marks the interactive/brand emphasis; `neutral` is everything else.
 */
export type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger' | 'info';

/** Tones that describe a state (alerts, toasts). */
export type StatusTone = 'info' | 'ok' | 'warn' | 'danger';

/** Icon paired with each status tone so colour is never the only signal. */
export const STATUS_ICON = {
  info: 'info',
  ok: 'ok',
  warn: 'warn',
  danger: 'danger',
} as const;

/** Word announced to screen readers before status content ("Warning: …"). */
export const STATUS_WORD: Record<StatusTone, string> = {
  info: 'Note',
  ok: 'Done',
  warn: 'Warning',
  danger: 'Error',
};
