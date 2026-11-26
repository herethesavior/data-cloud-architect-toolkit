// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaginatedList } from './PaginatedList.tsx';

afterEach(cleanup);

const items = Array.from({ length: 120 }, (_, index) => `Item ${index}`);

function renderList(values: string[]) {
  return render(
    <PaginatedList
      items={values}
      pageSize={50}
      getKey={(value) => value}
      container={(children) => <ul aria-label="Records">{children}</ul>}
      render={(value) => <li>{value}</li>}
      emptyMessage="No records to show."
    />,
  );
}

describe('PaginatedList', () => {
  it('pages repeated cards with the same controls as tables', async () => {
    renderList(items);

    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Item 50')).toBeInTheDocument();
    expect(screen.getByText('Page 2 of 3')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(20);
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('returns to a valid page when the result set shrinks and keeps empty state semantics', async () => {
    const { rerender, unmount } = renderList(items);
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(screen.getByText('Page 3 of 3')).toBeInTheDocument();

    rerender(
      <PaginatedList
        items={items.slice(0, 10)}
        pageSize={50}
        getKey={(value) => value}
        container={(children) => <ul aria-label="Records">{children}</ul>}
        render={(value) => <li>{value}</li>}
        emptyMessage="No records to show."
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(10);
    expect(screen.queryByText(/Page \d+ of \d+/)).not.toBeInTheDocument();

    unmount();
    renderList([]);
    expect(screen.getByRole('status')).toHaveTextContent('No records to show.');
  });
});
