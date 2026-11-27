// @vitest-environment jsdom
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { demoInventory, demoOrgs } from '@dcat/test-fixtures';
import { api } from './api.ts';
import { createWorkspaceContext } from './workspace.ts';
import { useTransformBundle } from './useTransforms.ts';

vi.mock('./api.ts', () => ({ api: { transformBundle: vi.fn() } }));

const context = createWorkspaceContext('live', demoOrgs[0]!)!;
const transform = demoInventory.dataTransforms[0]!;
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function wrapper({ children }: PropsWithChildren) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useTransformBundle', () => {
  afterEach(() => {
    cleanup();
    queryClient.clear();
    vi.clearAllMocks();
  });

  it('shows the inventory transform immediately while live detail is pending', () => {
    vi.mocked(api.transformBundle).mockReturnValue(new Promise(() => undefined));

    const { result } = renderHook(
      () => useTransformBundle(context, transform.apiName, transform, '67.0'),
      { wrapper },
    );

    expect(result.current.isPlaceholderData).toBe(true);
    expect(result.current.data?.transform).toBe(transform);
    expect(api.transformBundle).toHaveBeenCalledWith(
      context.alias,
      transform.apiName,
      expect.objectContaining({ apiVersion: '67.0' }),
    );
  });
});
