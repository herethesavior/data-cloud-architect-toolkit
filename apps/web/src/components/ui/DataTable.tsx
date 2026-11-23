import type { ReactNode } from 'react';

export interface DataTableColumn<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  hideBelow?: 'sm' | 'md' | 'lg';
  align?: 'start' | 'end';
  cellClassName?: string;
}

interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  ariaLabel: string;
  emptyMessage?: string;
}

const hiddenClasses: Record<NonNullable<DataTableColumn<unknown>['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
};

export function DataTable<T>({ columns, rows, getRowKey, ariaLabel, emptyMessage = 'No matching records.' }: DataTableProps<T>) {
  if (rows.length === 0) {
    return (
      <div
        role="status"
        className="rounded-lg border border-dashed border-line bg-surface-alt px-5 py-10 text-center text-sm text-ink-soft"
      >
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table aria-label={ariaLabel} className="data-table min-w-[680px]">
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={`relative ${column.align === 'end' ? 'text-right tabular-nums' : 'text-left'} ${column.hideBelow ? hiddenClasses[column.hideBelow] : ''}`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowKey(row)}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`${column.align === 'end' ? 'text-right tabular-nums' : 'text-left'} ${column.hideBelow ? hiddenClasses[column.hideBelow] : ''} ${column.cellClassName ?? ''}`}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
