import type { ReactNode } from 'react';
import type { PhaseState } from './model';

/**
 * Glyphs the shared icon set does not have (16px grid, 1.5px strokes, currentColor), matching the mock's
 * legend: ⚑ pinned tag / flagged close, ▼ drift, and the phase/task status circles.
 */
function Glyph({
  children,
  size = 14,
  className,
}: {
  children: ReactNode;
  size?: number;
  className?: string;
}) {
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
    >
      {children}
    </svg>
  );
}

export function FlagGlyph({ size, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path d="M4 14V2.5M4 3h7.5l-1.75 2.75L11.5 8.5H4" />
    </Glyph>
  );
}

export function DriftGlyph({ size, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <path d="M2.75 4h10.5L8 12.5z" fill="currentColor" />
    </Glyph>
  );
}

export function ScopeGlyph({ size, className }: { size?: number; className?: string }) {
  return (
    <Glyph size={size} className={className}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5.25v5.5M5.25 8h5.5" />
    </Glyph>
  );
}

export type TaskStatusGlyph = PhaseState | 'removed';

export function StatusGlyph({ state, size }: { state: TaskStatusGlyph; size?: number }) {
  return (
    <Glyph size={size} className={`prj-status__icon prj-status__icon--${state}`}>
      <circle cx="8" cy="8" r="6" />
      {state === 'done' && <path d="M5.25 8.25l1.9 1.9 3.6-3.9" />}
      {state === 'active' && <path d="M8 2v12a6 6 0 0 0 0-12z" fill="currentColor" stroke="none" />}
      {state === 'removed' && <path d="M3.9 12.1l8.2-8.2" />}
    </Glyph>
  );
}
