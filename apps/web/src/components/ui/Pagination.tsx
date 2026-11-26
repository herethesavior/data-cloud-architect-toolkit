import { useEffect, useState } from 'react';

/**
 * Client-side paging shared by tables and card lists. The page is clamped while
 * rendering so a filter that shrinks the result set never flashes an empty page.
 */
export function usePagination(itemCount: number, pageSize?: number) {
  const [page, setPage] = useState(1);
  const totalPages = pageSize && pageSize > 0
    ? Math.max(1, Math.ceil(itemCount / pageSize))
    : 1;
  const currentPage = Math.min(page, totalPages);

  useEffect(() => {
    if (page !== currentPage) setPage(currentPage);
  }, [page, currentPage]);

  return {
    page: currentPage,
    totalPages,
    goPrevious: () => setPage((current) => Math.max(1, current - 1)),
    goNext: () => setPage((current) => Math.min(totalPages, current + 1)),
  };
}

export function paginate<T>(rows: readonly T[], page: number, pageSize?: number): T[] {
  if (!pageSize || pageSize <= 0) return [...rows];
  return rows.slice((page - 1) * pageSize, page * pageSize);
}

export function PaginationControls({
  page,
  totalPages,
  goPrevious,
  goNext,
}: {
  page: number;
  totalPages: number;
  goPrevious: () => void;
  goNext: () => void;
}) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line bg-surface-alt px-3 py-2 text-xs text-ink-soft">
      <span role="status" className="tabular-nums">
        Page {page} of {totalPages}
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={goPrevious}
          disabled={page <= 1}
          aria-label="Previous page"
          className="min-h-8 rounded-lg border border-line-strong bg-surface px-3 font-semibold transition-colors hover:bg-surface hover:text-ink disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          onClick={goNext}
          disabled={page >= totalPages}
          aria-label="Next page"
          className="min-h-8 rounded-lg border border-line-strong bg-surface px-3 font-semibold text-brand transition-colors hover:bg-brand-soft disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  );
}
