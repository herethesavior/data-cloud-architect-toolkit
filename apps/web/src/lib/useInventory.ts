import { useQuery } from '@tanstack/react-query';
import { api } from './api.ts';
import type { WorkspaceContext } from './workspace.ts';

/** Every cached snapshot is namespaced by the owning workspace context. */
export function useInventory(context: WorkspaceContext | null) {
  return useQuery({
    queryKey: ['inventory', context?.contextId ?? 'none'],
    queryFn: ({ signal }) => {
      if (!context?.alias) throw new Error('Select an org to load its inventory.');
      return api.inventory(context.alias, { signal });
    },
    enabled: Boolean(context?.alias),
  });
}
