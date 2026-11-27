// @vitest-environment jsdom
import type { PropsWithChildren } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
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

  it('stays pending without an inventory seed', () => {
    vi.mocked(api.transformBundle).mockReturnValue(new Promise(() => undefined));

    const { result } = renderHook(
      () => useTransformBundle(context, transform.apiName, null, '67.0'),
      { wrapper },
    );

    expect(result.current.isPending).toBe(true);
    expect(result.current.isPlaceholderData).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it('reports an error instead of presenting the placeholder as loaded detail', async () => {
    vi.mocked(api.transformBundle).mockRejectedValue(new Error('connector offline'));

    const { result } = renderHook(
      () => useTransformBundle(context, transform.apiName, transform, '67.0'),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ message: 'connector offline' });
  });

  it('uses a fresh key when the resolved API version changes', () => {
    vi.mocked(api.transformBundle).mockReturnValue(new Promise(() => undefined));
    const props = {
      context,
      id: transform.apiName,
      seed: transform,
      apiVersion: '67.0',
    };

    const { rerender } = renderHook(
      (value: typeof props) => useTransformBundle(value.context, value.id, value.seed, value.apiVersion),
      { wrapper, initialProps: props },
    );
    rerender({ ...props, apiVersion: '68.0' });

    const keys = queryClient.getQueryCache().findAll({ queryKey: ['transforms'] })
      .map((query) => query.queryKey);
    expect(keys.some((key) => key.includes('67.0'))).toBe(true);
    expect(keys.some((key) => key.includes('68.0'))).toBe(true);
    expect(api.transformBundle).toHaveBeenLastCalledWith(
      context.alias,
      transform.apiName,
      expect.objectContaining({ apiVersion: '68.0' }),
    );
  });
});
