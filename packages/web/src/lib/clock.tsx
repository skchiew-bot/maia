import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/** Injected time source (CLAUDE.md: never read the wall clock directly where tests need determinism). */
export interface Clock {
  now(): number;
  /** A fixed clock never ticks; `useNow` returns its instant without scheduling timers. */
  readonly fixed?: boolean;
}

export const systemClock: Clock = { now: () => Date.now() };

/** A clock frozen at `at` — for tests, the gallery and screenshot runs. */
export function fixedClock(at: number): Clock {
  return { now: () => at, fixed: true };
}

const ClockContext = createContext<Clock>(systemClock);

/** Overrides the clock for a subtree. */
export function ClockProvider({ clock, children }: { clock: Clock; children: ReactNode }) {
  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>;
}

export function useClock(): Clock {
  return useContext(ClockContext);
}

/**
 * Current time, re-read on `resolutionMs` boundaries (default: once a minute). Only text such as ages should
 * use this — chart marks move on events, never on a timer (§12).
 */
export function useNow(resolutionMs = 60_000): number {
  const clock = useClock();
  const [now, setNow] = useState(() => clock.now());

  useEffect(() => {
    setNow(clock.now());
    if (clock.fixed) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      const t = clock.now();
      timer = setTimeout(
        () => {
          setNow(clock.now());
          schedule();
        },
        resolutionMs - (t % resolutionMs) + 5,
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, [clock, resolutionMs]);

  return now;
}
