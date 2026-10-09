import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Button, RankedList, SEVERITY_META, type RankedItem } from '../src/components';

const NOW = Date.UTC(2026, 9, 8, 6, 5);
const ITEMS: RankedItem[] = [
  {
    id: 'a',
    severity: 'high',
    title: 'Fix-plan sign-off',
    href: '/decisions/1',
    meta: 'Billing revamp · decision',
    since: NOW - (2 * 60 + 14) * 60_000,
    score: 88,
    action: <Button size="sm">Review</Button>,
  },
  { id: 'b', severity: 'critical', title: 'Session is dead', since: NOW - 4 * 60_000, score: 94 },
  { id: 'c', severity: 'low', title: 'Lesson awaits approval', score: 22 },
];

function rows() {
  return within(screen.getByRole('list', { name: 'Needs attention' })).getAllByRole('listitem');
}

describe('RankedList', () => {
  it('renders each attention row: rank, severity word, title link, meta, age, score as text, action', () => {
    render(
      <MemoryRouter>
        <RankedList items={ITEMS} label="Needs attention" scoreLabel="Attention score" now={NOW} />
      </MemoryRouter>,
    );
    const [first] = rows();
    expect(first).toHaveAttribute('data-severity', 'high');
    expect(first).toHaveTextContent('1');
    expect(within(first!).getByText('High:')).toHaveClass('aoc-sr-only');
    expect(within(first!).getByRole('link', { name: 'Fix-plan sign-off' })).toHaveAttribute(
      'href',
      '/decisions/1',
    );
    expect(within(first!).getByText('Billing revamp · decision')).toBeInTheDocument();
    expect(within(first!).getByText('2h 14m')).toBeInTheDocument();
    expect(within(first!).getByText('88').parentElement).toHaveTextContent('Attention score 88');
    expect(within(first!).getByRole('button', { name: 'Review' })).toBeInTheDocument();
    // the score bar is decorative; the number is the value
    expect(first!.querySelector('.aoc-ranked__bar')).toHaveAttribute('aria-hidden', 'true');
    expect((first!.querySelector('.aoc-ranked__fill') as HTMLElement).style.width).toBe('88%');
  });

  it('keeps the given ranking by default and can sort by score', () => {
    const { rerender } = render(
      <MemoryRouter>
        <RankedList items={ITEMS} label="Needs attention" now={NOW} />
      </MemoryRouter>,
    );
    expect(rows().map((r) => r.dataset.severity)).toEqual(['high', 'critical', 'low']);
    rerender(
      <MemoryRouter>
        <RankedList items={ITEMS} label="Needs attention" now={NOW} order="score" />
      </MemoryRouter>,
    );
    expect(rows().map((r) => r.dataset.severity)).toEqual(['critical', 'high', 'low']);
  });

  it('pairs every severity with a distinct icon and word, not colour alone', () => {
    const icons = Object.values(SEVERITY_META).map((m) => m.icon);
    expect(new Set(icons).size).toBe(icons.length);
    render(
      <MemoryRouter>
        <RankedList items={ITEMS} label="Needs attention" now={NOW} />
      </MemoryRouter>,
    );
    for (const r of rows()) {
      const sev = r.dataset.severity as keyof typeof SEVERITY_META;
      expect(r.querySelector('.aoc-ranked__sev svg')).toHaveAttribute('data-icon', SEVERITY_META[sev].icon);
      expect(r).toHaveTextContent(`${SEVERITY_META[sev].word}:`);
    }
  });

  it('renders the empty slot when nothing needs attention', () => {
    render(
      <MemoryRouter>
        <RankedList items={[]} label="Needs attention" empty={<p>All clear</p>} />
      </MemoryRouter>,
    );
    expect(screen.getByText('All clear')).toBeInTheDocument();
    expect(screen.queryByRole('list')).toBeNull();
  });
});
