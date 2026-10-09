import type { ReactNode } from 'react';

/**
 * Glyphs the Control Tower needs that the shared icon set does not have, drawn on the same 16px grid with
 * 1.5px strokes. Shapes follow the approved mock's legend: severity is an octagon (critical), triangle (high),
 * minus-circle (medium) or ring (low); anomaly "watch" is a half-filled circle.
 */
export type TowerIconName = 'sev-critical' | 'sev-high' | 'sev-medium' | 'sev-low' | 'watch' | 'nudge';

const dot = (cx: number, cy: number, r = 0.85) => <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />;

const PATHS: Record<TowerIconName, ReactNode> = {
  'sev-critical': (
    <>
      <path d="M5.4 1.9h5.2l3.5 3.5v5.2l-3.5 3.5H5.4l-3.5-3.5V5.4z" />
      <path d="M8 4.9v3.6" />
      {dot(8, 10.9)}
    </>
  ),
  'sev-high': (
    <>
      <path d="M7.13 2.75a1 1 0 0 1 1.74 0l5.2 9.25a1 1 0 0 1-.87 1.5H2.8a1 1 0 0 1-.87-1.5z" />
      <path d="M8 6.5v2.75" />
      {dot(8, 11.1, 0.8)}
    </>
  ),
  'sev-medium': (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.25 8h5.5" />
    </>
  ),
  'sev-low': <circle cx="8" cy="8" r="4.75" />,
  watch: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2v12a6 6 0 0 0 0-12z" fill="currentColor" stroke="none" />
    </>
  ),
  nudge: <path d="M2.5 3.25h11v7.5H7l-3.25 2.5v-2.5H2.5z" />,
};

export function TowerIcon({ name, size = 14, className }: { name: TowerIconName; size?: number; className?: string }) {
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
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {PATHS[name]}
    </svg>
  );
}
