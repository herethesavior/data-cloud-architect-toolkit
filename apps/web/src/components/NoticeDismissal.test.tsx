// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UseQueryResult } from '@tanstack/react-query';
import type { InventorySnapshot } from '@dcat/core';
import { demoInventory, demoOrgs } from '@dcat/test-fixtures';
import { InventoryActionsProvider } from '../lib/inventoryActions.tsx';
import { markExport, resetNoticeDismissals } from '../lib/noticeDismissal.ts';
import { createWorkspaceContext } from '../lib/workspace.ts';
import { ExportNotice } from './ExportNotice.tsx';
import { InventoryBoundary } from './InventoryBoundary.tsx';
import { ResourceStatusNotice } from './ResourceStatusPanel.tsx';

function partialInventory(families: number): InventorySnapshot {
  const inventory = structuredClone(demoInventory);
  return {
    ...inventory,
    capabilities: inventory.capabilities.map((capability, index) =>
      index < families ? { ...capability, status: 'partial' as const } : capability),
  };
}

describe('dismissible notices', () => {
  beforeEach(() => resetNoticeDismissals());

  afterEach(() => {
    cleanup();
    document.getElementById('main-content')?.remove();
    vi.restoreAllMocks();
  });

  it('hides the export notice until the next export, even when the status text repeats', async () => {
    render(<>
      <ExportNotice mode="live" />
      <button type="button" onClick={markExport}>Export again</button>
    </>);
    expect(screen.getByRole('note')).toHaveTextContent('Store and share it');

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss export notice' }));
    expect(screen.queryByRole('note')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Export again' }));
    expect(screen.getByRole('note')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss export notice' }));
    await userEvent.click(screen.getByRole('button', { name: 'Export again' }));
    expect(screen.getByRole('note')).toBeInTheDocument();
  });

  it('hides the inventory gap notice until the reported families change', async () => {
    const { rerender } = render(<ResourceStatusNotice inventory={partialInventory(1)} />);
    expect(screen.getByText('Inventory loaded with gaps')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss inventory status notice' }));
    expect(screen.queryByText('Inventory loaded with gaps')).not.toBeInTheDocument();

    rerender(<ResourceStatusNotice inventory={partialInventory(2)} />);
    expect(screen.getByText('Inventory loaded with gaps')).toBeInTheDocument();
  });

  it('dismisses duplicate copies of the same notice together', async () => {
    const inventory = partialInventory(1);
    render(<>
      <ResourceStatusNotice inventory={inventory} />
      <ResourceStatusNotice inventory={inventory} />
    </>);
    expect(screen.getAllByText('Inventory loaded with gaps')).toHaveLength(2);

    await userEvent.click(screen.getAllByRole('button', { name: 'Dismiss inventory status notice' })[0]!);
    expect(screen.queryAllByText('Inventory loaded with gaps')).toHaveLength(0);
  });

  it('hides a refresh failure until the error clears and appears again', async () => {
    const context = createWorkspaceContext('live', demoOrgs[0]!)!;
    const query = {
      data: demoInventory,
      isPending: false,
      isFetching: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as UseQueryResult<InventorySnapshot, Error>;

    const renderBoundary = (refreshError: string) => render(
      <InventoryActionsProvider value={{
        context,
        mode: 'live',
        orgList: { status: 'idle' },
        onGoToOrgs: vi.fn(),
        onToggleMode: vi.fn(),
        isTogglingMode: false,
        refreshInventory: vi.fn(),
        cancelRefresh: vi.fn(),
        isRefreshingInventory: false,
        refreshError,
      }}>
        <InventoryBoundary query={query} context={context}>
          {() => <div>Loaded rows</div>}
        </InventoryBoundary>
      </InventoryActionsProvider>,
    );

    const { rerender } = renderBoundary('Bridge timed out');
    expect(screen.getByRole('alert')).toHaveTextContent('Refresh failed: Bridge timed out');

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss refresh error' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    rerender(<InventoryActionsProvider value={{
      context,
      mode: 'live',
      orgList: { status: 'idle' },
      onGoToOrgs: vi.fn(),
      onToggleMode: vi.fn(),
      isTogglingMode: false,
      refreshInventory: vi.fn(),
      cancelRefresh: vi.fn(),
      isRefreshingInventory: false,
      refreshError: '',
    }}>
      <InventoryBoundary query={query} context={context}>
        {() => <div>Loaded rows</div>}
      </InventoryBoundary>
    </InventoryActionsProvider>);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();

    renderBoundary('Bridge timed out');
    expect(screen.getByRole('alert')).toHaveTextContent('Refresh failed: Bridge timed out');
  });

  it('moves focus to the main landmark when a notice is dismissed', async () => {
    document.body.insertAdjacentHTML('beforeend', '<main id="main-content" tabindex="-1"></main>');
    render(<ExportNotice mode="live" />);
    const close = screen.getByRole('button', { name: 'Dismiss export notice' });
    close.focus();

    await userEvent.click(close);

    expect(document.getElementById('main-content')).toHaveFocus();
  });
});
