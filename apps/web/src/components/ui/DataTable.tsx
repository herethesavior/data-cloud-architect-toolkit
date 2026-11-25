import { useEffect, useState, type ReactNode } from 'react';

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
  /** Opt-in client-side paging for large inventories. */
  pageSize?: number;
}

const hiddenClasses: Record<NonNullable<DataTableColumn<unknown>['hideBelow']>, string> = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
};

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  ariaLabel,
  emptyMessage = 'No matching records.',
  pageSize,
}: DataTableProps<T>) {
  const [page, setPage] = useState(1);
  const totalPages = pageSize ? Math.max(1, Math.ceil(rows.length / pageSize)) : 1;
  // Filtered rows can shrink under the current page; clamp during render so the
  // table never flashes empty before the effect can reset the page state.
  const currentPage = Math.min(page, totalPages);
  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);

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

  const paged = pageSize ? rows.slice((currentPage - 1) * pageSize, currentPage * pageSize) : rows;
  return (
    <>
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
            {paged.map((row) => (
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
      {totalPages > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface-alt px-3 py-2 text-xs text-ink-soft">
          <span role="status" className="tabular-nums">
            Page {currentPage} of {totalPages}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPage((current) => Math.max(1, current - 1))}
              disabled={currentPage <= 1}
              aria-label="Previous page"
              className="min-h-8 rounded-lg border border-line-strong bg-surface px-3 font-semibold transition-colors hover:bg-surface hover:text-ink disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
              disabled={currentPage >= totalPages}
              aria-label="Next page"
              className="min-h-8 rounded-lg border border-line-strong bg-surface px-3 font-semibold text-brand transition-colors hover:bg-brand-soft disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}
