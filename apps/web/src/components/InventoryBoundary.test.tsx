// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { RESOURCE_FAMILIES } from '@dcat/core';
import type { DiscoveryProgress, InventorySnapshot } from '@dcat/core';
import { demoInventory, demoOrgs } from '@dcat/test-fixtures';
import { api, ApiError } from '../lib/api.ts';
import { InventoryBoundary } from './InventoryBoundary.tsx';
import { InventoryActionsProvider } from '../lib/inventoryActions.tsx';
import type { InventoryActions } from '../lib/inventoryActions.tsx';
import { refreshScopeForPage } from '../lib/refreshScope.ts';
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
        ? state === 'complete' ? 'complete' : state === 'failed' ? 'failed' : 'partial'
        : 'complete',
      loaded: family === 'dlos' ? 2 : 0,
      total: family === 'dlos' ? 100 : 0,
      pagesFetched: 1,
      hasMore: family === 'dlos' && state === 'running',
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

function snapshotWithRelationshipActivity(): InventorySnapshot {
  const snapshot = snapshotFor('running');
  const progress = snapshot.progress!;
  return {
    ...snapshot,
    generatedAt: '2026-01-01T00:00:00.000Z',
    progress: {
      ...progress,
      loaded: progress.loaded + 3,
      families: progress.families.map((family) => family.family === 'dmos'
        ? {
          ...family,
          loaded: 3,
          total: null,
          hasMore: true,
          activity: {
            phase: 'relationship-lookups',
            completed: 120,
            pending: 180,
            failed: 0,
            total: 300,
            startedAt: '2026-01-01T00:05:40.000Z',
          },
        }
        : family),
    },
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

function snapshotWithExpectedTotal(): InventorySnapshot {
  const snapshot = snapshotFor('running');
  return {
    ...snapshot,
    progress: {
      ...snapshot.progress!,
      total: null,
      families: snapshot.progress!.families.map((family) => family.family === 'dlos'
        ? { ...family, total: null, expectedTotal: 100, expectedTotalSource: 'preflight' }
        : family),
    },
  };
}

function renderExplorer(
  snapshot: InventorySnapshot,
  resumeDiscovery = vi.fn(),
  seedCache = false,
  actionOverrides: Partial<InventoryActions> = {},
) {
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
        ...actionOverrides,
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
    expect(screen.getAllByRole('img', { name: /inventory.*loading/i }).length).toBeGreaterThan(0);
  });

  it('explains a static DMO count with its active lookup phase and elapsed time', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T00:10:00.000Z'));
    renderExplorer(snapshotWithRelationshipActivity());

    const banner = await screen.findByTestId('inventory-progress');
    expect(banner).toHaveTextContent('Checking DMO relationships — 120/300 lookups · 4m 20s elapsed');
    expect(screen.getByTestId('inventory-progress-dmos')).toHaveTextContent('3 loaded');
    const freshness = await screen.findByTestId('inventory-freshness');
    expect(freshness).toHaveTextContent('Last batch');
    expect(screen.queryByLabelText('Cached snapshot')).not.toBeInTheDocument();
  });

  it('does not describe a stopped session as actively checking lookups', async () => {
    const snapshot = snapshotWithRelationshipActivity();
    snapshot.progress = { ...snapshot.progress!, state: 'partial' };
    renderExplorer(snapshot);

    const banner = await screen.findByTestId('inventory-progress');
    expect(banner).not.toHaveTextContent('Checking DMO relationships');
    expect(banner).not.toHaveTextContent('Loading inventory in batches');
    expect(screen.queryByRole('img', { name: /inventory.*loading/i })).not.toBeInTheDocument();
  });

  it('uses the authoritative expected count instead of an unknown envelope total', async () => {
    renderExplorer(snapshotWithExpectedTotal());

    const banner = await screen.findByTestId('inventory-progress');
    expect(banner).toHaveTextContent('2 of 100 records loaded');
    expect(screen.getByTestId('inventory-progress-dlos')).toHaveTextContent('2/100');
  });

  it('keeps rows visible and spins the shared indicator during a manual refresh', async () => {
    renderExplorer(snapshotFor('running'), vi.fn(), true, { isRefreshingInventory: true });

    expect(await screen.findByTestId('inventory-freshness')).toBeInTheDocument();
    expect(screen.getAllByText('Account_DLO__dll').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: 'Inventory loading' })).toBeInTheDocument();
    expect(screen.queryByTestId('inventory-refresh-skeleton')).not.toBeInTheDocument();
  });

  it('explains which families the page-level refresh updates', async () => {
    renderExplorer(snapshotFor('complete'), vi.fn(), true, { refreshScope: refreshScopeForPage('dlos') });

    const button = await screen.findByRole('button', { name: 'Refresh inventory' });
    expect(button).toHaveAttribute('title', expect.stringContaining('DLOs, mappings, and data streams'));
    expect(button.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(button.getAttribute('aria-describedby')!))
      .toHaveTextContent('Refresh updates DLOs, mappings, and data streams.');
  });

  it('names the refreshed families in the first-load refresh skeleton', () => {
    const query = {
      data: undefined,
      isPending: false,
      isFetching: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as UseQueryResult<InventorySnapshot, Error>;

    render(
      <InventoryActionsProvider value={{
        context,
        mode: 'live',
        orgList: { status: 'idle' },
        onGoToOrgs: vi.fn(),
        onToggleMode: vi.fn(),
        isTogglingMode: false,
        refreshInventory: vi.fn(),
        refreshScope: refreshScopeForPage('data-streams'),
        cancelRefresh: vi.fn(),
        isRefreshingInventory: true,
        refreshError: '',
      }}>
        <InventoryBoundary query={query} context={context}>
          {() => <div>Loaded rows</div>}
        </InventoryBoundary>
      </InventoryActionsProvider>,
    );

    expect(screen.getByTestId('inventory-refresh-skeleton'))
      .toHaveTextContent('Updating data streams and DLOs...');
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

    expect(await screen.findByTestId('inventory-progress')).toHaveTextContent('Some inventory families stopped loading');
    expect(screen.getAllByText('Account_DLO__dll').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /Resume loading/ }));
    expect(resumeDiscovery).toHaveBeenCalledTimes(1);
  });

  it('offers resume when a complete snapshot was stopped by a deadline', async () => {
    const snapshot = snapshotFor('complete');
    snapshot.warnings = [{
      family: 'dlos',
      code: 'DISCOVERY_DEADLINE',
      message: 'Discovery stopped after 480 second(s); earlier results were kept.',
      severity: 'warning',
    }];
    const resumeDiscovery = renderExplorer(snapshot);

    expect(await screen.findByTestId('inventory-progress')).toHaveTextContent('Some inventory families stopped loading');
    expect(screen.getAllByText('Account_DLO__dll').length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: /Resume loading/ }));
    expect(resumeDiscovery).toHaveBeenCalledTimes(1);
  });

  it('does not present a settled partial snapshot as loading or complete', async () => {
    const snapshot = snapshotFor('partial');
    snapshot.progress = {
      ...snapshot.progress!,
      families: snapshot.progress!.families.map((family) => ({
        ...family,
        status: 'complete',
        hasMore: false,
      })),
    };
    renderExplorer(snapshot);

    const banner = await screen.findByTestId('inventory-progress');
    expect(banner).toHaveTextContent('Inventory loaded with gaps');
    expect(banner).not.toHaveTextContent('Loading inventory in batches');
    expect(banner).not.toHaveTextContent('Inventory complete');
  });

  it('renders a persisted snapshot immediately and marks an old live snapshot stale', () => {
    renderExplorer(snapshotFor('complete'), vi.fn(), true);

    expect(screen.getByTestId('inventory-freshness')).toHaveTextContent(/^Updated /);
    expect(screen.getByLabelText('Cached snapshot')).toBeInTheDocument();
    expect(screen.queryByTestId('inventory-refresh-skeleton')).not.toBeInTheDocument();
    expect(api.inventory).not.toHaveBeenCalled();
  });

  it('surfaces a failed resume with a retry action', async () => {
    const resumeDiscovery = vi.fn();
    renderExplorer(snapshotFor('failed'), resumeDiscovery, true, {
      resumeError: 'The local bridge is offline.',
    });

    const alert = screen.getAllByRole('alert').find((element) => element.textContent?.includes('Resume failed:'));
    expect(alert).toHaveTextContent('Resume failed: The local bridge is offline.');
    await userEvent.click(within(alert!).getByRole('button', { name: 'Retry' }));
    expect(resumeDiscovery).toHaveBeenCalledTimes(1);
  });

  it('resumes a timed-out partial load and clears the stale error banner', async () => {
    const refetch = vi.fn();
    const resumeDiscovery = vi.fn();
    const error = new ApiError('RELAY_TIMEOUT', 'The bridge did not answer in time.');
    const query = {
      data: snapshotFor('running'),
      isPending: false,
      isFetching: false,
      isError: true,
      error,
      refetch,
    } as unknown as UseQueryResult<InventorySnapshot, Error>;
    const boundary = (isResumingDiscovery: boolean) => (
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
        isResumingDiscovery,
      }}>
        <InventoryBoundary query={query} context={context}>
          {() => <div>Loaded rows</div>}
        </InventoryBoundary>
      </InventoryActionsProvider>
    );

    const view = render(boundary(false));

    expect(screen.getByRole('alert')).toHaveTextContent("Loading stopped: The bridge didn't respond in time.");
    expect(screen.queryByRole('img', { name: 'Inventory loading' })).not.toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Inventory still loading' })).not.toBeInTheDocument();
    expect(screen.getByText('Loaded rows')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume loading' }));
    expect(resumeDiscovery).toHaveBeenCalledTimes(1);
    expect(refetch).not.toHaveBeenCalled();

    view.rerender(boundary(true));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Inventory still loading' })).toBeInTheDocument();
  });

  it('clears a first-load timeout screen as soon as resume starts', async () => {
    const refetch = vi.fn();
    const resumeDiscovery = vi.fn();
    const query = {
      data: null,
      isPending: false,
      isFetching: false,
      isError: true,
      error: new ApiError('RELAY_TIMEOUT', 'The bridge did not answer in time.'),
      refetch,
    } as unknown as UseQueryResult<InventorySnapshot, Error>;
    const boundary = (isResumingDiscovery: boolean) => (
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
        isResumingDiscovery,
      }}>
        <InventoryBoundary query={query} context={context}>
          {() => <div>Loaded rows</div>}
        </InventoryBoundary>
      </InventoryActionsProvider>
    );

    const view = render(boundary(false));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load the inventory");
    expect(alert).toHaveTextContent("The bridge didn't respond in time.");
    await userEvent.click(within(alert).getByRole('button', { name: 'Resume loading' }));
    expect(resumeDiscovery).toHaveBeenCalledTimes(1);
    expect(refetch).not.toHaveBeenCalled();

    view.rerender(boundary(true));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Discovering your Data 360 inventory')).toBeInTheDocument();
  });

  it('offers a working continue action for an oversized partial load', async () => {
    const refetch = vi.fn();
    const continueInventory = vi.fn();
    const query = {
      data: snapshotFor('running'),
      isPending: false,
      isFetching: false,
      isError: true,
      error: new ApiError('RESPONSE_TOO_LARGE', 'The bridge result is too large to relay.'),
      refetch,
    } as unknown as UseQueryResult<InventorySnapshot, Error>;

    render(
      <InventoryActionsProvider value={{
        context,
        mode: 'live',
        orgList: { status: 'idle' },
        onGoToOrgs: vi.fn(),
        onToggleMode: vi.fn(),
        isTogglingMode: false,
        refreshInventory: vi.fn(),
        continueInventory,
        cancelRefresh: vi.fn(),
        isRefreshingInventory: false,
        refreshError: '',
      }}>
        <InventoryBoundary query={query} context={context}>
          {() => <div>Loaded rows</div>}
        </InventoryBoundary>
      </InventoryActionsProvider>,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Loading stopped: That metadata is too large to display in one view.');
    const button = within(alert).getByRole('button', { name: 'Continue loading' });
    expect(button).not.toBeDisabled();
    await userEvent.click(button);
    expect(continueInventory).toHaveBeenCalledTimes(1);
    expect(refetch).not.toHaveBeenCalled();
  });
});
