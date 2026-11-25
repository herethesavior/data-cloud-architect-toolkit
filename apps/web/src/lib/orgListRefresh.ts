import type { QueryClient } from '@tanstack/react-query';
import type { OrgSummary } from '@dcat/core';
import { api } from './api.ts';
import { orgsQueryOptions } from './queryPersistence.ts';
import { invalidateWorkspaceState, orgsQueryKey } from './workspace.ts';
import type { WorkspaceMode } from './workspace.ts';

/**
 * Seed an empty list for immediate skeleton rendering, then fetch the real one
 * with an explicit queryFn. The new mode has no mounted observer yet, so a plain
 * `refetchQueries` would create a `Missing queryFn` error that can paint before
 * the observer attaches.
 */
export function refreshModeOrgList(
  queryClient: QueryClient,
  mode: WorkspaceMode,
  hosted: boolean,
  signal?: AbortSignal,
): Promise<OrgSummary[]> {
  queryClient.setQueryData<OrgSummary[]>(orgsQueryKey(mode), []);
  invalidateWorkspaceState(queryClient);
  return queryClient.fetchQuery({
    queryKey: orgsQueryKey(mode),
    queryFn: () => api.orgs({ signal }),
    ...orgsQueryOptions(hosted),
  });
}
