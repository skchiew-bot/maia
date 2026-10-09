import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AliveIndicator } from '../src/components/liveness';
import { stubReducedMotion } from './helpers';

function state(container: HTMLElement) {
  const root = container.querySelector('.aoc-alive') as HTMLElement;
  return { pulsing: root.dataset.pulsing === 'true', ring: root.querySelector('.aoc-alive__pulse') };
}

describe('AliveIndicator', () => {
  let restore: (() => void) | undefined;
  afterEach(() => {
    restore?.();
    restore = undefined;
    vi.useRealTimers();
  });

  it('is a static dot until activity happens', () => {
    const { container } = render(<AliveIndicator activitySeq={41} />);
    expect(container.querySelector('.aoc-alive__dot')).not.toBeNull();
    expect(state(container)).toEqual({ pulsing: false, ring: null });
  });

  it('does not pulse when re-rendered with the same activitySeq', () => {
    const { container, rerender } = render(<AliveIndicator activitySeq={41} />);
    rerender(<AliveIndicator activitySeq={41} state="working" />);
    rerender(<AliveIndicator activitySeq={41} state="stalled" />);
    expect(state(container).pulsing).toBe(false);
  });

  it('plays exactly one pulse when activitySeq changes, then returns to static', () => {
    const { container, rerender } = render(<AliveIndicator activitySeq={41} />);
    rerender(<AliveIndicator activitySeq={42} />);
    const s = state(container);
    expect(s.pulsing).toBe(true);
    expect(s.ring).not.toBeNull();
    fireEvent.animationEnd(s.ring as Element);
    expect(state(container)).toEqual({ pulsing: false, ring: null });
  });

  it('clears the pulse on a timer even if animationend never fires (no lingering pulse)', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<AliveIndicator activitySeq={1} />);
    rerender(<AliveIndicator activitySeq={2} />);
    expect(state(container).pulsing).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(state(container).pulsing).toBe(false);
  });

  it('restarts the single pulse for each new event', () => {
    const { container, rerender } = render(<AliveIndicator activitySeq={1} />);
    rerender(<AliveIndicator activitySeq={2} />);
    const first = state(container).ring;
    rerender(<AliveIndicator activitySeq={3} />);
    const second = state(container).ring;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });

  it('never pulses under prefers-reduced-motion', () => {
    restore = stubReducedMotion(true);
    const { container, rerender } = render(<AliveIndicator activitySeq={1} />);
    rerender(<AliveIndicator activitySeq={2} />);
    rerender(<AliveIndicator activitySeq={3} />);
    expect(state(container)).toEqual({ pulsing: false, ring: null });
  });

  it('exposes its label to assistive tech without announcing pulses', () => {
    const { getByText, container } = render(<AliveIndicator activitySeq={1} label="Last activity 12s ago" />);
    expect(getByText('Last activity 12s ago')).toHaveClass('aoc-sr-only');
    expect(container.querySelector('[aria-live]')).toBeNull();
  });
});

describe('no idle animation (§12)', () => {
  it('declares no infinite animation anywhere in the stylesheets', () => {
    const root = resolve(__dirname, '../src');
    const cssFiles: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.css')) cssFiles.push(p);
      }
    };
    walk(root);
    expect(cssFiles.length).toBeGreaterThan(5);
    for (const f of cssFiles) {
      const css = readFileSync(f, 'utf8');
      expect(css, f).not.toMatch(/\binfinite\b/);
      for (const m of css.matchAll(/animation-iteration-count:\s*([^;!]+)/g))
        expect(m[1]!.trim(), f).toBe('1');
    }
  });
});
