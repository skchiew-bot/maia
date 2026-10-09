import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  LIVENESS_META,
  LIVENESS_PRECEDENCE,
  LIVENESS_STATES,
  LivenessBadge,
  dominantLiveness,
  expectsActivity,
} from '../src/components/liveness';

const AMBER_TOKENS = ['--live-stalled', '--mark-drift', '--warn'];

describe('LivenessBadge', () => {
  it.each(LIVENESS_STATES)('renders %s as colour + icon + word', (state) => {
    const meta = LIVENESS_META[state];
    const { container } = render(<LivenessBadge state={state} />);
    const badge = container.querySelector('.aoc-liveness') as HTMLElement;
    expect(badge).toHaveAttribute('data-state', state);
    // word
    expect(screen.getByText(meta.word)).toBeInTheDocument();
    // icon: decorative SVG, specific to the state
    const icon = badge.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveAttribute('data-icon', meta.icon);
    // colour comes from the liveness token family (or neutral for terminal states)
    const fg = badge.style.getPropertyValue('--lv-fg');
    expect(fg).toBe(meta.tone === 'neutral' ? 'var(--text-3)' : `var(--live-${meta.tone})`);
    // the accessible text is the word (no colour-only meaning)
    expect(badge).toHaveTextContent(meta.word);
  });

  it('gives every live state its own icon and word', () => {
    const icons = LIVENESS_PRECEDENCE.map((s) => LIVENESS_META[s].icon);
    const words = LIVENESS_PRECEDENCE.map((s) => LIVENESS_META[s].word);
    expect(new Set(icons).size).toBe(icons.length);
    expect(new Set(words).size).toBe(words.length);
  });

  it('keeps Thinking neutral — never the stalled/amber token', () => {
    const { container } = render(<LivenessBadge state="thinking" />);
    const badge = container.querySelector('.aoc-liveness') as HTMLElement;
    const style = badge.getAttribute('style') ?? '';
    expect(style).toContain('var(--live-thinking)');
    for (const amber of AMBER_TOKENS) expect(style).not.toContain(amber);
    expect(LIVENESS_META.thinking.tone).toBe('thinking');
    expect(LIVENESS_META.thinking.icon).not.toBe(LIVENESS_META.stalled.icon);
  });

  it('defines --live-thinking as a low-saturation grey in both themes', () => {
    const css = readFileSync(resolve(__dirname, '../src/design/tokens.css'), 'utf8');
    const values = [...css.matchAll(/--live-thinking:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]!);
    expect(values).toHaveLength(2);
    for (const hex of values) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
        number,
        number,
        number,
      ];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
      expect(saturation).toBeLessThan(0.3);
    }
    const stalled = [...css.matchAll(/--live-stalled:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]);
    expect(values).not.toEqual(stalled);
  });

  it('renders detail text after the word with a spoken separator', () => {
    render(<LivenessBadge state="throttled" detail="resets 14:05" />);
    expect(screen.getByText('Throttled')).toBeInTheDocument();
    expect(screen.getByText('resets 14:05')).toBeInTheDocument();
    expect(screen.getByText('Throttled').parentElement).toHaveTextContent('Throttled, resets 14:05');
  });

  it('announces changes only when asked (no live regions in lists)', () => {
    const { rerender } = render(<LivenessBadge state="working" />);
    expect(screen.queryByRole('status')).toBeNull();
    rerender(<LivenessBadge state="working" announce />);
    expect(screen.getByRole('status')).toHaveTextContent('Working');
  });
});

describe('liveness precedence (§4)', () => {
  it('orders Waiting on you > Throttled > Dead > Stalled > Thinking > Working', () => {
    expect(LIVENESS_PRECEDENCE).toEqual([
      'waiting_on_you',
      'throttled',
      'dead',
      'stalled',
      'thinking',
      'working',
    ]);
  });

  it('picks the dominant state', () => {
    expect(dominantLiveness(['working', 'thinking', 'waiting_on_you', 'stalled'])).toBe('waiting_on_you');
    expect(dominantLiveness(['working', 'dead', 'stalled'])).toBe('dead');
    expect(dominantLiveness(['thinking', 'working'])).toBe('thinking');
    expect(dominantLiveness(['ended', 'working'])).toBe('working');
    expect(dominantLiveness(['ended', 'retired'])).toBe('ended');
    expect(dominantLiveness([])).toBeUndefined();
  });

  it('expects activity only while working or stalled (thinking is not a warning)', () => {
    expect(LIVENESS_STATES.filter(expectsActivity)).toEqual(['working', 'stalled']);
  });
});
