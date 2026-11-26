import { Fragment, type ReactElement, type ReactNode } from 'react';
import { PaginationControls, paginate, usePagination } from './Pagination.tsx';

interface PaginatedListProps<T> {
  items: readonly T[];
  pageSize: number;
  getKey: (item: T, index: number) => string;
  render: (item: T) => ReactElement;
  /** Keeps list semantics (`ul`, `ol`, or a styled wrapper) around the page. */
  container?: (children: ReactNode) => ReactElement;
  emptyMessage?: string;
}

/**
 * Paging for card and row lists that cannot use a table. It renders the same
 * controls as DataTable and leaves the caller's markup untouched.
 */
export function PaginatedList<T>({
  items,
  pageSize,
  getKey,
  render,
  container,
  emptyMessage = 'No matching records.',
}: PaginatedListProps<T>) {
  const { page, totalPages, goPrevious, goNext } = usePagination(items.length, pageSize);

  if (items.length === 0) {
    return (
      <div
        role="status"
        className="rounded-lg border border-dashed border-line bg-surface-alt px-5 py-10 text-center text-sm text-ink-soft"
      >
        {emptyMessage}
      </div>
    );
  }

  const pagedItems = paginate(items, page, pageSize).map((item, index) => (
    <Fragment key={getKey(item, index)}>{render(item)}</Fragment>
  ));

  return (
    <>
      {container ? container(pagedItems) : pagedItems}
      <PaginationControls
        page={page}
        totalPages={totalPages}
        goPrevious={goPrevious}
        goNext={goNext}
      />
    </>
  );
}
