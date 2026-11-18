// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InventorySnapshot } from '@dcat/core';
import { demoInventory, demoOrgs } from '@dcat/test-fixtures';
import { api } from '../lib/api.ts';
import { InventoryActionsProvider } from '../lib/inventoryActions.tsx';
import { createWorkspaceContext } from '../lib/workspace.ts';
import { DataStreamExplorer } from './DataStreamExplorer.tsx';

const context = createWorkspaceContext('live', {
  ...demoOrgs[0]!,
  alias: 'prod-org',
  orgId: '00DXX0000001PROD',
})!;

function renderExplorer(inventory: InventorySnapshot = structuredClone(demoInventory)) {
  vi.spyOn(api, 'inventory').mockResolvedValue(inventory);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <InventoryActionsProvider value={{
        context,
        mode: 'live',
        onGoToOrgs: vi.fn(),
        onToggleMode: vi.fn(),
        isTogglingMode: false,
        refreshInventory: vi.fn(),
        isRefreshingInventory: false,
        refreshError: '',
      }}>
        <DataStreamExplorer context={context} />
      </InventoryActionsProvider>
    </QueryClientProvider>,
  );
}

describe('Data Stream Explorer', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists streams and filters them by search text and status', async () => {
    renderExplorer();
    const table = await screen.findByRole('table', { name: 'Data Stream Explorer results' });

    expect(within(table).getByText('Accounts Stream')).toBeInTheDocument();
    expect(within(table).getByText('Web Events Stream')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search data streams' }), {
      target: { value: 'Web Events' },
    });
    expect(within(table).getByText('Web Events Stream')).toBeInTheDocument();
    expect(within(table).queryByText('Accounts Stream')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search data streams' }), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'Paused' } });
    expect(screen.getByText('1 of 6 streams')).toBeInTheDocument();
    expect(within(table).getByText('Web Events Stream')).toBeInTheDocument();
    expect(within(table).queryByText('Accounts Stream')).not.toBeInTheDocument();
  });

  it('opens the reusable drawer with grounded target and raw metadata tabs', async () => {
    renderExplorer();
    const table = await screen.findByRole('table', { name: 'Data Stream Explorer results' });
    fireEvent.click(within(table).getAllByRole('button', { name: 'Details' })[0]!);

    const dialog = await screen.findByRole('dialog', { name: 'Accounts Stream' });
    expect(within(dialog).getByText('Data Stream Explorer / Accounts Stream')).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: 'Overview' })).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: 'Target DLO' })).toBeInTheDocument();
    expect(within(dialog).getByRole('tab', { name: 'Raw Metadata' })).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Target DLO' }));
    expect(within(dialog).getByText('Known in inventory')).toBeInTheDocument();
    expect(within(dialog).getByText(/No stream lineage is inferred/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('tab', { name: 'Raw Metadata' }));
    expect(within(dialog).getByText(/"apiName": "Accounts_Stream"/)).toBeInTheDocument();
  });

  it('explains a forbidden stream family instead of showing an empty inventory', async () => {
    const inventory = structuredClone(demoInventory);
    inventory.dataStreams = [];
    const capability = inventory.capabilities.find((entry) => entry.family === 'data-streams')!;
    capability.status = 'forbidden';
    capability.message = 'Stream endpoint denied.';

    renderExplorer(inventory);
    expect(await screen.findByText('Access denied to Data Streams')).toBeInTheDocument();
    expect(screen.getAllByText(/Access denied\. Check Data 360 permissions/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('table', { name: 'Data Stream Explorer results' })).not.toBeInTheDocument();
  });
});
