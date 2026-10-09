import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from '../src/shell/navItems';
import { SideNav } from '../src/shell/SideNav';

function renderNav(collapsed: boolean) {
  return render(
    <MemoryRouter initialEntries={['/console']}>
      <SideNav items={NAV_ITEMS} collapsed={collapsed} onToggleCollapsed={() => undefined} inboxCount={3} />
    </MemoryRouter>,
  );
}

describe('SideNav structure (axe `list`)', () => {
  it.each([false, true])('keeps only list items inside its lists (collapsed: %s)', (collapsed) => {
    const { container } = renderNav(collapsed);
    const lists = container.querySelectorAll('ul');
    expect(lists.length).toBeGreaterThan(1);
    for (const ul of lists) for (const child of ul.children) expect(child.tagName).toBe('LI');
    expect(container.querySelector('[role="presentation"]')).toBeNull();
  });

  it('names each group list by its visible label', () => {
    renderNav(false);
    const operate = screen.getByRole('list', { name: 'Operate' });
    expect(within(operate).getByRole('link', { name: 'Control Tower' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('list', { name: 'Govern' })).getByRole('link', { name: 'Audit' }),
    ).toBeInTheDocument();
  });

  it('keeps the group names for assistive tech when the rail hides the labels', () => {
    renderNav(true);
    expect(screen.queryByText('Operate')).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Measure' })).getAllByRole('link').length).toBeGreaterThan(
      0,
    );
  });
});
