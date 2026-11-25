// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { demoOrgs } from '@dcat/test-fixtures';
import { api } from './api.ts';
import { createWorkspaceContext } from './workspace.ts';
import { useInventory } from './useInventory.ts';

const context = createWorkspaceContext('live', demoOrgs[0]!)!;

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
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
});
