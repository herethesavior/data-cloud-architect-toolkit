// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RESOURCE_FAMILIES } from '@dcat/core';
import type { DiscoveryProgress, InventorySnapshot } from '@dcat/core';
import { demoInventory, demoOrgs } from '@dcat/test-fixtures';
import { api } from '../lib/api.ts';
import { InventoryActionsProvider } from '../lib/inventoryActions.tsx';
import { createWorkspaceContext } from '../lib/workspace.ts';
import { DloExplorer } from './ObjectExplorer.tsx';

const org = {
  ...demoOrgs[0]!,
  alias: 'prod-org',
  orgId: '00DXX0000001PROD',
};
const context = createWorkspaceContext('live', org)!;

function progressFor(state: DiscoveryProgress['state']): DiscoveryProgress {
  return {
    sessionId: 'session-1',
    generation: 'generation-1',
    state,
    loaded: 2,
    total: 100,
    families: RESOURCE_FAMILIES.map((family) => ({
      family,
      status: family === 'dlos'
        ? state === 'failed' ? 'failed' : 'partial'
        : 'complete',
      loaded: family === 'dlos' ? 2 : 0,
      total: family === 'dlos' ? 100 : 0,
      pagesFetched: 1,
      hasMore: family === 'dlos' && state !== 'failed',
      error: family === 'dlos' && state === 'failed' ? 'A page failed after three attempts.' : null,
    })),
    message: state === 'failed' ? 'Some families stopped after a page failure.' : 'Loading metadata in small batches.',
  };
}

function snapshotFor(state: DiscoveryProgress['state']): InventorySnapshot {
  const inventory = structuredClone(demoInventory);
  return {
    ...inventory,
    org,
    mode: 'live',
    dlos: inventory.dlos.slice(0, 2),
    capabilities: inventory.capabilities.map((capability) => capability.family === 'dlos'
      ? { ...capability, status: 'partial', itemCount: 2 }
      : capability),
    progress: progressFor(state),
  };
}

function snapshotWithExhaustedTotal(): InventorySnapshot {
  const snapshot = snapshotFor('running');
  const progress = snapshot.progress!;
  return {
    ...snapshot,
    progress: {
      ...progress,
      total: 2,
      families: progress.families.map((family) => family.family === 'dlos'
        ? { ...family, total: 2 }
        : family),
    },
  };
}

function renderExplorer(snapshot: InventorySnapshot, resumeDiscovery = vi.fn(), seedCache = false) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seedCache) queryClient.setQueryData(['inventory', context.contextId], snapshot);
  vi.spyOn(api, 'inventory').mockResolvedValue(snapshot);
  render(
    <QueryClientProvider client={queryClient}>
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
        refreshError: '',
        resumeDiscovery,
        isResumingDiscovery: false,
      }}>
        <DloExplorer context={context} />
      </InventoryActionsProvider>
    </QueryClientProvider>,
  );
  return resumeDiscovery;
}

describe('InventoryBoundary progressive state', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows exact progress while keeping already-loaded rows visible', async () => {
    renderExplorer(snapshotFor('running'));

    const banner = await screen.findByTestId('inventory-progress');
    expect(banner).toHaveTextContent('2 of 100 records loaded');
    expect(screen.getByTestId('inventory-progress-dlos')).toHaveTextContent('2/100');
    expect(screen.getAllByText('Account_DLO__dll').length).toBeGreaterThan(0);
    expect(screen.queryByTestId('inventory-refresh-skeleton')).not.toBeInTheDocument();
  });

  it('does not show an exhausted page total as complete while discovery continues', async () => {
    renderExplorer(snapshotWithExhaustedTotal());

    const banner = await screen.findByTestId('inventory-progress');
    expect(banner).toHaveTextContent('2 records loaded so far');
    expect(banner).not.toHaveTextContent('2 of 2 records loaded');
    expect(screen.getByTestId('inventory-progress-dlos')).toHaveTextContent('2 loaded');
    expect(screen.getByTestId('inventory-progress-dlos')).not.toHaveTextContent('2/2');
  });

  it('offers resume on a failed family without hiding earlier rows', async () => {
    const resumeDiscovery = renderExplorer(snapshotFor('failed'));

    expect(await screen.findByTestId('inventory-progress')).toHaveTextContent('Some collections stopped loading');
    expect(screen.getAllByText('Account_DLO__dll').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /Resume loading/ }));
    expect(resumeDiscovery).toHaveBeenCalledTimes(1);
  });

  it('renders a persisted snapshot immediately and marks an old live snapshot stale', () => {
    renderExplorer(snapshotFor('complete'), vi.fn(), true);

    expect(screen.getByTestId('inventory-freshness')).toHaveTextContent(/^Updated /);
    expect(screen.getByLabelText('Cached snapshot')).toBeInTheDocument();
    expect(screen.queryByTestId('inventory-refresh-skeleton')).not.toBeInTheDocument();
    expect(api.inventory).not.toHaveBeenCalled();
  });
});
