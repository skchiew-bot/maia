import type { ReactNode } from 'react';

/**
 * Glyphs from the approved mock's icon set that the shared Icon set does not carry (operator actions, the
 * manifest's task states, the recommendation star). Same 16px grid, stroke and `currentColor` as Icon.
 */
export type GlyphName =
  | 'message'
  | 'stop'
  | 'rollover'
  | 'restart'
  | 'lock'
  | 'flag'
  | 'star'
  | 'shield'
  | 'circle'
  | 'half-circle'
  | 'check-circle'
  | 'plus-circle';

const PATHS: Record<GlyphName, ReactNode> = {
  message: <path d="M2.25 3h11.5v8H7l-3.25 2.5V11h-1.5z" />,
  stop: <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" />,
  rollover: <path d="M2 8h8.25M7.5 5.25L10.25 8 7.5 10.75M13.25 3v10" />,
  restart: <path d="M13 3v3.75H9.25M12.6 6.5A5 5 0 1 0 13 9.5" />,
  lock: (
    <>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.25" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  flag: <path d="M4 14V2.5M4 3h8.25l-1.75 3 1.75 3H4" />,
  star: <path d="M8 2l1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3l-3.7 2 .8-4.1L2 6.3l4.2-.5z" />,
  shield: <path d="M8 1.75l5 2v4.1c0 3-2.15 5.25-5 6.15-2.85-.9-5-3.15-5-6.15v-4.1zM5.75 8.1l1.5 1.5 3-3" />,
  circle: <circle cx="8" cy="8" r="5.75" />,
  'half-circle': (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 2.25v11.5a5.75 5.75 0 0 0 0-11.5z" fill="currentColor" stroke="none" />
    </>
  ),
  'check-circle': (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M5.4 8.2l1.8 1.8 3.4-3.6" />
    </>
  ),
  'plus-circle': (
    <>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 5.25v5.5M5.25 8h5.5" />
    </>
  ),
};

export interface GlyphProps {
  name: GlyphName;
  /** Default 16. */
  size?: number;
  /** Accessible label; omitted = decorative. */
  title?: string;
  className?: string;
}

export function Glyph({ name, size = 16, title, className }: GlyphProps) {
  const a11y = title
    ? ({ role: 'img', 'aria-label': title } as const)
    : ({ 'aria-hidden': true, focusable: 'false' } as const);
  return (
    <svg
      className={className ? `aoc-icon ${className}` : 'aoc-icon'}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      data-glyph={name}
      {...a11y}
    >
      {PATHS[name]}
    </svg>
  );
}
