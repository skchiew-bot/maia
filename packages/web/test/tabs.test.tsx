import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl, Tabs, type TabItem } from '../src/components';

const ITEMS: TabItem[] = [
  { id: 'overview', label: 'Overview', content: <p>Overview panel</p> },
  { id: 'tasks', label: 'Tasks', count: 14, content: <p>Tasks panel</p> },
  { id: 'transcript', label: 'Transcript', disabled: true, content: <p>Transcript panel</p> },
  { id: 'decisions', label: 'Decisions', content: <p>Decisions panel</p> },
];

function tab(name: string): HTMLElement {
  return screen.getByRole('tab', { name: new RegExp(`^${name}`) });
}

describe('Tabs', () => {
  it('renders a labelled tablist with one tab stop on the selected tab', () => {
    render(<Tabs label="Session views" items={ITEMS} />);
    expect(screen.getByRole('tablist', { name: 'Session views' })).toBeInTheDocument();
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Overview')).toHaveAttribute('tabindex', '0');
    for (const name of ['Tasks', 'Transcript', 'Decisions'])
      expect(tab(name)).toHaveAttribute('tabindex', '-1');
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveTextContent('Overview panel');
    expect(panel).toHaveAttribute('aria-labelledby', tab('Overview').id);
    expect(tab('Overview')).toHaveAttribute('aria-controls', panel.id);
  });

  it('moves and selects with arrow keys, wraps, skips disabled tabs, and supports Home/End', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Tabs label="Session views" items={ITEMS} onChange={onChange} />);
    await user.tab();
    expect(tab('Overview')).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(tab('Tasks')).toHaveFocus();
    expect(tab('Tasks')).toHaveAttribute('aria-selected', 'true');
    expect(tab('Tasks')).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Tasks panel');
    expect(onChange).toHaveBeenLastCalledWith('tasks');

    await user.keyboard('{ArrowRight}'); // skips the disabled Transcript tab
    expect(tab('Decisions')).toHaveFocus();
    await user.keyboard('{ArrowRight}'); // wraps to the first tab
    expect(tab('Overview')).toHaveFocus();
    await user.keyboard('{ArrowLeft}'); // wraps to the last tab
    expect(tab('Decisions')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(tab('Overview')).toHaveFocus();
    await user.keyboard('{End}');
    expect(tab('Decisions')).toHaveFocus();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Decisions panel');
  });

  it('leaves the tablist with Tab into the panel (single tab stop)', async () => {
    const user = userEvent.setup();
    render(<Tabs label="Session views" items={ITEMS} />);
    await user.tab();
    await user.tab();
    expect(screen.getByRole('tabpanel')).toHaveFocus();
  });

  it('in manual mode arrows move focus only and Enter selects', async () => {
    const user = userEvent.setup();
    render(<Tabs label="Session views" items={ITEMS} activation="manual" />);
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(tab('Tasks')).toHaveFocus();
    expect(tab('Overview')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Enter}');
    expect(tab('Tasks')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Tasks panel');
  });

  it('can be controlled', async () => {
    const user = userEvent.setup();
    function Controlled() {
      const [value, setValue] = useState('decisions');
      return (
        <>
          <Tabs label="Views" items={ITEMS} value={value} onChange={setValue} />
          <output>{value}</output>
        </>
      );
    }
    render(<Controlled />);
    expect(tab('Decisions')).toHaveAttribute('aria-selected', 'true');
    await user.click(tab('Tasks'));
    expect(screen.getByRole('status')).toHaveTextContent('tasks');
  });
});

describe('SegmentedControl', () => {
  it('is a radio group with arrow-key selection', async () => {
    const user = userEvent.setup();
    function Range() {
      const [value, setValue] = useState<'today' | '7d' | '30d'>('7d');
      return (
        <SegmentedControl
          label="Time range"
          value={value}
          onChange={setValue}
          options={[
            { value: 'today', label: 'Today' },
            { value: '7d', label: '7 days' },
            { value: '30d', label: '30 days' },
          ]}
        />
      );
    }
    render(<Range />);
    expect(screen.getByRole('radiogroup', { name: 'Time range' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '7 days' })).toHaveAttribute('aria-checked', 'true');
    await user.tab();
    expect(screen.getByRole('radio', { name: '7 days' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: '30 days' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: '30 days' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Today' })).toHaveAttribute('aria-checked', 'true');
  });
});
