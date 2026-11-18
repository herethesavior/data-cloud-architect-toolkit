// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { InventorySnapshot } from '@dcat/core';
import { demoInventory, demoOrgs } from '@dcat/test-fixtures';
import { InventoryActionsProvider } from '../lib/inventoryActions.tsx';
import { api } from '../lib/api.ts';
import { createWorkspaceContext } from '../lib/workspace.ts';
import { Dashboard } from './Dashboard.tsx';

const org = {
  ...demoOrgs[0]!,
  alias: 'prod-org',
  orgId: '00DXX0000001PROD',
};
const context = createWorkspaceContext('live', org)!;

function disabledInventory(): InventorySnapshot {
  const message = 'Data 360 is not enabled for this user or org. FUNCTIONALITY_NOT_ENABLED.';
  return {
    ...structuredClone(demoInventory),
    org,
    mode: 'live',
    capabilities: demoInventory.capabilities.map((capability) => ({
      ...capability,
      status: 'unsupported' as const,
      message,
    })),
    warnings: demoInventory.capabilities.map((capability) => ({
      family: capability.family,
      code: 'UNSUPPORTED',
      message,
      severity: 'warning' as const,
    })),
  };
}

describe('Dashboard discovery health', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('explains an org where Data 360 is disabled without offering a retry', async () => {
    vi.spyOn(api, 'inventory').mockResolvedValue(disabledInventory());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

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
        }}>
          <Dashboard context={context} mode="live" onNavigate={vi.fn()} />
        </InventoryActionsProvider>
      </QueryClientProvider>,
    );

    expect((await screen.findAllByText(/Data 360 is not enabled for this user or org/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Not enabled · 0%/)).toBeInTheDocument();
    expect(screen.queryByText('Inventory loaded with gaps')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
    expect(screen.getByText(/no retry is needed/)).toBeInTheDocument();
  });

  it('shows an org-check skeleton instead of the idle no-org state while discovery is running', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <InventoryActionsProvider value={{
          context: null,
          mode: 'live',
          orgList: { status: 'checking' },
          onGoToOrgs: vi.fn(),
          onToggleMode: vi.fn(),
          isTogglingMode: false,
          refreshInventory: vi.fn(),
          cancelRefresh: vi.fn(),
          isRefreshingInventory: false,
          refreshError: '',
        }}>
          <Dashboard context={null} mode="live" onNavigate={vi.fn()} />
        </InventoryActionsProvider>
      </QueryClientProvider>,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Checking for Salesforce orgs…');
    expect(screen.getByRole('button', { name: 'Use demo mode' })).toBeInTheDocument();
    expect(screen.queryByText('No org selected')).not.toBeInTheDocument();
  });
});
