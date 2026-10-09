import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { cx, prefersReducedMotion } from '../../lib/dom';
import { LIVENESS_META, livenessColors, type LivenessState } from './liveness';

/** Upper bound for one pulse; clears the pulse even if `animationend` never fires (hidden tab, no CSS). */
const PULSE_MS = 900;

export interface AliveIndicatorProps {
  /**
   * Activity counter for the thing being watched — e.g. the seq of the latest event for this session. Each
   * change plays exactly one pulse. The first value seen does not pulse; an unchanged value never does.
   */
  activitySeq: number | string | null | undefined;
  /** Dot colour follows the session's liveness. Default `working`. */
  state?: LivenessState;
  /** Visually hidden text, e.g. "Last activity 12s ago". */
  label?: string;
  className?: string;
}

/**
 * A static dot that pulses once per real activity event (§12: "pulse on activity only, never a steady
 * pulse a stalled session would also show"). Under reduced motion it never pulses.
 */
export function AliveIndicator({ activitySeq, state = 'working', label, className }: AliveIndicatorProps) {
  const previous = useRef(activitySeq);
  const [pulse, setPulse] = useState(0);
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    if (Object.is(previous.current, activitySeq)) return undefined;
    previous.current = activitySeq;
    if (activitySeq === null || activitySeq === undefined || prefersReducedMotion()) return undefined;
    setPulse((n) => n + 1);
    setPulsing(true);
    const timer = setTimeout(() => setPulsing(false), PULSE_MS);
    return () => clearTimeout(timer);
  }, [activitySeq]);

  const colors = livenessColors(LIVENESS_META[state].tone);
  return (
    <span
      className={cx('aoc-alive', className)}
      data-pulsing={pulsing ? 'true' : 'false'}
      data-state={state}
      style={{ '--alive-color': colors.fg } as CSSProperties}
    >
      <span className="aoc-alive__dot" aria-hidden="true" />
      {pulsing && (
        <span
          key={pulse}
          className="aoc-alive__pulse"
          aria-hidden="true"
          onAnimationEnd={() => setPulsing(false)}
        />
      )}
      {label && <span className="aoc-sr-only">{label}</span>}
    </span>
  );
}
