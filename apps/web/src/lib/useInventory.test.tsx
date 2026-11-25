// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RESOURCE_FAMILIES, type InventorySnapshot } from '@dcat/core';
import { demoInventory, demoOrgs } from '@dcat/test-fixtures';
import { api } from './api.ts';
import { createWorkspaceContext } from './workspace.ts';
import { useInventory } from './useInventory.ts';

const context = createWorkspaceContext('live', demoOrgs[0]!)!;

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function wrapperWith(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function runningSnapshot(): InventorySnapshot {
  return {
    ...structuredClone(demoInventory),
    progress: {
      sessionId: 'session-1',
      generation: 'generation-1',
      state: 'running',
      loaded: 1,
      total: null,
      families: RESOURCE_FAMILIES.map((family) => ({
        family,
        status: 'not-started',
        loaded: 0,
        total: null,
        pagesFetched: 0,
        hasMore: true,
        error: null,
      })),
      message: null,
    },
  };
}

describe('useInventory', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not restart a failed discovery behind the user\'s back', async () => {
    const inventory = vi.spyOn(api, 'inventory').mockRejectedValue(new Error('The local bridge is offline.'));
    const { result } = renderHook(() => useInventory(context), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(inventory).toHaveBeenCalledTimes(1);
  });

  it('keeps a cached failed snapshot visible without restarting it on mount', async () => {
    const failed = {
      ...runningSnapshot(),
      progress: { ...runningSnapshot().progress!, state: 'failed' as const },
    };
    const inventory = vi.spyOn(api, 'inventory').mockResolvedValue(failed);
    const client = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
    client.setQueryData(['inventory', context.contextId], failed);

    const { result } = renderHook(() => useInventory(context), { wrapper: wrapperWith(client) });

    expect(result.current.data).toBeDefined();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(inventory).not.toHaveBeenCalled();
  });

  it('revalidates an incomplete cached snapshot while keeping its rows visible', async () => {
    const inventory = vi.spyOn(api, 'inventory').mockResolvedValue(runningSnapshot());
    const client = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
    client.setQueryData(['inventory', context.contextId], runningSnapshot());

    const { result } = renderHook(() => useInventory(context), { wrapper: wrapperWith(client) });

    expect(result.current.data).toBeDefined();
    await waitFor(() => expect(inventory).toHaveBeenCalledTimes(1));
  });
});
