import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, type DataTableColumn } from '../src/components';

interface Row {
  id: string;
  name: string;
  cost: number | null;
}

const ROWS: Row[] = [
  { id: 'b', name: 'bravo', cost: 30 },
  { id: 'a', name: 'Alpha', cost: 5 },
  { id: 'c', name: 'charlie', cost: null },
  { id: 'd', name: 'delta', cost: 120 },
];

const COLUMNS: DataTableColumn<Row>[] = [
  { id: 'name', header: 'Name', primary: true, sortValue: (r) => r.name, cell: (r) => r.name },
  {
    id: 'cost',
    header: 'Cost',
    numeric: true,
    sortValue: (r) => r.cost,
    cell: (r) => (r.cost === null ? '—' : String(r.cost)),
  },
  { id: 'note', header: 'Note', cell: () => 'n/a' },
];

function withRouter(ui: ReactElement) {
  return render(<MemoryRouter>{ui}</MemoryRouter>);
}

function bodyNames(): string[] {
  const table = screen.getByRole('table');
  const rows = within(table).getAllByRole('row').slice(1);
  return rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent ?? '');
}

function header(name: string): HTMLElement {
  return screen.getByRole('columnheader', { name: new RegExp(name) });
}

describe('DataTable', () => {
  it('renders a named table with headers and rows in the given order', () => {
    withRouter(<DataTable caption="Sessions" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    expect(screen.getByRole('table', { name: 'Sessions' })).toBeInTheDocument();
    expect(bodyNames()).toEqual(['bravo', 'Alpha', 'charlie', 'delta']);
    // only sortable headers get a button; no column claims a sort yet
    expect(within(header('Name')).getByRole('button')).toBeInTheDocument();
    expect(within(header('Note')).queryByRole('button')).toBeNull();
    for (const h of screen.getAllByRole('columnheader')) expect(h).not.toHaveAttribute('aria-sort');
  });

  it('sorts by clicking a header and reflects it in aria-sort', async () => {
    const user = userEvent.setup();
    withRouter(<DataTable caption="Sessions" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    await user.click(within(header('Name')).getByRole('button'));
    expect(header('Name')).toHaveAttribute('aria-sort', 'ascending');
    expect(bodyNames()).toEqual(['Alpha', 'bravo', 'charlie', 'delta']);
    await user.click(within(header('Name')).getByRole('button'));
    expect(header('Name')).toHaveAttribute('aria-sort', 'descending');
    expect(bodyNames()).toEqual(['delta', 'charlie', 'bravo', 'Alpha']);
    // the previously sorted column drops aria-sort when another takes over
    await user.click(within(header('Cost')).getByRole('button'));
    expect(header('Name')).not.toHaveAttribute('aria-sort');
  });

  it('starts numeric columns high → low and keeps missing values last in both directions', async () => {
    const user = userEvent.setup();
    withRouter(<DataTable caption="Sessions" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    const sort = within(header('Cost')).getByRole('button');
    await user.click(sort);
    expect(header('Cost')).toHaveAttribute('aria-sort', 'descending');
    expect(bodyNames()).toEqual(['delta', 'bravo', 'Alpha', 'charlie']);
    await user.click(sort);
    expect(header('Cost')).toHaveAttribute('aria-sort', 'ascending');
    expect(bodyNames()).toEqual(['Alpha', 'bravo', 'delta', 'charlie']);
  });

  it('supports controlled and server-side sorting', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    withRouter(
      <DataTable
        caption="Sessions"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        sort={{ columnId: 'name', direction: 'asc' }}
        onSortChange={onSortChange}
        manualSort
      />,
    );
    expect(header('Name')).toHaveAttribute('aria-sort', 'ascending');
    expect(bodyNames()).toEqual(['bravo', 'Alpha', 'charlie', 'delta']); // server order kept
    await user.click(within(header('Name')).getByRole('button'));
    expect(onSortChange).toHaveBeenCalledWith({ columnId: 'name', direction: 'desc' });
  });

  it('offers the same sorts in a labelled select for the phone card layout', async () => {
    const user = userEvent.setup();
    withRouter(<DataTable caption="Sessions" columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    const select = screen.getByLabelText('Sort');
    expect(within(select).getByRole('option', { name: 'Cost (high → low)' })).toBeInTheDocument();
    await user.selectOptions(select, 'name:desc');
    expect(header('Name')).toHaveAttribute('aria-sort', 'descending');
  });

  it('shows the empty state when there are no rows', () => {
    withRouter(<DataTable caption="Rollbacks" columns={COLUMNS} rows={[]} rowKey={(r) => r.id} />);
    expect(screen.getByText('Nothing to show')).toBeInTheDocument();
  });

  it('activates rows by click and keyboard when onRowClick is set', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    withRouter(
      <DataTable
        caption="Sessions"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        onRowClick={onRowClick}
        rowLabel={(r) => `Open ${r.name}`}
      />,
    );
    const row = screen.getByRole('row', { name: 'Open delta' });
    await user.click(within(row).getByText('120'));
    expect(onRowClick).toHaveBeenLastCalledWith(ROWS[3]);
    const alpha = screen.getByRole('row', { name: 'Open Alpha' });
    alpha.focus();
    await user.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenLastCalledWith(ROWS[1]);
    await user.keyboard(' ');
    expect(onRowClick).toHaveBeenCalledTimes(3);
  });

  it('navigates on row click with rowHref and renders a real link in the primary cell', async () => {
    const user = userEvent.setup();
    function Where() {
      return <p data-testid="where">{useLocation().pathname}</p>;
    }
    render(
      <MemoryRouter initialEntries={['/list']}>
        <Routes>
          <Route
            path="/list"
            element={
              <DataTable
                caption="Sessions"
                columns={COLUMNS}
                rows={ROWS}
                rowKey={(r) => r.id}
                rowHref={(r) => `/items/${r.id}`}
              />
            }
          />
          <Route path="/items/:id" element={<Where />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'delta' })).toHaveAttribute('href', '/items/d');
    await user.click(screen.getByText('120'));
    expect(screen.getByTestId('where')).toHaveTextContent('/items/d');
  });

  it('marks the active row and holds rows while busy', () => {
    withRouter(
      <DataTable
        caption="Sessions"
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        activeRowKey="a"
        busy
      />,
    );
    expect(screen.getByRole('table').closest('.aoc-dt')).toHaveAttribute('aria-busy', 'true');
    const active = screen.getAllByRole('row').find((r) => r.getAttribute('aria-current') === 'true');
    expect(active).toHaveTextContent('Alpha');
  });
});
