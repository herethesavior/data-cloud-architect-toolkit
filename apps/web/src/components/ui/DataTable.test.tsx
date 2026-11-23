// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
});
