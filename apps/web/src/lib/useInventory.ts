import { useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api.ts';
import { persistedQueryOptions } from './queryPersistence.ts';
import type { WorkspaceContext } from './workspace.ts';

/**
 * Every cached snapshot is namespaced by the owning workspace context.
 * Partial snapshots are written to that same key as soon as each batch lands,
 * so every explorer sees progressive rows without a second cache contract.
 */
export function useInventory(context: WorkspaceContext | null) {
  const queryClient = useQueryClient();
  // The query function closes over the context it started with. A context
  // change updates this ref, so a late partial snapshot can never hydrate the
  // wrong workspace even though the old query is still draining.
  const contextRef = useRef(context);
  contextRef.current = context;

  return useQuery({
    queryKey: ['inventory', context?.contextId ?? 'none'],
    queryFn: ({ signal, queryKey }) => {
      if (!context?.alias) throw new Error('Select an org to load its inventory.');
      return api.inventory(context.alias, {
        signal,
        onSnapshot: (snapshot) => {
          if (contextRef.current?.contextId !== context.contextId) return;
          queryClient.setQueryData(queryKey, snapshot);
        },
      });
    },
    enabled: Boolean(context?.alias),
    ...persistedQueryOptions,
  });
}
