import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import type { WorkspaceContext } from './workspace.ts';

/**
 * Lazy, read-only transform detail. The query key includes the workspace id so
 * no detail, run history, or schedule can leak across orgs or Demo/Live modes.
 */
export function useTransformBundle(context: WorkspaceContext | null, id: string | null) {
  return useQuery({
    queryKey: ['transforms', context?.contextId ?? 'none', 'bundle', id ?? 'none'],
    queryFn: ({ signal }) => api.transformBundle(context!.alias!, id!, { signal }),
    enabled: Boolean(context?.alias && id),
    staleTime: 60_000,
  });
}
