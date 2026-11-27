import { useQuery } from '@tanstack/react-query';
import type { DataTransform, TransformBundle } from '@dcat/core';
import { api } from './api.ts';
import type { WorkspaceContext } from './workspace.ts';

/** Show the inventory row immediately while the live bundle is still loading. */
export function seedTransformBundle(seed: DataTransform): TransformBundle {
  const loading = 'Showing the inventory summary while live detail loads.';
  return {
    transform: seed,
    runs: [],
    schedule: null,
    sections: { detail: 'not-started', runHistory: 'not-started', schedule: 'not-started' },
    messages: { detail: loading, runHistory: loading, schedule: loading },
  };
}

/**
 * Lazy, read-only transform detail. The query key includes the workspace id and
 * resolved API version so no detail, run history, or schedule can leak across
 * orgs, Demo/Live modes, or compatibility settings.
 */
export function useTransformBundle(
  context: WorkspaceContext | null,
  id: string | null,
  seed?: DataTransform | null,
  apiVersion?: string | null,
) {
  const placeholder = seed ? seedTransformBundle(seed) : undefined;
  return useQuery({
    queryKey: ['transforms', context?.contextId ?? 'none', apiVersion ?? 'none', 'bundle', id ?? 'none'],
    queryFn: ({ signal }) => api.transformBundle(context!.alias!, id!, { signal, apiVersion }),
    enabled: Boolean(context?.alias && id),
    staleTime: 60_000,
    placeholderData: placeholder,
  });
}
