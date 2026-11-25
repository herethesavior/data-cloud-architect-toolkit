// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DataTable } from './DataTable.tsx';

afterEach(cleanup);

interface Row {
  name: string;
  count: number;
}

const columns = [
  { key: 'name', header: 'Name', render: (row: Row) => row.name },
  { key: 'count', header: 'Count', align: 'end' as const, render: (row: Row) => row.count },
];
const rows: Row[] = [{ name: 'Accounts', count: 12 }];

describe('DataTable', () => {
  it('aligns numeric columns consistently and announces empty results', () => {
    const { rerender } = render(
      <DataTable columns={columns} rows={rows} getRowKey={(row) => row.name} ariaLabel="Rows" />,
    );

    expect(screen.getByRole('columnheader', { name: 'Count' })).toHaveClass('text-right', 'tabular-nums');
    expect(screen.getByRole('cell', { name: '12' })).toHaveClass('text-right', 'tabular-nums');

    rerender(<DataTable columns={columns} rows={[]} getRowKey={(row) => row.name} ariaLabel="Rows" />);

    expect(screen.getByRole('status')).toHaveTextContent('No matching records.');
  });

  it('paginates large tables with working previous and next controls', async () => {
    const manyRows = Array.from({ length: 120 }, (_, index) => ({ name: `Row ${index}`, count: index }));
    render(
      <DataTable
        columns={columns}
        rows={manyRows}
        getRowKey={(row) => row.name}
        ariaLabel="Paged rows"
        pageSize={100}
      />,
    );

    const table = screen.getByRole('table', { name: 'Paged rows' });
    expect(within(table).getAllByRole('row')).toHaveLength(101);
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));

    expect(within(table).getAllByRole('row')).toHaveLength(21);
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(within(table).getAllByRole('row')).toHaveLength(101);
  });

  it('returns to a valid page when filters shrink the result set', async () => {
    const manyRows = Array.from({ length: 120 }, (_, index) => ({ name: `Row ${index}`, count: index }));
    const { rerender } = render(
      <DataTable
        columns={columns}
        rows={manyRows}
        getRowKey={(row) => row.name}
        ariaLabel="Filtered rows"
        pageSize={100}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();

    const fewerRows = manyRows.slice(0, 20);
    rerender(
      <DataTable
        columns={columns}
        rows={fewerRows}
        getRowKey={(row) => row.name}
        ariaLabel="Filtered rows"
        pageSize={100}
      />,
    );

    expect(screen.queryByText(/Page \d+ of \d+/)).not.toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Filtered rows' })).getAllByRole('row')).toHaveLength(21);
  });
});
